import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {BackendError} from './types.ts';

export function resolveRegistryWake(target: string): {name:string;path:string} {
  const fail = (): never => { throw new BackendError('backend_error','registry unavailable'); };
  const missing = (): never => { throw new BackendError('target_not_found','registered repository unavailable'); };
  if (!target || /[\x00-\x20\x7f]/.test(target) || target.startsWith('-') || target.includes('\\') || target.split('/').some(part => !part || part === '.' || part === '..') || target.split('/').length > 2) missing();
  const path = resolve(process.env.MAW_ORACLES_JSON || join(homedir(),'.maw','oracles.json'));
  let fd: number | undefined;
  let registryRead = false;
  try {
    const ancestors: string[] = [];
    for(let current=path;;current=dirname(current)){ancestors.push(current);if(dirname(current)===current)break;}
    for(const component of ancestors.reverse())if(lstatSync(component).isSymbolicLink())fail();
    const before=lstatSync(path);if(!before.isFile() || before.size>1024*1024)fail();
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);if(!stat.isFile() || stat.dev!==before.dev || stat.ino!==before.ino)fail();
    const bytes=Buffer.alloc(1024*1024+1);let length=0;
    while(length<bytes.length){const count=readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
    if(length>1024*1024)fail();
    const store=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,length)));
    if(!store || typeof store!=='object' || Array.isArray(store) || !Array.isArray(store.oracles) || store.oracles.length>1024)fail();
    if(store.oracles.some((entry: unknown) => !entry || typeof entry!=='object' || Array.isArray(entry) || ['name','org','repo','local_path'].some(key => { const value=(entry as Record<string,unknown>)[key]; return value!==undefined && value!==null && typeof value!=='string'; })))fail();
    const matches=store.oracles.filter((entry: unknown)=>{
      if(!entry || typeof entry!=='object' || Array.isArray(entry))return false;
      const item=entry as Record<string,unknown>;
      return item.name===target || (typeof item.org==='string' && typeof item.repo==='string' && `${item.org}/${item.repo}`===target);
    });
    if(matches.length!==1)missing();
    registryRead = true;
    const entry=matches[0];
    if(typeof entry.name!=='string' || !entry.name || Buffer.byteLength(entry.name)>1024 || entry.name.startsWith('-') || /[\x00-\x1f\x7f]/.test(entry.name) || typeof entry.local_path!=='string' || !isAbsolute(entry.local_path) || /[\x00-\x1f\x7f]/.test(entry.local_path))fail();
    const checkout=realpathSync(entry.local_path);
    if(!statSync(checkout).isDirectory())fail();
    const git=lstatSync(join(checkout,'.git'));
    if(!git.isFile() && !git.isDirectory())fail();
    return {name:entry.name,path:checkout};
  } catch (error) { if(error instanceof BackendError)throw error; if(!registryRead && (error as NodeJS.ErrnoException).code==='ENOENT')return missing(); return fail(); }
  finally {if(fd!==undefined)closeSync(fd);}
}
