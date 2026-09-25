#!/usr/bin/env node
// POST /api/send normal delivery against an actual server process and a fake
// herdr: sender tag, input-box refusal, liveness refresh, blocked refusal,
// honest receipts, Enter retry, idempotency and lifecycle records. No live
// herdr daemon is contacted; every herdr call is logged and checked.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const home=realpathSync(mkdtempSync(join(tmpdir(),'herdr-send-smoke-')));
const repo=join(home,'receiver'),configDir=join(home,'config');
for(const p of [repo,configDir])mkdirSync(p);
const stateFile=join(home,'state'),calls=join(home,'calls'),fake=join(home,'herdr');
writeFileSync(join(configDir,'maw.config.50.json'),JSON.stringify({node:'fixture-node',oracle:'server-oracle'}));
const rule='─'.repeat(30);
const box=(text='',extra=[])=>[`● earlier reply`,'',`${rule} ultracode ─`,`❯ ${text}`,rule,'  🖥  fixture footer','  🌱 repo line',...extra].join('\n');
const dimBox=()=>box('\x1b[2m/suggested-command\x1b[0m');
const pane={pane_id:'wD:p4',workspace_id:'wD',agent:'claude',label:'fixture',title:'claude',cwd:repo,focused:true,agent_status:'idle'};
const shell={pane_id:'wD:p9',workspace_id:'wD',agent:'',label:'',title:'zsh',cwd:repo,focused:false,agent_status:'unknown'};
const reset=(over={})=>writeFileSync(stateFile,JSON.stringify({panes:[pane,shell],screens:[],screen:box(),...over}));
reset();
// Screens are a queue: each `pane read` takes the next one, then the default.
// `after` swaps the roster once the first snapshot has been served.
writeFileSync(fake,`#!${process.execPath}
const fs=require('node:fs');const file=${JSON.stringify(stateFile)};let a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');
const s=JSON.parse(fs.readFileSync(file,'utf8'));const save=()=>fs.writeFileSync(file,JSON.stringify(s));
if(a[0]==='session'){console.log(JSON.stringify({result:{sessions:[{name:'main',running:true}]}}));process.exit(0)}
if(a[0]==='--session')a=a.slice(2);
if(a[0]==='api'&&a[1]==='snapshot'){console.log(JSON.stringify({result:{snapshot:{protocol:22,workspaces:[{workspace_id:'wD',label:'demo'}],panes:s.panes}}}));if(s.after){s.panes=s.after;delete s.after;save();}process.exit(0)}
if(a[0]==='pane'&&a[1]==='read'){process.stdout.write(s.screens.length?s.screens.shift():s.screen);save();process.exit(0)}
if(a[0]==='agent'&&a[1]==='prompt'){if(s.afterPrompt){s.screens=s.afterPrompt;delete s.afterPrompt;save();}console.log('{"ok":true}');process.exit(0)}
if(a[0]==='pane'&&a[1]==='send-keys'){if(s.afterEnter){s.screens=s.afterEnter;delete s.afterEnter;save();}process.exit(0)}
console.error('unexpected',a);process.exit(3);
`,{mode:0o700});

const token='fixture-send-operator-secret',tokenFile=join(home,'token');writeFileSync(tokenFile,token,{mode:0o600});
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('MAW_')||key.startsWith('HERDR_')||key.startsWith('TMUX')||key==='PEERS_FILE')delete env[key];
Object.assign(env,{HOME:home,XDG_CONFIG_HOME:join(home,'xdg'),MAW_CONFIG_DIR:configDir,MAW_TEST_MODE:'1',PEERS_FILE:join(home,'absent-peers.json')});
const args=['--token-file',tokenFile,'--listen','127.0.0.1:0','--herdr',fake,'--data-dir',join(home,'ui')];
let running,url;
async function deadline(p,label,ms=15000){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timeout')),ms)})]);}finally{clearTimeout(timer)}}
async function start(){
 const child=spawn('bun',[resolve(process.env.MAW_SEND_ENTRY||'index.mjs'),'serve',...args],{cwd:home,env,stdio:['ignore','pipe','pipe']});
 const exited=new Promise(done=>{child.once('exit',(code,signal)=>done({code,signal}));child.once('error',error=>done({error}));});running={child,exited};child.stdout.resume();let output='';
 url=await deadline(new Promise((done,fail)=>{child.stderr.on('data',d=>{output+=d;const m=output.match(/http:\/\/[^\s]+/);if(m)done(m[0]);});child.once('error',fail);child.once('exit',()=>fail(Error(output)));}),'startup');
}
async function stop(){if(!running)return;const{child,exited}=running;try{child.kill('SIGTERM');assert.equal((await deadline(exited,'shutdown',3000)).code,0);}finally{if(child.exitCode===null){child.kill('SIGKILL');await deadline(exited,'kill',3000);}running=undefined;}}
const send=async(body,{auth=true,from,logical}={})=>{const r=await fetch(url+'/api/send',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{}),...(from?{'X-Maw-From':from}:{}),...(logical?{'X-Maw-Timestamp':logical}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {status:r.status,json:await r.json()};};
const feed=async()=>(await (await fetch(url+'/api/feed',{headers:{Authorization:'Bearer '+token}})).json()).events;
const log=()=>readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);
const prompts=()=>log().filter(c=>c[2]==='agent'&&c[3]==='prompt');
const enters=()=>log().filter(c=>c[2]==='pane'&&c[3]==='send-keys');
const target=Buffer.from('main').toString('base64url')+'/'+Buffer.from('wD').toString('base64url')+':4';
const shellTarget=target.replace(/:4$/,':9');
const tag='[fixture-node:server-oracle] ';
const inspect='herdr --session main pane read wD:p4 --source visible';
try{
 await start();

 // Delivered: the box is empty before and after, and the text carries the local sender tag.
 let r=await send({target,text:'hello'});
 assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(r.json.state,'delivered');assert.equal(r.json.text,'hello');assert.equal(r.json.source,'local');
 assert.deepEqual(r.json.receipt,['herdr agent prompt accepted','input box observed empty after submit']);assert.equal(r.json.lastLine,'  🌱 repo line');
 assert.deepEqual(prompts().at(-1),['--session','main','agent','prompt','wD:p4',tag+'hello']);
 const readCall=log().find(c=>c[3]==='read');assert.deepEqual(readCall,['--session','main','pane','read','wD:p4','--source','visible','--format','ansi']);
 // A dim suggestion is a placeholder, not a draft.
 reset({screen:dimBox()});r=await send({target,text:'past the placeholder'},{from:'neo:white'});assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(r.json.state,'delivered');
 assert.deepEqual(prompts().at(-1).at(-1),'[white:neo] past the placeholder');

 // Attachment-only: literal lines, joined before the empty text, tagged, never read from disk.
 reset();r=await send({target,attachments:['/definitely/not/read.png','second note']});assert.equal(r.status,200,JSON.stringify(r.json));
 assert.equal(r.json.text,'/definitely/not/read.png\nsecond note\n');assert.equal(prompts().at(-1).at(-1),'/definitely/not/read.png\nsecond note\n','legacy: an absolute-path first line skips the tag');
 r=await send({target,attachments:['note one','note two']});assert.equal(prompts().at(-1).at(-1),tag+'note one\nnote two\n');

 // Queued: the agent says the prompt waits behind a running turn.
 reset({afterPrompt:[box('',['  Press up to edit queued messages'])]});r=await send({target,text:'while busy'});
 assert.equal(r.json.state,'queued');assert.ok(r.json.receipt.includes('agent shows the prompt as queued'));

 // Enter retry: our own text stays in the box, one more Enter clears it.
 reset({afterPrompt:[box(tag+'swallowed enter'),box(tag+'swallowed enter')],afterEnter:[box()]});let before=enters().length;
 r=await send({target,text:'swallowed enter'});assert.equal(r.json.state,'delivered',JSON.stringify(r.json));assert.ok(r.json.receipt.includes('Enter retried once'));
 assert.equal(enters().length,before+1);assert.deepEqual(enters().at(-1),['--session','main','pane','send-keys','wD:p4','enter']);
 // Still stuck after the retry: accepted, explicitly unconfirmed; no second retry.
 const stuck=box(tag+'stuck');reset({afterPrompt:[stuck,stuck,stuck,stuck],afterEnter:[stuck,stuck]});before=enters().length;
 r=await send({target,text:'stuck'});assert.equal(r.json.state,'accepted');assert.ok(r.json.receipt.at(-1).includes('delivery not confirmed'));assert.equal(enters().length,before+1);
 // Someone else's text appears: accepted, unconfirmed, never an Enter on their draft.
 reset({afterPrompt:[box('somebody else typing')]});before=enters().length;
 r=await send({target,text:'mine'});assert.equal(r.json.state,'accepted');assert.ok(r.json.receipt.includes('input box holds different text after submit; delivery not confirmed'));assert.equal(enters().length,before);
 // No recognisable box at all: accepted, never "delivered".
 reset({screen:'plain output\nno prompt here\n'});r=await send({target,text:'blind'});assert.equal(r.json.state,'accepted');assert.ok(r.json.receipt.includes('no input box recognised; delivery not confirmed'));

 // Refusals: nothing is typed, the body names the command that shows why.
 const refused=async(setup,body,status,error,hint)=>{reset(setup);const n=prompts().length;const res=await send(body);assert.equal(res.status,status,JSON.stringify(res.json));
  assert.equal(res.json.error,error);assert.equal(res.json.ok,false);assert.equal(res.json.state,'failed');assert.equal(res.json.target,body.target);assert.equal(res.json.hint,hint);assert.ok(res.json.detail);assert.equal(prompts().length,n,'refused delivery must not prompt');};
 await refused({screen:box('half-written draft')},{target,text:'x'},409,'composer_not_empty',inspect);
 await refused({panes:[{...pane,agent_status:'blocked'},shell]},{target,text:'x'},409,'target_blocked',inspect);
 await refused({after:[{...pane,cwd:home},shell]},{target,text:'x'},409,'target_changed','herdr --session main agent list');
 await refused({after:[{...pane,agent:'codex'},shell]},{target,text:'x'},409,'target_changed','herdr --session main agent list');
 await refused({after:[{...pane,agent_status:'blocked'},shell]},{target,text:'x'},409,'target_blocked',inspect);
 await refused({},{target:shellTarget,text:'x'},409,'target_not_agent','herdr --session main agent list');
 await refused({},{target:Buffer.from('main').toString('base64url')+'/'+Buffer.from('wD').toString('base64url')+':7',text:'x'},404,'target_not_found','herdr --session main agent list');
 await refused({},{target:'not-a-target',text:'x'},404,'target_not_found','herdr session list');
 reset();r=await send({target,text:'x'},{auth:false});assert.equal(r.status,401);
 r=await send({target,text:'x',force:true});assert.equal(r.status,501);
 r=await send({target,text:'x'},{from:'x'.repeat(1025)});assert.equal(r.status,400);assert.equal(r.json.error,'invalid_delivery_metadata');

 // Idempotency keeps the observed state: a retry of a delivered prompt says delivered, not accepted.
 reset();before=prompts().length;
 const retries=await Promise.all([0,1].map(()=>send({target,text:'once only'},{from:'neo:white',logical:'fixture-ts-1'})));
 assert.equal(prompts().length,before+1);const dup=retries.find(x=>x.json.deduped);assert.ok(dup,JSON.stringify(retries));
 const first=retries.find(x=>!x.json.deduped);assert.equal(first.json.state,'delivered');
 const again=await send({target,text:'once only'},{from:'neo:white',logical:'fixture-ts-1'});assert.equal(again.json.deduped,true);assert.equal(again.json.state,'delivered');assert.deepEqual(again.json.receipt,['duplicate_dropped']);
 // A refused attempt releases its key: the same timestamp can succeed once the draft is gone.
 reset({screen:box('draft')});r=await send({target,text:'after draft'},{from:'neo:white',logical:'fixture-ts-2'});assert.equal(r.status,409);
 reset();r=await send({target,text:'after draft'},{from:'neo:white',logical:'fixture-ts-2'});assert.equal(r.status,200);assert.equal(r.json.deduped,undefined);assert.equal(r.json.state,'delivered');

 // Lifecycle records: every outcome, with the error code or the last line, and no token.
 const events=await feed();
 const byText=t=>events.filter(e=>e.text===t);
 assert.deepEqual(byText('hello').map(e=>[e.kind,e.state,e.route,e.from,e.lastLine]),[['context.message','delivered','local','fixture-node:server-oracle','  🌱 repo line']]);
 assert.equal(byText('past the placeholder')[0].from,'neo:white');
 assert.deepEqual(byText('while busy').map(e=>e.state),['queued']);
 assert.deepEqual(byText('once only').map(e=>e.state).sort(),['deduped','deduped','delivered']);
 assert.deepEqual(byText('after draft').map(e=>[e.state,e.error]),[['failed','composer_not_empty'],['delivered',undefined]]);
 const failed=events.filter(e=>e.state==='failed'&&e.route==='local').map(e=>e.error);
 for(const code of ['composer_not_empty','target_blocked','target_changed','target_not_agent','target_not_found'])assert.ok(failed.includes(code),code+' '+JSON.stringify(failed));
 assert.ok(events.filter(e=>e.state==='failed').every(e=>e.kind==='message'));
 assert.ok(!JSON.stringify(events).includes(token));

 // Only reads, prompts and the one kind of Enter retry ever reached herdr.
 for(const c of log()){const v=c[0]==='--session'?c.slice(2):c;assert.ok((v[0]==='session'&&v[1]==='list')||(v[0]==='api'&&v[1]==='snapshot')||(v[0]==='pane'&&v[1]==='read')||(v[0]==='agent'&&v[1]==='prompt')||(v[0]==='pane'&&v[1]==='send-keys'&&v[3]==='enter'),'unexpected herdr call '+JSON.stringify(c));}
 await stop();
 console.log('PASS send delivery ('+(process.env.MAW_SEND_ENTRY?'bundle':'source')+'): sender tag, attachment-only, placeholder vs draft, blocked/changed/shell/missing refusals with hints, delivered/queued/accepted receipts, one Enter retry, idempotent state, lifecycle records');
}finally{await stop();rmSync(home,{recursive:true,force:true});}
