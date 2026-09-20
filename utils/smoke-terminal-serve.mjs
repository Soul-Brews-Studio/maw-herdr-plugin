#!/usr/bin/env bun
// Contract fixture only: never connects to a real user Herdr daemon.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'herdr-terminal-smoke-'));
const token = 'isolated-terminal-smoke-token-123456';
const tokenFile = join(root, 'token'), fake = join(root, 'herdr'), calls = join(root, 'calls');
const target = 'bWFpbg/d0Q:9';
writeFileSync(tokenFile, token, { mode: 0o600 });
writeFileSync(fake, `#!${process.execPath}
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const a=process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');
if(a[0]==='session') console.log(JSON.stringify({sessions:[{name:'main',running:true}]}));
else if(a[2]==='api') console.log(JSON.stringify({result:{snapshot:{protocol:22,workspaces:[{workspace_id:'wD'}],panes:[{pane_id:'wD:p9',workspace_id:'wD',agent:null,focused:true,agent_status:'unknown'}]}}}));
else if(a[2]==='terminal') {
 const emit=(text)=>setTimeout(()=>console.log(JSON.stringify({type:'terminal.frame',bytes:Buffer.from(text).toString('base64'),encoding:'ansi',full:false,width:80,height:24,seq:1})),100);
 emit('TERMINAL_READY');
 const rl=createInterface({input:process.stdin});
 rl.on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(calls)},JSON.stringify(m)+'\\n');if(m.type==='terminal.input')emit('INPUT:'+Buffer.from(m.bytes,'base64').toString());if(m.type==='terminal.resize')emit('SIZE:'+m.cols+'x'+m.rows)});
 rl.on('close',()=>{appendFileSync(${JSON.stringify(calls)},'"DETACHED"\\n');console.log(JSON.stringify({type:'terminal.closed',reason:'detached'}));});
} else process.exit(7);
`, { mode: 0o700 });
const native = process.argv[2];
const argv = ['--token-file',tokenFile,'--listen','127.0.0.1:0','--herdr',fake,'--data-dir',join(root,'state')];
const child = spawn(native ? resolve(native) : process.execPath, native ? argv : [resolve(process.env.MAW_TERMINAL_ENTRY || 'index.mjs'),'serve',...argv], {env:{...process.env,HOME:root,MAW_HERDR_SERVE_BIN:''},stdio:['ignore','pipe','pipe']});
let log='';const sockets=[];
const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
const timeout=(p,label)=>{let t;return Promise.race([p,new Promise((_,r)=>t=setTimeout(()=>r(Error(label+' timed out')),10000))]).finally(()=>clearTimeout(t));};
try {
 const url=await timeout(new Promise((done,fail)=>{child.stderr.on('data',d=>{log+=d;const m=log.match(/http:\/\/[^\s]+/);if(m)done(m[0])});child.once('error',fail);child.once('exit',()=>fail(Error(log)));}), 'startup');
 const request=async(path,body,auth=true)=>fetch(url+path,{method:body?'POST':'GET',headers:{Origin:url,...(auth?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const ticket=async(path)=>{const r=await request('/api/auth/ws-ticket',{path});assert.equal(r.status,200,await r.clone().text());return (await r.json()).ticket};
 assert.equal((await request('/ws/pty',null,false)).status,401);
 const wrong=await ticket('/ws');
 const denied=await fetch(url+'/ws/pty',{headers:{Origin:url,'Sec-WebSocket-Protocol':'maw.ws.v1, '+wrong}});
 assert.equal(denied.status,401,'dashboard ticket cannot authorize PTY');
 const key=await ticket('/ws/pty');
 const ws=new WebSocket(url.replace('http:','ws:')+'/ws/pty',{protocols:['maw.ws.v1',key],headers:{Origin:url}});sockets.push(ws);ws.binaryType='arraybuffer';
 const frames=[];let waiting;
 ws.onmessage=e=>{const data=typeof e.data==='string'?JSON.parse(e.data):Buffer.from(e.data).toString();if(waiting){const done=waiting;waiting=null;done(data)}else frames.push(data)};
 const next=()=>timeout(frames.length?Promise.resolve(frames.shift()):new Promise(done=>waiting=done),'frame');
 await timeout(new Promise((done,fail)=>{ws.onopen=done;ws.onerror=fail}),'open');
 ws.send(JSON.stringify({type:'attach',target,cols:80,rows:24}));
 // Live XTerminal sends keys on WS.OPEN, before the first output/attached event.
 ws.send(Buffer.from('early'));
 const first=[await next(),await next(),await next()];assert.ok(first.some(x=>x?.type==='attached'));assert.ok(first.includes('TERMINAL_READY'));assert.ok(first.includes('INPUT:early'));
 ws.send(Buffer.from('hello\r'));assert.equal(await next(),'INPUT:hello\r');
 ws.send(JSON.stringify({type:'resize',cols:90,rows:30}));assert.equal(await next(),'SIZE:90x30');
 const replay=await fetch(url+'/ws/pty',{headers:{Origin:url,'Sec-WebSocket-Protocol':'maw.ws.v1, '+key}});assert.equal(replay.status,401);
 ws.close();await new Promise(r=>setTimeout(r,200));
 child.kill('SIGTERM');const result=await timeout(exited,'shutdown');assert.equal(result.code,0,JSON.stringify(result));
 const recorded=readFileSync(calls,'utf8');assert.match(recorded,/terminal/);assert.match(recorded,/terminal.input/);assert.match(recorded,/terminal.resize/);
 console.log('PASS terminal serve: auth, path-bound tickets, attach, binary I/O, resize, replay rejection, shutdown ('+(native?'native':'bun')+')');
} finally {
 for(const ws of sockets)ws.close();
 if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,1500))]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}}
 rmSync(root,{recursive:true,force:true});
}
