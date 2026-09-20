#!/usr/bin/env bun
// Pure source-parity fixtures: no shell execution, environment mutation, or filesystem writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveWakeLaunch} from '../src/serve/bun/mod.resolveWakeLaunch.ts';
const cases=JSON.parse(readFileSync(new URL('./wake-launch-cases.json',import.meta.url),'utf8'));
for(const fixture of cases){
  const before=JSON.stringify(fixture.config);
  const run=()=>resolveWakeLaunch(fixture.config,fixture.window,fixture.explicitEngine,fixture.fallback);
  if(fixture.error)assert.throws(run,new RegExp(fixture.error),fixture.name);
  else assert.deepEqual(run(),fixture.expected,fixture.name);
  assert.equal(JSON.stringify(fixture.config),before,'renderer mutated config');
}
assert.throws(()=>resolveWakeLaunch({commands:{neo:'x'.repeat(65536)}},'neo'),/wake launch unavailable/);
assert.throws(()=>resolveWakeLaunch({},'neo\0'),/wake launch unavailable/);
const result=resolveWakeLaunch({commands:{neo:'private-executable --secret private-token'},wake:{resume:true,channels:true}},'neo');
assert.ok(!JSON.stringify(result.warnings).includes('private'));
console.log(`PASS wake launch: ${cases.length} shared source-parity cases, NUL/size bounds, secret-free warnings, no mutation`);

// Mock the Herdr boundary only; no process or shell is started by these guards.
const {launchConfiguredWake}=await import('../src/serve/bun/mod.launchConfiguredWake.ts');
const {realpathSync}=await import('node:fs');
const cwd=realpathSync(process.cwd());
const target={session:'fixture',pane:{id:'w1:p1',workspace:'w1',agent:'',label:'fixture',title:'shell',cwd,focused:true,status:'idle'}};
for(const mode of ['missing-name','duplicate-pid','too-many','oversized-capture']){
  let submitted=0;
  const run=async(args:string[])=>{
    if(args[3]==='process-info'){
      const process={pid:submitted?200:100,name:submitted?'codex':'sh',cwd};
      const processes:unknown[]=mode==='missing-name'?[{pid:100,cwd}]:mode==='duplicate-pid'?[process,process]:mode==='too-many'?Array.from({length:129},(_,i)=>({...process,pid:100+i})):[process];
      return JSON.stringify({result:{type:'pane_process_info',process_info:{pane_id:'w1:p1',shell_pid:100,foreground_process_group_id:submitted?200:100,foreground_processes:processes}}});
    }
    if(args[3]==='run'){submitted++;return '';}
    if(args[3]==='read')return 'x'.repeat(65537);
    throw new Error('unexpected mock operation');
  };
  await assert.rejects(launchConfiguredWake(run,target,'trusted fixture command',new AbortController().signal),/configured launch not verified/,mode);
  assert.equal(submitted,mode==='oversized-capture'?1:0,mode);
}
console.log('PASS configured proof guards: missing names, duplicate PIDs, 128-process limit, 64KiB capture limit');
