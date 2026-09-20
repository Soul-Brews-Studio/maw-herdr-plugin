#!/usr/bin/env node
// Actual server processes; fake Herdr and registered repositories are disposable.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const home=realpathSync(mkdtempSync(join(tmpdir(),'herdr-task-smoke-')));
const stateFile=join(home,'state.json'),registry=join(home,'oracles.json'),fake=join(home,'herdr');
const repo=join(home,'repo with spaces');mkdirSync(repo,{recursive:true});
const git=(...args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',repo,...args],{encoding:'utf8',env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']});
git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('commit','--allow-empty','-m','fixture');
const save=(p,v)=>writeFileSync(p,JSON.stringify(v));
const entry={name:'fixture',org:'test-org',repo:'test-repo',local_path:repo};
save(registry,{oracles:[entry]});
const fresh=()=>({workspaces:[],panes:[],creates:0,starts:0,ready:true});save(stateFile,fresh());
writeFileSync(fake,`#!${process.execPath}
const fs=require('node:fs');const p=process.env.FIXTURE_STATE;const s=JSON.parse(fs.readFileSync(p));let a=process.argv.slice(2);const emit=result=>console.log(JSON.stringify({result}));
if(a[0]==='session'){emit({sessions:[{name:'default',running:true}]});process.exit(0)}
if(a[0]==='--session')a=a.slice(2);
if(a[0]==='api'&&a[1]==='snapshot'){emit({protocol:22,workspaces:s.workspaces,panes:s.panes});process.exit(0)}
if(a[0]==='workspace'&&a[1]==='create'){
 const cwd=a[a.indexOf('--cwd')+1],label=a[a.indexOf('--label')+1];const id='w'+(++s.creates);const pane={pane_id:id+':p0',workspace_id:id,agent:'',label,title:'shell',cwd,focused:false,agent_status:'idle'};
 s.workspaces.push({workspace_id:id,label});s.panes.push(pane);fs.writeFileSync(p,JSON.stringify(s));emit({type:'workspace_created',workspace:s.workspaces.at(-1),tab:{},root_pane:pane});process.exit(0)
}
if(a[0]==='agent'&&a[1]==='start'){
 const pane=s.panes.find(p=>p.pane_id===a[a.indexOf('--pane')+1]);if(!pane)process.exit(2);s.starts++;const kind=a[a.indexOf('--kind')+1];if(s.ready)pane.agent=kind;fs.writeFileSync(p,JSON.stringify(s));emit({type:'agent_started',argv:[kind],agent:{pane_id:pane.pane_id,agent:kind,interactive_ready:s.ready,launch_pending:!s.ready}});process.exit(0)
}
process.exit(3);
`,{mode:0o700});
const token='fixture-registry-operator-secret';const tokenFile=join(home,'token');writeFileSync(tokenFile,token,{mode:0o600});
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MAW_')||key.startsWith('HERDR_')||key==='PEERS_FILE')delete env[key];
Object.assign(env,{HOME:home,MAW_CONFIG_DIR:join(home,'config'),MAW_TEST_MODE:'1',MAW_ORACLES_JSON:registry,FIXTURE_STATE:stateFile});
const native=process.argv[2],args=['--token-file',tokenFile,'--listen','127.0.0.1:0','--herdr',fake,'--data-dir',join(home,'ui')];
const child=spawn(native?resolve(native):'bun',native?args:[resolve(process.env.MAW_TASK_ENTRY||'index.mjs'),'serve',...args],{cwd:home,env,stdio:['ignore','pipe','pipe']});
let output='';const exited=new Promise(done=>child.once('exit',(code,signal)=>done({code,signal})));
async function deadline(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),15000)})]);}finally{clearTimeout(timer)}}
try{
 const url=await deadline(new Promise((done,fail)=>{child.stderr.on('data',d=>{output+=d;const m=output.match(/http:\/\/[^\s]+/);if(m)done(m[0]);});child.once('error',fail);child.once('exit',()=>fail(Error(output)));}));
 const wake=(target,auth=true,task=undefined)=>fetch(url+'/api/wake',{method:'POST',headers:{'Content-Type':'application/json',Origin:url,...(auth?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({target,...(task===undefined?{}:{task})}),signal:AbortSignal.timeout(15000)});
 const state=()=>JSON.parse(readFileSync(stateFile,'utf8'));
 assert.equal((await wake('fixture',false)).status,401);assert.deepEqual(state(),fresh());
 for(const target of ['missing','test-org/missing','../repo']){assert.notEqual((await wake(target)).status,200);assert.deepEqual(state(),fresh());}
 save(registry,{oracles:[entry,{...entry,org:'other'}]});assert.notEqual((await wake('fixture')).status,200);assert.deepEqual(state(),fresh());save(registry,{oracles:[entry]});
 let response=await wake('fixture');assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).ok,true);assert.equal(state().creates,1);assert.equal(state().starts,1);
 response=await wake('test-org/test-repo');assert.equal(response.status,200,await response.clone().text());assert.equal(state().creates,1);assert.equal(state().starts,1);
 save(stateFile,fresh());const concurrent=await Promise.all([wake('fixture'),wake('test-org/test-repo')]);for(const r of concurrent)assert.equal(r.status,200,await r.clone().text());assert.equal(state().creates,1);assert.equal(state().starts,1);
 save(stateFile,fresh());
 for(const task of ['','   ','--flag','...',String.fromCharCode(0),'x'.repeat(1025)]){const denied=await wake('fixture',true,task);assert.notEqual(denied.status,200);if(Buffer.byteLength(task)>1024)assert.equal(denied.status,400);assert.equal(state().creates,0);}
 response=await wake('fixture',true,'Issue 90');assert.equal(response.status,200,await response.clone().text());
 const taskPath=join(repo,'agents','issue-90');assert.equal(state().panes[0].cwd,taskPath);
 assert.ok(git('worktree','list','--porcelain').includes('branch refs/heads/agents/issue-90'));
 writeFileSync(join(taskPath,'private-untracked'),'keep');
 response=await wake('test-org/test-repo',true,'Issue 90');assert.equal(response.status,200,await response.clone().text());assert.equal(state().creates,1);assert.equal(state().starts,1);assert.equal(readFileSync(join(taskPath,'private-untracked'),'utf8'),'keep');
 save(stateFile,fresh());git('branch','agents/collision');response=await wake('fixture',true,'collision');assert.equal(response.status,200,await response.clone().text());assert.ok(/agents\/\d+-collision$/.test(state().panes[0].cwd));
 save(stateFile,fresh());mkdirSync(join(repo,'agents','occupied'));writeFileSync(join(repo,'agents','occupied','private'),'keep');response=await wake('fixture',true,'occupied');assert.notEqual(response.status,200);assert.equal(state().creates,0);assert.equal(readFileSync(join(repo,'agents','occupied','private'),'utf8'),'keep');
 save(stateFile,fresh());const suffix=join(repo,'agents','20-suffix');git('worktree','add',suffix,'-b','agents/20-suffix');response=await wake('fixture',true,'suffix');assert.equal(response.status,200,await response.clone().text());assert.equal(state().panes[0].cwd,suffix);
 save(stateFile,fresh());for(const name of ['21-ambiguous','22-ambiguous'])git('worktree','add',join(repo,'agents',name),'-b','agents/'+name);response=await wake('fixture',true,'ambiguous');assert.notEqual(response.status,200);assert.equal(state().creates,0);
 save(stateFile,{...fresh(),workspaces:[{workspace_id:'conflict',label:'fixture-conflict'}],panes:[{pane_id:'conflict:p0',workspace_id:'conflict',agent:'claude',label:'fixture-conflict',title:'',cwd:repo,focused:false,agent_status:'idle'}]});response=await wake('fixture',true,'conflict');assert.notEqual(response.status,200);assert.equal(state().creates,0);assert.equal(existsSync(join(repo,'agents','conflict')),false,'cwd conflict must reject before Git creation');
 save(stateFile,{...fresh(),ready:false});response=await wake('fixture',true,'launch failure');assert.notEqual(response.status,200);assert.equal(state().creates,1);assert.equal(state().starts,1);assert.ok(git('worktree','list','--porcelain').includes(join(repo,'agents','launch-failure')));
 child.kill('SIGTERM');assert.equal((await deadline(exited)).code,0);
 console.log('PASS task wake ('+(native?'native':'bun')+'): registry/auth, slug, real Git create/reuse, dirty preservation, branch collision, occupied path, launch failure retention');
}finally{if(child.exitCode===null){child.kill('SIGTERM');await deadline(exited).catch(()=>child.kill('SIGKILL'));}rmSync(home,{recursive:true,force:true});}
