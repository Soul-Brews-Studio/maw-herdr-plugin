#!/usr/bin/env node
// Actual server processes; fake Herdr and registered repositories are disposable.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const home=realpathSync(mkdtempSync(join(tmpdir(),'herdr-finalize-smoke-')));
const stateFile=join(home,'state.json'),registry=join(home,'oracles.json'),fake=join(home,'herdr');
const repo=join(home,'github.com','test-org','test-repo-oracle');mkdirSync(join(repo,'.git'),{recursive:true});
const save=(p,v)=>writeFileSync(p,JSON.stringify(v));
const git=(...args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',repo,...args],{encoding:'utf8',env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']});
git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('commit','--allow-empty','-m','fixture');
const entry={name:'fixture',org:'test-org',repo:'test-repo-oracle',local_path:repo};
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
if(a[0]==='pane'&&a[1]==='process-info'){
 const pane=s.panes.find(p=>p.pane_id===a[a.indexOf('--pane')+1]);if(!pane)process.exit(2);const live=s.busy||(s.runs>0&&s.ready),pid=live?200:100;
 const processes=[{pid,name:live?(s.emptyName?'':'codex'):'sh',argv:[live?'codex':'/bin/sh'],cmdline:live?'codex':'/bin/sh',cwd:s.wrongCwd?'/wrong':pane.cwd}];if(live&&s.duplicatePid)processes.push({...processes[0]});emit({type:'pane_process_info',process_info:{pane_id:pane.pane_id,shell_pid:100,foreground_process_group_id:pid,foreground_processes:processes}});process.exit(0)
}
if(a[0]==='pane'&&a[1]==='run'){s.runs=(s.runs||0)+1;s.line=a[3];fs.writeFileSync(p,JSON.stringify(s));process.exit(0)}
if(a[0]==='pane'&&a[1]==='read'){console.log(s.trust?'Do you trust the files in this folder':'fixture output');process.exit(0)}
if(a[0]==='agent'&&a[1]==='start'){
 const pane=s.panes.find(p=>p.pane_id===a[a.indexOf('--pane')+1]);if(!pane)process.exit(2);s.starts++;const kind=a[a.indexOf('--kind')+1];if(s.ready)pane.agent=kind;fs.writeFileSync(p,JSON.stringify(s));emit({type:'agent_started',argv:[kind],agent:{pane_id:pane.pane_id,agent:kind,interactive_ready:s.ready,launch_pending:!s.ready}});process.exit(0)
}
process.exit(3);
`,{mode:0o700});
const token='fixture-registry-operator-secret';const tokenFile=join(home,'token');writeFileSync(tokenFile,token,{mode:0o600});
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MAW_')||key.startsWith('HERDR_')||key==='PEERS_FILE')delete env[key];
Object.assign(env,{HOME:home,MAW_CONFIG_DIR:join(home,'config'),MAW_TEST_MODE:'1',MAW_ORACLES_JSON:registry,FIXTURE_STATE:stateFile});
const native=process.argv[2],args=['--token-file',tokenFile,'--listen','127.0.0.1:0','--herdr',fake,'--data-dir',join(home,'ui')];
const child=spawn(native?resolve(native):'bun',native?args:[resolve(process.env.MAW_LAUNCH_ENTRY||'index.mjs'),'serve',...args],{cwd:home,env,stdio:['ignore','pipe','pipe']});
let output='';const exited=new Promise(done=>child.once('exit',(code,signal)=>done({code,signal})));
async function deadline(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),15000)})]);}finally{clearTimeout(timer)}}
try{
 const url=await deadline(new Promise((done,fail)=>{child.stderr.on('data',d=>{output+=d;const m=output.match(/http:\/\/[^\s]+/);if(m)done(m[0]);});child.once('error',fail);child.once('exit',()=>fail(Error(output)));}));
 const wake=(target,task)=>fetch(url+'/api/wake',{method:'POST',headers:{'Content-Type':'application/json',Origin:url,Authorization:'Bearer '+token},body:JSON.stringify({target,...(task?{task}:{})}),signal:AbortSignal.timeout(15000)});
 const fleet=join(home,'.maw','fleet','default.json'),hookLog=join(home,'hooks.log');
 const config=join(repo,'.maw');mkdirSync(config);
 const hook='test -f "$HOME/.maw/fleet/default.json" && printf "%s|%s|%s|%s\\n" "$MAW_ORACLE" "$MAW_SESSION" "$MAW_WINDOW" "$PWD" >> "$HOME/hooks.log"';
 save(join(config,'maw.config.100.json'),{hooks:{postWake:[hook,'exit 7',hook]}});
 let r=await wake('fixture');assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).state,'ready');
 let f=JSON.parse(readFileSync(fleet));assert.equal(f.name,'default');assert.equal(f.created_by,'maw wake');assert.ok(f.windows.some(w=>w.name==='fixture'&&w.repo==='test-org/test-repo-oracle'));
 assert.deepEqual(readFileSync(hookLog,'utf8').trim().split('\n'),Array(2).fill('fixture|default|fixture|'+home));
 f.retained={operator:true};const created=f.created_at;save(fleet,f);
 r=await wake('test-org/test-repo-oracle');assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).state,'already-awake');
 f=JSON.parse(readFileSync(fleet));assert.deepEqual(f.retained,{operator:true});assert.equal(f.created_at,created);assert.equal(readFileSync(hookLog,'utf8').trim().split('\n').length,4);
 const taskPath=join(repo,'agents','sideeffects');git('worktree','add',taskPath,'-b','agents/sideeffects');mkdirSync(join(taskPath,'.maw'));save(join(taskPath,'.maw','maw.config.100.json'),{hooks:{postWake:[hook]}});
 r=await wake('fixture','sideeffects');assert.equal(r.status,200,await r.clone().text());f=JSON.parse(readFileSync(fleet));assert.ok(f.windows.some(w=>w.name==='fixture-sideeffects'&&w.repo==='test-org/test-repo-oracle'));assert.equal(readFileSync(hookLog,'utf8').trim().split('\n').at(-1),'fixture|default|fixture-sideeffects|'+home);
 const taskPane=JSON.parse(readFileSync(stateFile)).panes.find(p=>p.cwd===taskPath);
 const canonical=Buffer.from('default').toString('base64url')+'/'+Buffer.from(taskPane.workspace_id).toString('base64url')+':0';
 r=await wake(canonical);assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).state,'already-awake');
 assert.equal(readFileSync(hookLog,'utf8').trim().split('\n').at(-1),'fixture|default|fixture-sideeffects|'+home,'canonical task wake preserves registered oracle');
 f=JSON.parse(readFileSync(fleet));assert.equal(f.windows.find(w=>w.name==='fixture-sideeffects').kind,'oracle','canonical task wake preserves base oracle kind');
 const before=readFileSync(hookLog,'utf8');writeFileSync(fleet,'{malformed');r=await wake('fixture');assert.notEqual(r.status,200);assert.equal(readFileSync(hookLog,'utf8'),before,'fleet failure must prevent hooks');assert.equal(readFileSync(fleet,'utf8'),'{malformed');
 child.kill('SIGTERM');assert.equal((await deadline(exited)).code,0);
 console.log('PASS wake finalization '+(native?'native':'bun')+': fleet-before-hooks, repeated wake, task base identity, metadata, nonzero continuation, malformed-file preservation');
}finally{if(child.exitCode===null){child.kill('SIGTERM');await deadline(exited).catch(()=>child.kill('SIGKILL'));}rmSync(home,{recursive:true,force:true});}
