#!/usr/bin/env node
// Real Bun/native processes, disposable config trees and one local peer only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const home = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-config-smoke-')));
const write = (path, value) => { mkdirSync(join(path, '..'), {recursive:true}); writeFileSync(path, JSON.stringify(value)); };
const seen = [];
const peer = createServer((req,res) => { seen.push(req.headers); res.end('[{"name":"config-peer"}]'); });
await new Promise(done=>peer.listen(0,'127.0.0.1',done));
const peerURL='http://127.0.0.1:'+peer.address().port;
const token='fixture-config-operator-token-private', fleet='fixture-config-fleet-token-private', key='fixture-peer-key';
const cwd=join(home,'project','child'), instance=join(home,'instance'), xdg=join(home,'xdg');
mkdirSync(cwd,{recursive:true});
write(join(xdg,'maw','maw.config.10.json'), {node:'singleton',oracle:'configured-oracle',federationToken:'old-secret',
  agents:{inherited:'inherited-node',removed:'old-node'},namedPeers:[{name:'keep',url:peerURL+'/keep',secret:'never-return'},{name:'replace',url:peerURL+'/old',token:'never-return'}],
  env:{CLAUDE_CODE_OAUTH_TOKEN:'never-return'},tokenPool:['never-return'],hooks:{private:'never-return'}});
write(join(instance,'config','maw.config.50.json'), {node:'instance',agents:{removed:null,own:'own-node',invalid:7},
  namedPeers:[{name:'replace',url:peerURL+'/new'}]});
write(join(home,'project','.maw','maw.config.20.json'),{node:'low-project'});
write(join(cwd,'.maw','maw.config.80.local.json'), {node:'project',agents:{project:'project-node'},
  namedPeers:[{name:'project',url:peerURL+'/project'},{name:'unsafe',url:'http://user:private@127.0.0.1:1'}]});
const high=join(instance,'config','maw.config.100.json');
write(high,{node:'configured-node',federationToken:' '+fleet+' ',namedPeers:[]});
write(join(cwd,'.maw','maw.config.json'),{node:'unnumbered-project-must-not-load'});
const tokenFile=join(home,'token');writeFileSync(tokenFile,token,{mode:0o600});
const peersFile=join(home,'peers.json');write(peersFile,{version:1,peers:{replace:{url:peerURL+'/new'}}});
const env={...process.env,HOME:home,XDG_CONFIG_HOME:xdg,HOSTNAME:'fallback-node'};
for(const name of Object.keys(env))if(name.startsWith('MAW_')||name==='PEERS_FILE')delete env[name];
Object.assign(env,{MAW_HOME:instance,MAW_PEER_KEY:key,MAW_FEDERATION_TOKEN:' ',PEERS_FILE:peersFile});
const native=process.argv[2], args=['--token-file',tokenFile,'--listen','127.0.0.1:0','--herdr',join(home,'never-execute'),'--data-dir',join(home,'ui')];
const child=spawn(native?resolve(native):'bun',native?args:[resolve(process.env.MAW_CONFIG_ENTRY||'index.mjs'),'serve',...args],{cwd,env,stdio:['ignore','pipe','pipe']});
let output='';const exited=new Promise(done=>child.once('exit',(code,signal)=>done({code,signal})));
const deadline=async(p,label)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timeout')),10000)})]);}finally{clearTimeout(timer)}};
try{
 const url=await deadline(new Promise((done,fail)=>{child.stderr.on('data',d=>{output+=d;const m=output.match(/http:\/\/[^\s]+/);if(m)done(m[0]);});child.once('error',fail);child.once('exit',()=>fail(Error(output)));}),'startup');
 const get=path=>fetch(url+path,{headers:{Authorization:'Bearer '+token,Origin:url},signal:AbortSignal.timeout(10000)});
 const response=await get('/api/config');assert.equal(response.status,200,await response.clone().text());
 const config=await response.json();
 assert.deepEqual(config,{node:'configured-node',agents:{inherited:'inherited-node',own:'own-node',project:'project-node'},namedPeers:[
  {name:'keep',url:peerURL+'/keep'},{name:'replace',url:peerURL+'/new'},{name:'project',url:peerURL+'/project'}]});
 for(const forbidden of [token,fleet,'never-return','CLAUDE_CODE_OAUTH_TOKEN','federationToken','tokenPool','hooks','sourcePaths'])assert.ok(!JSON.stringify(config).includes(forbidden),'private config leaked');
 assert.equal((await (await get('/api/identity')).json()).node,'configured-node');
 assert.equal((await get('/api/config?raw=1')).status,400);
 assert.equal(seen.length,0,'display never probes peers');
 const first=await get('/api/federation/status');assert.equal(first.status,200,await first.clone().text());assert.equal((await first.json()).reachablePeers,1);
 assert.equal(seen.length,1);
 const signature=(secret,payload)=>createHmac('sha256',secret).update(payload).digest('hex');
 const verify=(headers,secret)=>{
  assert.equal(headers.authorization,undefined);assert.equal(headers['x-maw-from'],'configured-oracle:configured-node');
  assert.equal(headers['x-maw-signature'],signature(secret,'GET:/api/sessions:'+headers['x-maw-timestamp']));
  assert.equal(headers['x-maw-signature-v3'],signature(key,'GET:/api/sessions:'+headers['x-maw-timestamp']+'::configured-oracle:configured-node'));
 };
 verify(seen[0],fleet);
 // Public config remains its startup projection; private credentials reload and invalidate cache.
 write(high,{node:'configured-node',federationToken:'rotated-fixture-fleet',agents:{own:'changed'},namedPeers:[]});
 assert.deepEqual(await (await get('/api/config')).json(),config);
 const second=await get('/api/federation/status');assert.equal(second.status,200);await second.text();
 assert.equal(seen.length,2,'credential changes invalidate status cache');verify(seen[1],'rotated-fixture-fleet');
 child.kill('SIGTERM');assert.equal((await deadline(exited,'shutdown')).code,0);
 console.log('PASS config ('+(native?'native':'bun')+'): layers/order/merge, safe startup projection, configured signing, private credential reload, no secrets/operator token forwarding');
}finally{
 if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([exited,new Promise(done=>setTimeout(done,1500))]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
 peer.closeAllConnections();await new Promise(done=>peer.close(done));rmSync(home,{recursive:true,force:true});
}
