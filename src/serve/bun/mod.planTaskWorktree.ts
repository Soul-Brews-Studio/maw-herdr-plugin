import {lstatSync,realpathSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {BackendError} from './types.ts';
import {runHerdr} from './mod.runHerdr.ts';

export function taskSlug(raw: string): string {
  if(Buffer.byteLength(raw)>1024 || raw.startsWith('-') || raw.includes('\0')) throw new BackendError('backend_error','invalid task');
  let slug=raw.replace(/[A-Z]/g,c=>c.toLowerCase()).replace(/[\t\n\v\f\r ]+/g,'-').replace(/[^a-z0-9._-]/g,'');
  while(slug.includes('..'))slug=slug.replace(/\.\./g,'.');
  slug=slug.replace(/^[-.]+|[-.]+$/g,'').slice(0,50);
  if(!slug)throw new BackendError('backend_error','invalid task');
  return slug;
}

/** Plan only. The returned create operation runs after pane-label conflicts are checked. */
export async function planTaskWorktree(repo: string, rawTask: string, signal: AbortSignal) {
  const slug=taskSlug(rawTask);
  const fail=(): never=>{throw new BackendError('backend_error','task worktree unavailable');};
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'});
  const git=(cwd:string,args:string[])=>runHerdr('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',cwd,...args],signal,env);
  const root=realpathSync(repo);
  if(root!==repo || (await git(root,['rev-parse','--show-toplevel'])).trim()!==root)fail();
  const common=realpathSync(resolve(root,(await git(root,['rev-parse','--git-common-dir'])).trim()));
  const agents=join(root,'agents');
  const safePath=(path:string,missing=false)=>{
    if(!isAbsolute(path) || /[\x00-\x1f\x7f-\x9f]/.test(path))fail();
    const parts:string[]=[];
    for(let current=resolve(path);;current=dirname(current)){parts.push(current);if(dirname(current)===current)break;}
    for(const part of parts.reverse()) {
      try {if(lstatSync(part).isSymbolicLink())fail();}
      catch(error){if(missing && (error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    }
  };
  safePath(agents,true);
  const scan=async()=>{
    const raw=await git(root,['worktree','list','--porcelain','-z']);
    if(!raw.endsWith('\0\0'))fail();
    const groups=raw.slice(0,-2).split('\0\0');if(groups.length>128)fail();
    const seen=new Set<string>();
    const candidates:Array<{path:string;name:string;branch:string}>=[];
    for(const group of groups){
      const lines=group.split('\0');if(!lines[0].startsWith('worktree '))fail();
      const path=lines[0].slice(9);
      if(!isAbsolute(path)||seen.has(path))fail();seen.add(path);
      const nested=dirname(path)===agents, sibling=dirname(path)===dirname(root)&&basename(path).startsWith(basename(root)+'.wt-');
      if(!nested&&!sibling)continue;
      if(lines.some(line=>line==='prunable'||line.startsWith('prunable ')))continue;
      safePath(path);
      if(realpathSync(path)!==path || !lstatSync(path).isDirectory())fail();
      const branch=lines.find(line=>line.startsWith('branch refs/heads/'))?.slice(18)||'';
      if((await git(path,['rev-parse','--show-toplevel'])).trim()!==path || realpathSync(resolve(path,(await git(path,['rev-parse','--git-common-dir'])).trim()))!==common)fail();
      candidates.push({path,name:nested?basename(path):basename(path).slice(basename(root).length+4),branch});
    }
    return candidates;
  };
  const candidates=await scan();
  const choose=(predicate:(name:string)=>boolean)=>{
    const matches=candidates.filter(item=>predicate(item.name.toLowerCase()));
    if(matches.length>1)fail();return matches[0];
  };
  const match=choose(name=>name===slug.toLowerCase()) || choose(name=>name.endsWith('-'+slug.toLowerCase())) || choose(name=>name.startsWith(slug.toLowerCase()+'-')||name.includes('-'+slug.toLowerCase()+'-'));
  if(match)return {slug,path:match.path,branch:match.branch,create:false,materialize:async()=>{const fresh=await scan();if(!fresh.some(item=>item.path===match.path&&item.branch===match.branch))fail();}};
  const branches=(await git(root,['for-each-ref','--format=%(refname:short)','refs/heads/agents'])).trim().split('\n').filter(Boolean);
  if(branches.length>1000)fail();
  let name=slug;
  if(branches.includes('agents/'+name)){
    let max=0;
    for(const item of [...candidates.map(item=>item.name),...branches.map(branch=>branch.replace(/^agents\//,''))]) {const m=/^(\d+)-/.exec(item);if(m){const n=Number(m[1]);if(!Number.isSafeInteger(n))fail();max=Math.max(max,n);}}
    let found=false;
    for(let i=1;i<=1000;i++){if(!Number.isSafeInteger(max+i))fail();name=`${max+i}-${slug}`;if(!branches.includes('agents/'+name)){found=true;break;}}
    if(!found)fail();
  }
  const path=join(agents,name),branch='agents/'+name;
  const vacant=()=>{safePath(path,true);try{lstatSync(path);fail();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}};
  vacant();
  return {slug,path,branch,create:true,materialize:async()=>{
    vacant();
    if(realpathSync(root)!==root || (await git(root,['rev-parse','--show-toplevel'])).trim()!==root || realpathSync(resolve(root,(await git(root,['rev-parse','--git-common-dir'])).trim()))!==common)fail();
    await git(root,['worktree','add',path,'-b',branch]);
    const fresh=await scan();if(!fresh.some(item=>item.path===path&&item.branch===branch))fail();
  }};
}
