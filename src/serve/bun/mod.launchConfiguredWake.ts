import {realpathSync} from 'node:fs';
import {basename,isAbsolute} from 'node:path';
import {BackendError,type RunHerdr,type Target} from './types.ts';

/** Submit trusted operator configuration and prove foreground launch, not agent readiness. */
export async function launchConfiguredWake(run: RunHerdr, target: Target, line: string, signal: AbortSignal): Promise<'launched'> {
  const fail=(): never=>{throw new BackendError('backend_error','configured launch not verified');};
  let cwd:string;try{cwd=realpathSync(target.pane.cwd);}catch{return fail();}
  if(!isAbsolute(target.pane.cwd))fail();
  const controller=new AbortController();
  const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,8000);if(signal.aborted)abort();
  const s=controller.signal;
  const shellNames=new Set(['sh','bash','zsh','fish','dash','ksh','tcsh','csh','nu']);
  const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
  const info=async()=>{
    let response;try{response=JSON.parse(await run(['--session',target.session,'pane','process-info','--pane',target.pane.id],s));}catch{return fail();}
    const result=response?.result,p=result?.process_info;
    if(response?.error!=null || result?.error!=null || result?.type!=='pane_process_info' || p?.pane_id!==target.pane.id || !positive(p.shell_pid)||!positive(p.foreground_process_group_id)||!Array.isArray(p.foreground_processes)||p.foreground_processes.length>128)fail();
    const seen=new Set<number>();
    for(const process of p.foreground_processes){
      if(!process||!positive(process.pid)||seen.has(process.pid)||typeof process.name!=='string'||!process.name||typeof process.cwd!=='string'||!isAbsolute(process.cwd))fail();
      seen.add(process.pid);try{if(realpathSync(process.cwd)!==cwd)fail();}catch{return fail();}
    }
    return p as {shell_pid:number;foreground_process_group_id:number;foreground_processes:Array<{pid:number;name:string;cwd:string}>};
  };
  try{
    const before=await info();
    if(before.foreground_process_group_id!==before.shell_pid || before.foreground_processes.length!==1 || before.foreground_processes[0].pid!==before.shell_pid || !shellNames.has(basename(before.foreground_processes[0].name)))fail();
    const ack=await run(['--session',target.session,'pane','run',target.pane.id,line],s);if(ack.trim()!=='')fail();
    let confirmations=0;
    while(!s.aborted){
      const state=await info();if(state.shell_pid!==before.shell_pid)fail();
      const screen=await run(['--session',target.session,'pane','read',target.pane.id,'--source','visible','--lines','200','--format','text'],s);
      if(Buffer.byteLength(screen)>64*1024)fail();
      if(screen.includes('Do you trust the contents of this directory')||screen.includes('Do you trust the files in this folder'))fail();
      const launched=state.foreground_process_group_id!==state.shell_pid && state.foreground_processes.some(process=>process.pid!==state.shell_pid&&!shellNames.has(basename(process.name)));
      confirmations=launched?confirmations+1:0;
      if(confirmations>=3 && !s.aborted)return 'launched';
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);reject(new BackendError('backend_error','configured launch not verified'));};
        const timer=setTimeout(()=>{s.removeEventListener('abort',abort);resolve();},launched?200:100);
        s.addEventListener('abort',abort,{once:true});if(s.aborted)abort();
      });
    }
    return fail();
  }catch{return fail();}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
