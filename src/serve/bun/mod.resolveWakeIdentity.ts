import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readWakeRegistryEntries, validateWakeRegistryEntry } from "./mod.resolveRegistryWake.ts";
import { runHerdr } from "./mod.runHerdr.ts";
import { BackendError } from "./types.ts";

/** Only exact registered roots or Git-proven worktree membership, never label/path guesses. */
export async function resolveWakeIdentity(cwd: string, window: string, signal: AbortSignal): Promise<{basePath:string;oracle:string}> {
  const fail=(): never=>{throw new BackendError("backend_error","registry unavailable");};
  if(signal.aborted || !isAbsolute(cwd))fail();
  try {cwd=realpathSync(cwd);if(!statSync(cwd).isDirectory())fail();} catch {return fail();}
  const entries=readWakeRegistryEntries().map(validateWakeRegistryEntry);
  if(!entries.length)return {basePath:cwd,oracle:window};
  const controller=new AbortController(), abort=()=>controller.abort();
  signal.addEventListener("abort",abort,{once:true});
  const timer=setTimeout(abort,10_000);if(signal.aborted)abort();
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_")));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0"});
  const git=(path:string,args:string[])=>runHerdr("git",["-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","-C",path,...args],controller.signal,env);
  const identity=async(path:string)=>({top:realpathSync((await git(path,["rev-parse","--show-toplevel"])).trim()),common:realpathSync(resolve(path,(await git(path,["rev-parse","--git-common-dir"])).trim()))});
  try {
    const members=new Set<string>();let common="", candidate:Awaited<ReturnType<typeof identity>>|undefined;
    let hasGit=false;try{lstatSync(join(cwd,".git"));hasGit=true;}catch{}
    if(hasGit){try{candidate=await identity(cwd);}catch{if(controller.signal.aborted)fail();}}
    if(candidate?.top===cwd){
      const raw=await git(cwd,["worktree","list","--porcelain","-z"]);
      if(!raw.endsWith("\0\0"))fail();
      const groups=raw.slice(0,-2).split("\0\0");if(groups.length>128)fail();
      const seen=new Set<string>();
      for(const group of groups){
        const lines=group.split("\0"), path=lines[0].slice(9);
        if(!lines[0].startsWith("worktree ") || !isAbsolute(path) || seen.has(path))fail();seen.add(path);
        if(lines.some(line=>line==="prunable"||line.startsWith("prunable ")))continue;
        try{members.add(realpathSync(path));}catch{}
      }
      if(members.has(cwd))common=candidate.common;
    }
    const matches=[];
    for(const entry of entries){
      if(controller.signal.aborted)fail();
      let match=entry.path===cwd;
      if(!match && common && members.has(entry.path)){
        const value=await identity(entry.path);if(value.top!==entry.path||value.common!==common)fail();match=true;
      }
      if(match)matches.push(entry);
    }
    if(matches.length>1)fail();
    return matches.length ? {basePath:matches[0].path,oracle:matches[0].name} : {basePath:cwd,oracle:window};
  } finally {clearTimeout(timer);signal.removeEventListener("abort",abort);}
}
