#!/usr/bin/env bun
// Actual source/bundled processes, isolated fake Herdr, no PATH tools or Go.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { createServer } from 'node:net';

assert.ok(process.versions.bun, 'run with Bun');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'maw-bun-serve-')));
const bun = process.execPath;
const token = 'isolated-smoke-operator-token-12345';
const tokenFile = join(temporary, 'token');
const log = join(temporary, 'calls.jsonl');
const failure = join(temporary, 'failure');
const fake = join(temporary, 'herdr');
const target = 'bWFpbg/d0Q:4', shell = 'bWFpbg/d0Q:9';
// Same protocol-22 roster and envelopes as server/backend_test.go.
const sessions = [{ name: 'bWFpbg/d0Q', source: 'local', windows: [
  { index: 4, name: 'codex', active: true, cwd: '/tmp', status: 'idle' },
  { index: 9, name: 'wD:p9', active: false, status: 'unknown' },
] }];
const children = new Set(), sockets = new Set();
let checks = 0;
const env = { ...process.env, PATH: '/nonexistent', HOME: join(temporary, 'home'), XDG_CACHE_HOME: join(temporary, 'cache') };
delete env.MAW_HERDR_SERVE_BIN;
mkdirSync(env.HOME);
writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
writeFileSync(fake, `#!${bun}
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (existsSync(${JSON.stringify(failure)})) { console.error('fixture unavailable'); process.exit(7); }
if (JSON.stringify(args) === JSON.stringify(['session','list','--json'])) console.log(JSON.stringify({sessions:[{name:'main',running:true},{name:'stopped',running:false}]}));
else if (args[2] === 'api') console.log(JSON.stringify({result:{snapshot:{protocol:22,workspaces:[{workspace_id:'wD',label:'demo'}],panes:[{pane_id:'wD:p4',workspace_id:'wD',agent:'codex',focused:true,agent_status:'idle',cwd:'/tmp'},{pane_id:'wD:p9',workspace_id:'wD',agent:null,focused:false,agent_status:'unknown'}]}}}));
else if (args[2] === 'pane') process.stdout.write('visible output\\n');
else if (args[2] === 'agent') console.log('{"ok":true}');
else { console.error('unexpected args', args); process.exit(8); }
`);
chmodSync(fake, 0o700);

function deadline(promise, label, ms = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}
async function start(entry, dataDir, enginePort) {
  const args = enginePort ? ['--engine'] : ['--token-file', tokenFile, '--listen', '127.0.0.1:0'];
  const childEnv = enginePort ? {...env, MAW_SERVE_TOKEN:token, MAW_ENGINE_SERVE_PORT:String(enginePort), MAW_ENGINE_SERVE_PREFIX:'/api/herdr', PORT:String(enginePort)} : env;
  const child = spawn(bun, [entry, 'serve', ...args, '--herdr', fake, '--data-dir', dataDir], { env:childEnv, cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.exited = new Promise((resolveExit, reject) => { child.once('exit', (code, signal) => resolveExit({code, signal})); child.once('error', reject); });
  let output = '';
  const url = await deadline(new Promise((resolveURL, reject) => {
    const chunk = data => {
      output += data;
      const match = output.match(/maw herdr serve: (http:\/\/[^\s]+) \(Bun\/TypeScript;/);
      if (match) resolveURL(match[1]);
    };
    child.stdout.on('data', chunk); child.stderr.on('data', chunk);
    child.once('exit', () => reject(new Error(`server exited before Bun startup: ${output}`)));
    child.once('error', reject);
  }), 'Bun startup');
  return { child, url:new URL(url).origin };
}
async function http(url, path, { status = 200, auth = true, headers = {}, method = 'GET', body } = {}) {
  const result = await deadline(new Promise((resolveResponse, reject) => {
    const req = request(new URL(path, url), { method, headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? {'Content-Type':'application/json'} : {}), ...headers } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolveResponse({status:res.statusCode, headers:res.headers, raw, json:raw ? JSON.parse(raw) : undefined}); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  }), path);
  assert.equal(result.status, status, `${path}: ${result.raw}`); checks++;
  return result;
}
async function socket(url, ticket, path = '/ws') {
  const ws = new WebSocket(url.replace('http:', 'ws:') + path, { protocols: ticket ? ['maw.ws.v1', ticket] : [], headers: ticket ? { Origin: url } : {} });
  sockets.add(ws);
  const queue = [];
  let pending;
  ws.addEventListener('message', event => { const value = JSON.parse(event.data); if (pending) { const done = pending; pending = null; done(value); } else queue.push(value); });
  ws.next = () => deadline(queue.length ? Promise.resolve(queue.shift()) : new Promise(resolveFrame => { pending = resolveFrame; }), 'WebSocket frame');
  ws.closed = new Promise(resolveClose => ws.addEventListener('close', resolveClose));
  await deadline(new Promise((done, fail) => { ws.addEventListener('open', done); ws.addEventListener('error', () => fail(new Error('WebSocket handshake failed'))); }), 'WebSocket open');
  assert.equal(ws.protocol, ticket ? 'maw.ws.v1' : '');
  return ws;
}
async function exercise(entry, label) {
  const dataDir = join(temporary, label);
  const {child, url} = await start(entry, dataDir);
  const origin = { Origin: url };
  assert.deepEqual((await http(url, '/api/sessions')).json, sessions);
  assert.deepEqual((await http(url, '/api/capture?target=' + encodeURIComponent(target))).json, {content:'visible output\n'});
  assert.deepEqual((await http(url, '/api/captures')).json, {captures:{[target]:'visible output\n',[shell]:'visible output\n'}});
  assert.deepEqual((await http(url, '/api/agents')).json,{node:'herdr',count:2,agents:[
    {node:'herdr',session:'bWFpbg/d0Q',window:'4',oracle:'codex',state:'idle',pid:null},
    {node:'herdr',session:'bWFpbg/d0Q',window:'9',oracle:'wD:p9',state:'idle',pid:null},
  ]});
  assert.deepEqual((await http(url, '/api/agent')).json, (await http(url, '/api/agents')).json);
  assert.deepEqual((await http(url, '/api/config')).json, {node:'herdr',agents:{},namedPeers:[]});
  const identity = (await http(url, '/api/identity')).json;
  assert.deepEqual(identity.endpoints, ['/api/sessions','/api/capture','/api/send','/ws']);
  assert.ok(identity.capabilities.includes('dashboard-ws'));
  for (const [path, empty, value, invalid] of [['/api/ui-state',{}, {selected:target}, []], ['/api/asks',[],[{text:'hello'}],{}]]) {
    assert.deepEqual((await http(url,path)).json,empty);
    assert.deepEqual((await http(url,path,{method:'POST',body:value})).json,{ok:true});
    assert.deepEqual((await http(url,path)).json,value);
    await http(url,path,{method:'POST',body:invalid,status:400});
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir,path.endsWith('asks')?'asks.json':'ui-state.json'),'utf8')),value);
  }
  const text = 'literal; $(touch never)\n--wait';
  const sent = (await http(url,'/api/send',{method:'POST',body:{target,text}})).json;
  assert.equal(sent.state,'accepted'); assert.equal(sent.text,text); assert.equal(sent.ok,true);
  assert.ok(readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).some(args => JSON.stringify(args) === JSON.stringify(['--session','main','agent','prompt','wD:p4',text])));
  assert.equal(existsSync(join(temporary,'never')),false);
  for (const [body,status,error] of [[{target:shell,text:'x'},409,'target_not_agent'],[{target:'missing',text:'x'},404,'target_not_found'],[{target,text:'x',force:true},501,'send_options_not_supported'],[{target,text:''},400,'target_and_text_required'],[{target,text:'x',unknown:1},400,'invalid_json']]) {
    assert.equal((await http(url,'/api/send',{method:'POST',body,status})).json.error,error);
  }
  await http(url,'/api/send',{method:'POST',body:'x',headers:{'Content-Type':'text/plain'},status:415});
  await http(url,'/api/send',{method:'POST',body:{target,text:'x'.repeat(65537)},status:400});
  await http(url,'/api/sessions',{auth:false,status:401});
  await http(url,'/api/sessions',{headers:{Authorization:'Bearer wrong'},status:401});
  await http(url,'/api/sessions',{headers:{Host:'evil.example'},status:403});
  await http(url,'/api/sessions',{headers:{Origin:'https://evil.example'},status:403});
  await http(url,'/api/config?remote=1',{status:400});
  await http(url,'/api/capture',{status:400});
  assert.equal((await http(url,'/api/capture?target=missing')).json.error,'capture_unavailable');
  const cors = await http(url,'/api/sessions',{headers:origin});
  assert.equal(cors.headers['access-control-allow-origin'],url);
  const preflight = await http(url,'/api/send',{auth:false,method:'OPTIONS',headers:{...origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization, Content-Type','Access-Control-Request-Private-Network':'true'},status:204});
  assert.equal(preflight.headers['access-control-allow-private-network'],'true');
  await http(url,'/api/send',{auth:false,method:'OPTIONS',headers:{...origin,'Access-Control-Request-Method':'DELETE'},status:403});
  writeFileSync(failure,'offline');
  assert.equal((await http(url,'/api/sessions',{status:503})).json.error,'herdr_unavailable');
  rmSync(failure);
  const mint = async () => (await http(url,'/api/auth/ws-ticket',{method:'POST',headers:origin,body:{path:'/ws'}})).json;
  await http(url,'/api/auth/ws-ticket',{method:'POST',body:{path:'/ws'},status:400});
  await http(url,'/api/auth/ws-ticket',{auth:false,method:'POST',headers:origin,body:{path:'/ws'},status:401});
  const ticket = await mint();
  assert.equal(ticket.protocol,'maw.ws.v1'); assert.match(ticket.ticket,/^mwt1_[a-f0-9]{64}$/);
  await http(url,'/ws',{auth:false,headers:origin,status:401});
  await http(url,'/ws',{auth:false,status:400});
  await http(url,'/ws?ticket='+ticket.ticket,{auth:false,headers:origin,status:400});
  await http(url,'/ws',{auth:false,headers:{...origin,'Sec-WebSocket-Protocol':`other.protocol, ${ticket.ticket}`},status:401});
  await http(url,'/ws',{auth:false,headers:{Origin:'http://localhost:9999','Sec-WebSocket-Protocol':`maw.ws.v1, ${ticket.ticket}`},status:401});
  const ws = await socket(url,ticket.ticket);
  assert.deepEqual(await ws.next(),{type:'feed-history',events:[]});
  assert.deepEqual(await ws.next(),{type:'sessions',sessions});
  assert.equal((await ws.next()).type,'recent');
  await http(url,'/ws',{auth:false,headers:{...origin,'Sec-WebSocket-Protocol':`maw.ws.v1, ${ticket.ticket}`},status:401});
  ws.send(JSON.stringify({type:'select',target}));
  assert.deepEqual(await ws.next(),{type:'capture',target,content:'visible output\n'});
  ws.send(JSON.stringify({type:'subscribe-previews',targets:[shell]}));
  assert.deepEqual(await ws.next(),{type:'previews',data:{[shell]:'visible output\n'}});
  ws.send(JSON.stringify({type:'send',target,text}));
  assert.deepEqual(await ws.next(),{type:'sent',ok:true,target,text,state:'accepted'});
  for (const [command,error] of [[{type:'send',target:shell,text:'x'},'send_failed'],[{type:'send',target,text:'x',inbox:true},'send_options_not_supported'],[{type:'subscribe-previews',targets:Array(17).fill(target)},'too_many_previews'],[{type:'select',target:''},'subscription_invalid'],[{type:'unknown'},'command_not_supported']]) {
    ws.send(JSON.stringify(command)); assert.deepEqual(await ws.next(),{type:'error',error});
  }
  ws.send(JSON.stringify({type:'select',extra:true}));
  assert.equal((await deadline(ws.closed,'invalid command close')).code,1008);
  sockets.delete(ws);
  const oversized = await socket(url,(await mint()).ticket);
  await oversized.next(); await oversized.next(); await oversized.next();
  const promptsBefore = readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(args => args[2] === 'agent').length;
  oversized.send(JSON.stringify({type:'send',target,text:'x'.repeat(65537)}));
  // Bun's transport payload gate can report abnormal close (1006), unlike Go's
  // explicit 1009. Both must close without executing the oversized command.
  assert.ok([1006,1009].includes((await deadline(oversized.closed,'oversized close')).code));
  const promptsAfter = readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(args => args[2] === 'agent').length;
  assert.equal(promptsAfter,promptsBefore);
  sockets.delete(oversized);
  const live = await socket(url,(await mint()).ticket);
  await live.next(); await live.next(); await live.next();
  child.kill('SIGTERM');
  const exit = await deadline(child.exited,'SIGTERM exit');
  assert.equal(exit.signal,null); assert.equal(exit.code,0);
  await deadline(live.closed,'shutdown socket close'); sockets.delete(live); children.delete(child);
  console.log(`PASS ${label}: HTTP contracts/security/state, WS tickets/frames/limits, graceful SIGTERM`);
}
async function exerciseEngine(entry, label) {
  // Engine requires a concrete parent-assigned port, not :0. Reserve an unused
  // loopback port then release it immediately before spawning the actual child.
  const reservation = createServer();
  await new Promise((done, fail) => { reservation.once('error',fail); reservation.listen(0,'127.0.0.1',done); });
  const port = reservation.address().port;
  await new Promise((done, fail) => reservation.close(error => error ? fail(error) : done()));
  const {child,url} = await start(entry,join(temporary,label+'-engine'),port);
  assert.deepEqual((await http(url,'/api/herdr/sessions',{auth:false})).json,sessions);
  assert.deepEqual((await http(url,'/api/herdr',{auth:false})).json.endpoints,['/api/herdr/sessions','/api/herdr/capture','/api/herdr/send','/api/herdr/ws']);
  await http(url,'/api/sessions',{auth:false,status:404});
  await http(url,'/api/herdrish/sessions',{auth:false,status:404});
  await http(url,'/api/herdr/auth/ws-ticket',{auth:false,status:501});
  await http(url,'/api/herdr/sessions',{auth:false,headers:{Host:'evil.example'},status:403});
  for (const Origin of ['',url,'https://god.buildwithoracle.com']) {
    await http(url,'/api/herdr/sessions',{auth:false,headers:{Origin},status:403});
  }
  const ws = await socket(url,undefined,'/api/herdr/ws');
  assert.deepEqual(await ws.next(),{type:'feed-history',events:[]});
  assert.deepEqual(await ws.next(),{type:'sessions',sessions});
  assert.equal((await ws.next()).type,'recent');
  ws.send(JSON.stringify({type:'select',target}));
  assert.deepEqual(await ws.next(),{type:'capture',target,content:'visible output\n'});
  child.kill('SIGTERM');
  assert.deepEqual(await deadline(child.exited,'engine shutdown'),{code:0,signal:null});
  await deadline(ws.closed,'engine socket shutdown'); sockets.delete(ws); children.delete(child);
  console.log(`PASS ${label} engine: prefixed routes, loopback Host and no-browser-Origin boundary, local WS, shutdown`);
}
try {
  const missing = spawnSync(bun,[join(root,'index.mjs'),'serve','--token-file',join(temporary,'missing')],{env,encoding:'utf8',timeout:10000});
  assert.ifError(missing.error); assert.notEqual(missing.status,0); assert.equal(existsSync(join(temporary,'missing')),false);
  for (const [name, contents, mode] of [['short','short',0o600],['public',token,0o644]]) {
    const path = join(temporary,name);
    writeFileSync(path,contents,{mode});
    const rejected = spawnSync(bun,[join(root,'index.mjs'),'serve','--runtime','bun','--token-file',path],{env,encoding:'utf8',timeout:10000});
    assert.ifError(rejected.error); assert.equal(rejected.status,1,rejected.stderr);
    assert.match(rejected.stderr,/token/i);
  }
  await exerciseEngine(join(root,'index.mjs'),'source');
  await exercise(join(root,'index.mjs'),'source');
  const bundle = join(temporary,'index.js');
  const build = spawnSync(bun,['build',join(root,'index.mjs'),'--target=bun','--outfile',bundle],{env,encoding:'utf8',timeout:30000});
  assert.ifError(build.error); assert.equal(build.status,0,build.stderr);
  await exercise(bundle,'bundle');
  await exerciseEngine(bundle,'bundle');
  console.log(`PASS: ${checks} HTTP assertions; source and bundled default run without PATH tools or Go`);
} finally {
  for (const ws of sockets) ws.close();
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled([...children].map(child => child.exited));
  rmSync(temporary,{recursive:true,force:true});
}
