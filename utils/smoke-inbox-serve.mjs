#!/usr/bin/env node
// Isolated HTTP servers: a shell pane, no agent process, and no live Herdr daemon.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const home=realpathSync(mkdtempSync(join(tmpdir(),'herdr-inbox-smoke-')));
const repo=join(home,'receiver'),other=join(home,'other'),configDir=join(home,'config');
for(const p of [repo,other,configDir])mkdirSync(p);
mkdirSync(join(repo,'.git'));
const stateFile=join(home,'state'),calls=join(home,'calls'),registry=join(home,'registry.json'),fake=join(home,'herdr'),configFile=join(configDir,'maw.config.50.json');
const save=(path,value)=>writeFileSync(path,JSON.stringify(value));
save(registry,{oracles:[{name:'fixture',org:'test',repo:'receiver',local_path:repo}]});
save(configFile,{node:'fixture-node',oracle:'server-oracle'});
const initial={workspaces:[{workspace_id:'w1',label:'fixture'}],panes:[{pane_id:'w1:p0',workspace_id:'w1',agent:'',label:'fixture',title:'shell',cwd:repo,focused:false,agent_status:'idle'}]};save(stateFile,initial);
writeFileSync(fake,`#!${process.execPath}
const fs=require('node:fs');let a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');const emit=result=>console.log(JSON.stringify({result}));
if(a[0]==='session'){emit({sessions:[{name:'default',running:true}]});process.exit(0)}
if(a[0]==='--session')a=a.slice(2);
if(a[0]==='api'&&a[1]==='snapshot'){const s=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)},'utf8'));emit({protocol:22,...s});if(s.renameAfterFirst){s.renameAfterFirst=false;s.workspaces[0].label='renamed';s.panes[0].label='renamed';fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(s));}if(s.moveAfterFirst){s.moveAfterFirst=false;s.panes[0].cwd=${JSON.stringify(other)};fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(s));}process.exit(0)}
process.exit(3);
`,{mode:0o700});
const token='fixture-inbox-operator-secret',tokenFile=join(home,'token');writeFileSync(tokenFile,token,{mode:0o600});
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MAW_')||key.startsWith('HERDR_')||key.startsWith('TMUX')||key==='PEERS_FILE')delete env[key];
Object.assign(env,{HOME:home,XDG_CONFIG_HOME:join(home,'xdg'),MAW_CONFIG_DIR:configDir,MAW_TEST_MODE:'1',MAW_ORACLES_JSON:registry});
const native=process.argv[2],args=['--token-file',tokenFile,'--listen','127.0.0.1:0','--herdr',fake,'--data-dir',join(home,'ui')];
let running,url;
async function deadline(p,label,ms=15000){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timeout')),ms)})]);}finally{clearTimeout(timer)}}
async function start(gate){
 const runtimeEnv={...env};if(gate!==undefined)runtimeEnv.MAW_HEY_INBOX_AUTOWRITE=gate;
 const child=spawn(native?resolve(native):'bun',native?args:[resolve(process.env.MAW_INBOX_ENTRY||'index.mjs'),'serve',...args],{cwd:home,env:runtimeEnv,stdio:['ignore','pipe','pipe']});
 const exited=new Promise(done=>{child.once('exit',(code,signal)=>done({code,signal}));child.once('error',error=>done({error}));});running={child,exited};child.stdout.resume();let output='';
 url=await deadline(new Promise((done,fail)=>{child.stderr.on('data',d=>{output+=d;const m=output.match(/http:\/\/[^\s]+/);if(m)done(m[0]);});child.once('error',fail);child.once('exit',()=>fail(Error(output)));}),'startup');
}
async function stop(){if(!running)return;const{child,exited}=running;try{child.kill('SIGTERM');assert.equal((await deadline(exited,'shutdown',3000)).code,0);}finally{if(child.exitCode===null){child.kill('SIGKILL');await deadline(exited,'kill',3000);}running=undefined;}}
const request=(body,auth=true,from,logical)=>fetch(url+'/api/send',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{}),...(from?{'X-Maw-From':from}:{}),...(logical?{'X-Maw-Timestamp':logical}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
const target=Buffer.from('default').toString('base64url')+'/'+Buffer.from('w1').toString('base64url')+':0';
const files=(root=repo)=>{try{return readdirSync(join(root,'ψ','inbox')).filter(n=>n.endsWith('.md'));}catch(error){if(error.code==='ENOENT')return[];throw error;}};
try{
 await start();let response=await request({target,text:'disabled',inbox:true});assert.notEqual(response.status,200);assert.deepEqual(files(),[]);await stop();
 await start('yes');response=await request({target,text:'unauthorized',inbox:true},false);assert.equal(response.status,401);assert.deepEqual(files(),[]);
 response=await request({target,text:'Review this',attachments:['/literal/not/read'],inbox:true,force:true},true,'sender:remote');assert.equal(response.status,200,await response.clone().text());
 let result=await response.json();assert.equal(result.source,'inbox');assert.equal(result.state,'queued');assert.equal(result.text,'Review this');assert.deepEqual(result.receipt,['fallback_queued']);assert.equal(files().length,1);
 let content=readFileSync(result.inbox,'utf8');assert.match(content,/from: remote:sender\nto: fixture\n/);assert.match(content,/read: false\n---\n\n\/literal\/not\/read\nReview this\n$/);
 const countBeforeRetry=files().length;
 const retryBody={target,text:'timestamp retry',inbox:true};
 const retries=await Promise.all([request(retryBody,true,'sender:remote','fixture-1'),request(retryBody,true,'sender:remote','fixture-1')]);
 const receipts=[];for(const r of retries){assert.equal(r.status,200,await r.clone().text());receipts.push(await r.json());}
 assert.equal(receipts.filter(r=>r.deduped===true).length,1);assert.equal(files().length,countBeforeRetry+1);assert.deepEqual(receipts.find(r=>r.deduped).receipt,['duplicate_dropped']);
 for(let i=0;i<2;i++){const r=await request(retryBody);assert.equal(r.status,200,await r.clone().text());}
 assert.equal(files().length,countBeforeRetry+3);
 const historyResponse=await fetch(url+'/api/feed',{headers:{Authorization:'Bearer '+token}});assert.equal(historyResponse.status,200);
 const history=await historyResponse.json();const authEvents=history.events.filter(e=>e.event==='auth-reject');assert.equal(authEvents.length,1);assert.equal(authEvents[0].decision,'operator_token_required');assert.equal(authEvents[0].text,'');assert.equal(authEvents[0].from,'');assert.ok(!JSON.stringify(history).includes(token));const retryEvents=history.events.filter(e=>e.text==='timestamp retry');
 assert.deepEqual(retryEvents.map(e=>e.state).sort(),['deduped','queued','queued','queued']);assert.ok(retryEvents.every(e=>e.route==='inbox'&&e.target===target));
 assert.equal((await fetch(url+'/api/feed')).status,401);
 const another=await request(retryBody,true,'sender:remote','fixture-2');assert.equal(another.status,200);assert.equal(files().length,countBeforeRetry+4);
 response=await request({target,text:'configured sender',inbox:true});assert.equal(response.status,200,await response.clone().text());content=readFileSync((await response.json()).inbox,'utf8');assert.match(content,/from: fixture-node:server-oracle\n/);
 response=await request({target,inbox:true});assert.equal(response.status,200,await response.clone().text());result=await response.json();assert.equal(result.text,'');assert.ok(readFileSync(result.inbox,'utf8').endsWith('read: false\n---\n\n\n'));
 const before=files().length;save(stateFile,{workspaces:[],panes:[]});response=await request({target,text:'stale',inbox:true});assert.notEqual(response.status,200);assert.equal(files().length,before);save(stateFile,initial);
 save(stateFile,{...initial,moveAfterFirst:true});response=await request({target,text:'moved during resolution',inbox:true});assert.notEqual(response.status,200);assert.equal(files().length,before);save(stateFile,initial);
 save(stateFile,{...initial,renameAfterFirst:true});response=await request({target,text:'renamed during resolution',inbox:true});assert.notEqual(response.status,200);assert.equal(files().length,before);save(stateFile,initial);
 save(configFile,{node:'fixture-node',oracle:'fixture',psiPath:'other/ψ'});response=await request({target,text:'configured root',inbox:true});assert.equal(response.status,200,await response.clone().text());result=await response.json();assert.ok(result.inbox.startsWith(join(other,'ψ','inbox')+'/'));assert.equal(files(other).length,1);
 const corrupt=join(home,'not-a-directory');writeFileSync(corrupt,'not a repo');save(configFile,{node:'fixture-node',oracle:'fixture',psiPath:corrupt});response=await request({target,text:'do not reroute',inbox:true},true,'sender:remote','retry-after-failure');assert.notEqual(response.status,200);assert.equal(files().length,before);assert.equal(files(other).length,1);
 const failedHistory=await (await fetch(url+'/api/feed',{headers:{Authorization:'Bearer '+token}})).json();assert.ok(failedHistory.events.some(e=>e.text==='do not reroute'&&e.state==='failed'&&e.route==='inbox'));
 save(configFile,{node:'fixture-node',oracle:'server-oracle'});response=await request({target,text:'do not reroute',inbox:true},true,'sender:remote','retry-after-failure');assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).deduped,undefined);assert.equal(files().length,before+1);
 rmSync(join(repo,'ψ'),{recursive:true});const outside=join(home,'outside');mkdirSync(outside);symlinkSync(outside,join(repo,'ψ'));response=await request({target,text:'do not escape',inbox:true});assert.notEqual(response.status,200);assert.deepEqual(readdirSync(outside),[]);
 await stop();await start('off');response=await request({target,text:'explicit off',inbox:true});assert.notEqual(response.status,200);await stop();
 const commands=readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);assert.ok(commands.length>0);for(const args of commands){assert.ok(args[0]==='session'||(args[0]==='--session'&&args[2]==='api'&&args[3]==='snapshot'),'unexpected mutation '+JSON.stringify(args));}
 console.log('PASS inbox ('+(native?'native':'bun')+'): live shell queue, no injection, auth/gates, attachments, sender, configured root, stale target and symlink refusal');
}finally{await stop();rmSync(home,{recursive:true,force:true});}
