#!/usr/bin/env bun
// Actual source/bundled processes and isolated fake Herdr. Core needs no PATH tools; worktree fixtures explicitly require Git, never Go.
import assert from 'node:assert/strict';
import { createSocketSession } from '../src/serve/bun/mod.createSocketSession.ts';
import { createHerdrBackend } from '../src/serve/bun/mod.createHerdrBackend.ts';
import { createObservedFeed } from '../src/serve/bun/mod.createObservedFeed.ts';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { createServer } from 'node:net';

// Deterministic bounded-ring checks supplement the real source/bundle sockets below.
{
  const feed = createObservedFeed(), now = 1700000000000;
  const roster = (status = 'working', extra = []) => [{name:'bWFpbg/d0Q', source:'local', windows:[{index:4,name:'codex',agent:'codex',active:true,status}, ...extra]}];
  feed.observe(roster(), now);
  const first = feed.read(0, now);
  assert.equal(first.events.length, 1); assert.equal(first.events[0].event, 'PreToolUse');
  assert.equal(first.events[0].timestamp, new Date(now).toISOString());
  assert.equal(first.events[0].host, 'local'); assert.equal(first.events[0].sessionId, '');
  feed.observe(roster(), now + 1); // Second client observing same roster emits no duplicate.
  assert.equal(feed.read(first.cursor, now + 1).events.length, 0);
  assert.equal(feed.read(0, now + 1).events.length, 1); // Independent replay cursor.
  feed.observe(roster(), now + 10000);
  assert.equal(feed.read(first.cursor, now + 10000).events.length, 1);
  for (const [index, status] of ['idle','blocked','done'].entries()) {
    const before = feed.read(0, now + 11000 + index).cursor;
    feed.observe(roster(status), now + 11000 + index);
    const event = feed.read(before, now + 11000 + index).events[0];
    assert.equal(event.event, 'Stop'); assert.equal(event.observedState, status);
  }
  feed.observe(roster('unknown'), now + 12000); assert.equal(feed.read(0, now + 12000).events.length, 0);
  const shell = {index:9,name:'codex',active:false,status:'working'};
  feed.observe(roster('working',[shell]), now + 13000); assert.equal(feed.read(0, now + 13000).events.length, 0);
  feed.observe(roster('working',[{...shell,name:'codex-oracle'}]), now + 14000); assert.equal(feed.read(0, now + 14000).events.length, 0);
  feed.observe([{...roster()[0],name:'project-wt-other'}], now + 15000); assert.equal(feed.read(0, now + 15000).events.length, 0);
  for (let index = 0; index < 105; index++) feed.observe(roster(index % 2 ? 'idle' : 'working'), now + 16000 + index);
  assert.equal(feed.read(0, now + 16105).events.length, 100);
  assert.equal(feed.read(0, now + 76105).events.length, 0);
  feed.observe([], now + 77000); feed.observe(roster(), now + 77001);
  assert.equal(feed.read(0, now + 77001).events.length, 1);
  console.log('PASS observed feed: transitions, heartbeat, replay cursors, expiry, ring cap, shell/unknown/collision guards');
}

// Identity swaps must settle in the UI before matching any new live feed.
{
  const feed = createObservedFeed(), frames = [];
  let names = ['alpha','beta'], statuses = ['working','idle'];
  const roster = () => [{name:'bWFpbg/d0Q',source:'local',windows:names.map((name,index)=>({index:index+1,name,agent:'codex',active:false,status:statuses[index]}))}];
  const backend = {observedFeed:feed, teamInventory:()=>({teams:[],total:0}), async dashboardSessions(){const sessions=roster();feed.observe(sessions);return sessions;}, async captureBatch(){return {};}};
  const ws = {data:{controller:new AbortController()},send(value){frames.push({time:Date.now(),...JSON.parse(value)});return 1;},close(){}};
  const session = createSocketSession(ws,backend);
  const waitFor = predicate => deadline((async()=>{while(!predicate()) await Bun.sleep(5);})(),'identity feed projection');
  try {
    await waitFor(()=>frames.some(frame=>frame.type==='feed-history'));
    for (const replacement of [['beta','alpha'],['gamma','alpha']]) {
      const start=frames.length;
      names=replacement;
      await waitFor(()=>frames.slice(start).some(frame=>frame.type==='sessions'));
      const changed=frames.slice(start).find(frame=>frame.type==='sessions');
      await waitFor(()=>frames.slice(start).some(frame=>frame.type==='feed'));
      const projected=frames.slice(start).filter(frame=>frame.type==='feed');
      assert.ok(projected[0].time-changed.time >= 900,'changed identities need a complete normal poll before feed projection');
      for(const frame of projected) {
        const expected=names[Number(frame.event.target.split(':').at(-1))-1];
        assert.equal(frame.event.oracle,expected,'feed identity must match the accepted changed roster');
      }
    }
    const start = frames.length; statuses = ['idle','working'];
    await waitFor(()=>frames.slice(start).some(frame=>frame.type==='feed'));
    const statusFrames = frames.slice(start);
    assert.ok(statusFrames.find(frame=>frame.type==='feed').time - statusFrames.find(frame=>frame.type==='sessions').time < 500, 'status-only changes do not wait an extra poll');
    console.log('PASS observed feed: swapped/renamed identities defer events; status-only transitions remain immediate');
  } finally { session.close(); }
}

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
  { index: 4, name: 'codex', active: true, cwd: '/tmp', status: 'idle', agent: 'codex' },
  { index: 9, name: 'wD:p9', active: false, cwd: join(temporary,'home'), status: 'unknown' },
] }];
const children = new Set(), sockets = new Set();
let checks = 0;
const env = { ...process.env, PATH: '/nonexistent', HOME: join(temporary, 'home'), XDG_CACHE_HOME: join(temporary, 'cache') };
for (const key of Object.keys(env)) if (key.startsWith('MAW_') || key === 'PEERS_FILE') delete env[key];
env.MAW_CONFIG_DIR = join(temporary, 'config');
env.MAW_TEST_MODE = '1';
env.HOSTNAME = 'herdr';
// Federation inventory must not inherit a live fleet override.
env.PEERS_FILE = join(temporary, 'absent-peers.json');
mkdirSync(env.HOME);
writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
writeFileSync(fake, `#!${bun}
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (existsSync(${JSON.stringify(failure)})) { console.error('fixture unavailable'); process.exit(7); }
if (JSON.stringify(args) === JSON.stringify(['session','list','--json'])) console.log(JSON.stringify({sessions:[{name:'main',running:true},{name:'stopped',running:false}]}));
else if (args[2] === 'api') console.log(JSON.stringify({result:{snapshot:{protocol:22,workspaces:[{workspace_id:'wD',label:'demo'}],panes:[{pane_id:'wD:p4',workspace_id:'wD',agent:'codex',focused:true,agent_status:'idle',cwd:'/tmp'},{pane_id:'wD:p9',workspace_id:'wD',agent:null,focused:false,agent_status:'unknown',cwd:${JSON.stringify(join(temporary,'home'))}}]}}}));
else if (args[2] === 'pane') process.stdout.write('visible output\\n');
else if (args[2] === 'agent' && args[3] === 'start') console.log(JSON.stringify({result:{type:'agent_started',argv:['codex'],agent:{pane_id:'wD:p9',agent:'codex',interactive_ready:true}}}));
else if (args[2] === 'agent') console.log('{"ok":true}');
else { console.error('unexpected args', args); process.exit(8); }
`);
chmodSync(fake, 0o700);

// Force the old working read to finish after a potential newer blocked read.
// Shared acquisition prevents that newer read from overtaking it altogether.
{
  const laneBinary = join(temporary, 'lane-herdr'), laneState = join(temporary, 'lane-state');
  const laneStarted = join(temporary, 'lane-started'), laneRelease = join(temporary, 'lane-release');
  const laneCalls = join(temporary, 'lane-calls');
  writeFileSync(laneState, 'working');
  writeFileSync(laneBinary, `#!${bun}
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='session') console.log(JSON.stringify({sessions:[{name:'main',running:true}]}));
else {
 const status=readFileSync(${JSON.stringify(laneState)},'utf8');
 appendFileSync(${JSON.stringify(laneCalls)},status+'\\n');
 if(status==='working') {
  writeFileSync(${JSON.stringify(laneStarted)},'1');
  while(!existsSync(${JSON.stringify(laneRelease)})) await Bun.sleep(5);
 }
 console.log(JSON.stringify({protocol:22,workspaces:[{workspace_id:'wD'}],panes:[{pane_id:'wD:p4',workspace_id:'wD',agent:'codex',focused:true,agent_status:status}]}));
}
`);
  chmodSync(laneBinary, 0o700);
  const backend = createHerdrBackend(laneBinary);
  try {
    const older = backend.dashboardSessions();
    await deadline((async()=>{while(!existsSync(laneStarted)) await Bun.sleep(5);})(), 'older snapshot start');
    writeFileSync(laneState, 'blocked');
    const newer = backend.dashboardSessions();
    await Bun.sleep(50);
    assert.equal(readFileSync(laneCalls,'utf8'), 'working\n', 'a newer roster cannot overtake the pending observation');
    writeFileSync(laneRelease,'1');
    const results = await Promise.all([older,newer]);
    assert.equal(results[0][0].windows[0].status,'working');
    assert.equal(results[1][0].windows[0].status,'working');
    assert.equal((await backend.dashboardSessions())[0].windows[0].status,'blocked');
    assert.deepEqual(backend.observedFeed.read().events.map(event=>event.observedState), ['working','blocked']);
    console.log('PASS observed feed: overlapping old/new snapshot acquisitions cannot regress status');
  } finally { writeFileSync(laneRelease,'1'); await backend.close(); }
}

function deadline(promise, label, ms = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}
async function start(entry, dataDir, enginePort, options = {}) {
  const args = enginePort ? ['--engine'] : ['--token-file', tokenFile, '--listen', '127.0.0.1:0'];
  const childEnv = enginePort ? {...env, MAW_SERVE_TOKEN:token, MAW_ENGINE_SERVE_PORT:String(enginePort), MAW_ENGINE_SERVE_PREFIX:'/api/herdr', PORT:String(enginePort)} : env;
  const child = spawn(bun, [entry, 'serve', ...args, '--herdr', fake, '--data-dir', dataDir], { env:{...childEnv,...options.env}, cwd: options.cwd || temporary, stdio: ['ignore', 'pipe', 'pipe'] });
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
async function exerciseFeedActivity(entry, label) {
  const {child,url} = await start(entry, join(temporary, `activity-${label}`));
  await http(url, '/api/feed', {method:'POST', body:{oracle:'codex',event:'not-injected',text:'not-injected'}});
  assert.deepEqual((await http(url, '/api/feed')).json, {events:[],total:0,active_oracles:[]});
  const ticket = (await http(url, '/api/auth/ws-ticket', {method:'POST',headers:{Origin:url},body:{path:'/ws'}})).json;
  const ws = await socket(url,ticket.ticket);
  for (const type of ['sessions','recent','teams']) assert.equal((await ws.next()).type,type);
  assert.deepEqual(await ws.next(),{type:'feed-history',events:[]});
  ws.send(JSON.stringify({type:'unsupported'}));
  assert.equal((await ws.next()).type,'error','HTTP activity must suppress the first synthetic transition without injecting a payload');
  child.kill('SIGTERM');
  assert.deepEqual(await deadline(child.exited,'activity shutdown'),{code:0,signal:null});
  await deadline(ws.closed,'activity socket shutdown'); sockets.delete(ws); children.delete(child);
  console.log(`PASS ${label} feed activity: authenticated HTTP suppresses WebSocket projection; no injected history`);
}
async function exerciseTeams(url) {
  const claude = join(env.HOME,'.claude'), teams = join(claude,'teams'), tasks = join(claude,'tasks');
  const reset = () => { rmSync(claude,{recursive:true,force:true}); mkdirSync(join(teams,'alpha'),{recursive:true}); mkdirSync(join(tasks,'alpha'),{recursive:true}); };
  const config = value => writeFileSync(join(teams,'alpha','config.json'),JSON.stringify(value));
  try {
    rmSync(claude,{recursive:true,force:true});
    assert.deepEqual((await http(url,'/api/teams')).json,{teams:[],total:0});
    await http(url,'/api/teams',{auth:false,status:401});
    writeFileSync(failure,'fail'); await http(url,'/api/teams',{status:503}); rmSync(failure);
    reset();
    writeFileSync(join(teams,'README'),'ignored'); writeFileSync(join(teams,'.DS_Store'),'ignored');
    const now=Date.now();
    config({name:'alpha',createdAt:now,leadRepo:join(env.HOME,'project'),password:'TEAM_SECRET',members:[{name:'team-lead',secret:'MEMBER_SECRET',subscriptions:['ok',17]},{name:'remote',backendType:'tmux',tmuxPaneId:'%4'}]});
    writeFileSync(join(tasks,'alpha','00.json'),JSON.stringify({id:1,subject:'numeric id'}));
    writeFileSync(join(tasks,'alpha','10.json'),JSON.stringify({id:'10',subject:'later',status:'pending',secret:'TASK_SECRET',blocks:['2',17]}));
    writeFileSync(join(tasks,'alpha','2.json'),JSON.stringify({id:'2',subject:'second',blockedBy:['10']}));
    writeFileSync(join(tasks,'alpha','bad.json'),'{'); writeFileSync(join(tasks,'alpha','array.json'),'[]');
    const inventory=(await http(url,'/api/teams')).json;
    assert.equal(inventory.total,1); const team=inventory.teams[0];
    assert.equal(team.alive,true); assert.equal(team.leadAgentId,'team-lead@alpha');
    assert.equal(team.description,''); assert.equal(team.leadSessionId,'');
    assert.equal(team.members[0].agentId,'team-lead@alpha'); assert.equal(team.members[0].agentType,'lead');
    assert.equal(team.members[0].joinedAt,now); assert.equal(team.members[0].cwd,join(env.HOME,'project'));
    assert.deepEqual(team.members[0].subscriptions,['ok']); assert.equal(team.members[0].backendType,'in-process');
    assert.deepEqual(team.tasks.map(task=>task.id),[1,'10','2']); assert.deepEqual(team.tasks[1].blocks,['2']);
    assert.ok(!JSON.stringify(inventory).includes('_SECRET'));
    const teamTicket = (await http(url,'/api/auth/ws-ticket',{method:'POST',headers:{Origin:url},body:{path:'/ws'}})).json;
    const teamWS = await socket(url,teamTicket.ticket);
    assert.equal((await teamWS.next()).type,'sessions'); assert.equal((await teamWS.next()).type,'recent');
    assert.deepEqual(await teamWS.next(),{type:'teams',teams:inventory.teams},'authenticated WS supplies inventory after browser pre-auth REST misses it');
    teamWS.close(); await teamWS.closed;

    for(const member of [{cwd:env.HOME+'-other',joinedAt:now},{cwd:join(env.HOME,'..','outside'),joinedAt:now},{cwd:env.HOME,joinedAt:now-7200001},{backendType:'tmux',tmuxPaneId:'%4',cwd:env.HOME,joinedAt:now}]) {
      config({members:[member]}); assert.equal((await http(url,'/api/teams')).json.teams[0].alive,false);
    }
    config({name:'../../outside',members:[]});
    assert.deepEqual((await http(url,'/api/teams')).json.teams[0].tasks.map(task=>task.id),[1,'10','2'],'task paths use directory names, never config name');
    writeFileSync(join(teams,'alpha','config.json'),'{'); assert.equal((await http(url,'/api/teams')).json.total,0);
    for(const unsafe of [claude,teams,join(teams,'alpha'),join(teams,'alpha','config.json'),tasks,join(tasks,'alpha'),join(tasks,'alpha','1.json')]) {
      reset(); config({members:[]}); rmSync(unsafe,{recursive:true,force:true}); symlinkSync(temporary,unsafe); await http(url,'/api/teams',{status:503});
    }
    reset(); mkdirSync(join(teams,'alpha','config.json')); await http(url,'/api/teams',{status:503});
    const badTicket = (await http(url,'/api/auth/ws-ticket',{method:'POST',headers:{Origin:url},body:{path:'/ws'}})).json;
    const badWS = await socket(url,badTicket.ticket);
    assert.equal((await badWS.next()).type,'sessions'); assert.equal((await badWS.next()).type,'recent');
    assert.deepEqual(await badWS.next(),{type:'error',error:'teams_unavailable'},'unsafe inventory is never reported as an empty team list');
    badWS.close(); await badWS.closed;

    reset(); writeFileSync(join(teams,'alpha','config.json'),Buffer.alloc(1048577,32)); await http(url,'/api/teams',{status:503});
    reset(); config({members:Array.from({length:1001},()=>({}))}); await http(url,'/api/teams',{status:503});
    reset(); config({leadRepo:'x'.repeat(10000),members:Array.from({length:500},()=>({}))}); await http(url,'/api/teams',{status:503});
    reset(); for(let index=0;index<100;index++) mkdirSync(join(teams,'extra'+index)); await http(url,'/api/teams',{status:503});
    reset(); config({}); for(let index=0;index<1001;index++) writeFileSync(join(tasks,'alpha',index+'.json'),'{}'); await http(url,'/api/teams',{status:503});
    reset(); for(let index=0;index<5;index++) {const dir=join(teams,'large'+index);mkdirSync(dir);writeFileSync(join(dir,'config.json'),Buffer.alloc(900000,32));} await http(url,'/api/teams',{status:503});
    console.log('PASS teams: real inventory, normalization, secret filtering, heuristic bounds, malformed/missing, symlinks, file/count/aggregate/amplification limits');
  } finally { rmSync(claude,{recursive:true,force:true}); rmSync(failure,{force:true}); }
}

async function exerciseWorktrees(entry,label) {
  const directory=join(temporary,label+'-worktrees');mkdirSync(directory);
  const main=join(directory,'main'), clean=join(directory,'repo.wt-clean space_日本'), dirty=join(directory,'dirty'), untracked=join(directory,'untracked'), locked=join(directory,'locked'), active=join(directory,'active');
  const outside=join(temporary,label+'-outside');
  const gitEnv={...Object.fromEntries(Object.entries({...process.env,HOME:env.HOME}).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'};
  const git=(...args)=>{const result=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{env:gitEnv,encoding:'utf8',timeout:10000});assert.ifError(result.error);assert.equal(result.status,0,result.stderr);return result.stdout;};
  mkdirSync(main);git('init','--initial-branch=main',main);writeFileSync(join(main,'tracked'),'original');git('-C',main,'add','tracked');git('-C',main,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture');
  for(const [index,path] of [clean,dirty,untracked,locked,active,outside].entries()) git('-C',main,'worktree','add','-b','branch'+index,path);
  writeFileSync(join(dirty,'tracked'),'modified');writeFileSync(join(untracked,'loose'),'untracked');git('-C',main,'worktree','lock',locked);
  const activeHerdr=join(directory,'herdr');
  writeFileSync(activeHerdr,`#!${bun}
const a=process.argv.slice(2);if(a[0]==='session')console.log(JSON.stringify({sessions:[{name:'main',running:true}]}));else console.log(JSON.stringify({protocol:22,workspaces:[{workspace_id:'w'}],panes:[{pane_id:'w:p1',workspace_id:'w',focused:true,agent_status:'unknown',cwd:${JSON.stringify(join(active,'subdir'))}}]}));
`);chmodSync(activeHerdr,0o700);mkdirSync(join(active,'subdir'));
  // A wrapper preserves the standard fixture executable argv while selecting a private roster.
  const saved=readFileSync(fake);writeFileSync(fake,readFileSync(activeHerdr));
  const {child,url}=await start(entry,join(directory,'data'),undefined,{cwd:main,env:{PATH:process.env.PATH,GIT_DIR:join(temporary,'wrong-git-dir'),GIT_WORK_TREE:outside}});
  try {
    const list=(await http(url,'/api/worktrees')).json;
    assert.equal(list.length,7);assert.ok(list.every(row=>row.status==='stale'));
    assert.deepEqual(list.find(row=>row.path===clean),{path:clean,branch:'branch0',repo:'repo.wt-clean space_日本',mainRepo:'main',name:'clean space_日本',status:'stale'});
    await http(url,'/api/worktrees',{auth:false,status:401});await http(url,'/api/worktrees',{method:'POST',status:405});
    await http(url,'/api/worktrees/cleanup',{status:405});await http(url,'/api/worktrees/cleanup',{method:'POST',auth:false,body:{path:clean},status:401});
    const remove=path=>http(url,'/api/worktrees/cleanup',{method:'POST',body:{path},status:400});
    const unregistered=join(directory,'unregistered');mkdirSync(unregistered);mkdirSync(join(unregistered,'.git'));
    for(const path of [main,dirty,untracked,locked,active,outside,unregistered,join(directory,'..','escape'),main+'/../dirty',main+'/--bad',main+'\n']) {assert.equal((await remove(path)).json.error,'worktree_cleanup_rejected');}
    assert.ok(existsSync(dirty)&&existsSync(untracked)&&existsSync(locked)&&existsSync(active));
    writeFileSync(fake,`#!${bun}\nprocess.exit(7);\n`);await remove(clean);assert.ok(existsSync(clean));writeFileSync(fake,readFileSync(activeHerdr));
    writeFileSync(fake,readFileSync(activeHerdr,'utf8').replace(JSON.stringify(join(active,'subdir')),JSON.stringify('relative/unknown')));await remove(clean);assert.ok(existsSync(clean));writeFileSync(fake,readFileSync(activeHerdr));
    const removed=(await http(url,'/api/worktrees/cleanup',{method:'POST',body:{path:clean}})).json;
    assert.equal(removed.ok,true);assert.equal(removed.path,clean);assert.ok(Array.isArray(removed.log));assert.equal(existsSync(clean),false);
    assert.ok(git('-C',main,'branch','--list','branch0').includes('branch0'),'cleanup must not delete branches');
    console.log(`PASS ${label} worktrees: real Git listing, spaces/non-ASCII, clean remove, dirty/untracked/locked/active/main/outside/unregistered/auth/env rejection`);
  } finally {child.kill('SIGTERM');await deadline(child.exited,'worktree shutdown');children.delete(child);writeFileSync(fake,saved);}
  const bin=join(directory,'bin');mkdirSync(bin);const gitFake=join(bin,'git');
  writeFileSync(gitFake,`#!${bun}\nprocess.stdout.write(Array.from({length:129},(_,index)=>'worktree /tmp/fixture-'+index+'\\0HEAD a\\0\\0').join(''));\n`);chmodSync(gitFake,0o700);
  const bounded=await start(entry,join(directory,'bounded'),undefined,{cwd:main,env:{PATH:bin}});
  try {
    assert.equal((await http(bounded.url,'/api/worktrees',{status:500})).json.error,'worktrees_unavailable');
    writeFileSync(gitFake,`#!${bun}\nprocess.stdout.write('x'.repeat(4194305));setInterval(()=>{},1000);\n`);
    assert.equal((await http(bounded.url,'/api/worktrees',{status:500})).json.error,'worktrees_unavailable');
    console.log(`PASS ${label} worktrees: count/output bounds and sanitized subprocess failures`);
  } finally {bounded.child.kill('SIGTERM');await deadline(bounded.child.exited,'bounded worktree shutdown');children.delete(bounded.child);}
}

async function exercise(entry, label) {
  const dataDir = join(temporary, label);
  const {child, url} = await start(entry, dataDir);
  const origin = { Origin: url };
  await exerciseTeams(url);
  assert.equal((await http(url,'/api/wake',{method:'POST',body:{target}})).json.state,'already-awake');
  assert.equal((await http(url,'/api/wake',{method:'POST',body:{target:shell}})).json.state,'ready');
  await http(url,'/api/wake',{method:'POST',body:{target:shell,task:'new-worktree'},status:503});
  await http(url,'/api/wake',{method:'POST',body:{target:'missing'},status:404});
  await http(url,'/api/wake',{status:405});
  await http(url,'/api/wake',{method:'POST',body:{target,command:123},status:400});
  await http(url,'/api/wake',{method:'POST',body:{target,engine:'codex'},status:400});
  assert.equal((await http(url,'/api/wake',{method:'POST',body:{target,task:null,command:'ignored'}})).json.state,'already-awake');
  assert.deepEqual((await http(url, '/api/sessions')).json, sessions);
  await http(url,'/api/worktrees',{status:500});
  assert.deepEqual((await http(url, '/api/capture?target=' + encodeURIComponent(target))).json, {content:'visible output\n',target,resolvedTarget:target});
  assert.deepEqual((await http(url, '/api/captures')).json, {captures:{[target]:'visible output\n',[shell]:'visible output\n'}});
  assert.deepEqual((await http(url, '/api/agents')).json,{node:'herdr',count:2,agents:[
    {node:'herdr',session:'bWFpbg/d0Q',window:'4',oracle:'codex',state:'idle',pid:null},
    {node:'herdr',session:'bWFpbg/d0Q',window:'9',oracle:'wD:p9',state:'idle',pid:null},
  ]});
  assert.deepEqual((await http(url, '/api/agent')).json, (await http(url, '/api/agents')).json);
  assert.deepEqual((await http(url, '/api/config')).json, {node:'herdr',agents:{},namedPeers:[]});
  const identity = (await http(url, '/api/identity')).json;
  assert.deepEqual(identity.endpoints, ['/api/sessions','/api/capture','/api/send','/api/wake','/ws','/ws/pty']);
  assert.ok(identity.capabilities.includes('dashboard-ws') && identity.capabilities.includes('terminal-stream'));
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
  const countPrompts = () => readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(args => args[2] === 'agent' && args[3] === 'prompt').length;
  const promptsBeforeRetry = countPrompts();
  const retryResponses = await Promise.all([0,1].map(() => http(url,'/api/send',{method:'POST',body:{target,text:'retry-once'},headers:{'X-Maw-Timestamp':'retry-fixture','X-Maw-From':'fixture:local'}})));
  assert.equal(countPrompts(),promptsBeforeRetry+1);
  assert.equal(retryResponses.filter(response => response.json.deduped === true).length,1);
  const deliveryHistory = (await http(url,'/api/feed')).json;
  const retryEvents = deliveryHistory.events.filter(event => event.text === 'retry-once');
  assert.deepEqual(retryEvents.map(event => event.state).sort(), ['accepted','deduped']);
  assert.ok(retryEvents.every(event => event.source === 'herdr' && event.target === target && Number.isInteger(event.timestamp)));
  assert.equal((await http(url,'/api/feed?limit=0')).json.total,0);
  assert.equal((await http(url,'/api/feed?limit=1')).json.total,1);
  for (const query of ['-1','x','','1&limit=2','18446744073709551616']) await http(url,'/api/feed?limit='+query,{status:400});
  for (const invalidTarget of ['', ' ', '\t\n', '\u2003', '\u0085']) {
    const invalid = (await http(url,'/api/send',{method:'POST',body:{target:invalidTarget,text:'undeliverable'},status:400})).json;
    assert.deepEqual(invalid,{ok:false,error:'empty-target',state:'failed'});
  }
  const invalidHistory = (await http(url,'/api/feed')).json.events.filter(event=>event.error==='empty-target');
  assert.equal(invalidHistory.length,5); assert.ok(invalidHistory.every(event=>event.route==='validate'&&event.state==='failed'));
  const attachments = [join(temporary,'literal path that does not exist'), 'https://example.invalid/literal-url?value=$(touch never)'];
  for (const body of [{target,attachments,text}, {target,attachments}]) {
    const combinedText = attachments.join('\n') + '\n' + (body.text ?? '');
    const attached = (await http(url,'/api/send',{method:'POST',body})).json;
    assert.equal(attached.state,'accepted'); assert.equal(attached.text,combinedText); assert.equal(attached.ok,true);
    const prompts = readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(args => args[2] === 'agent' && args[3] === 'prompt');
    assert.deepEqual(prompts.at(-1), ['--session','main','agent','prompt','wD:p4',combinedText], 'attachments are literal prompt lines, not files to read or URLs to fetch');
  }
  assert.equal(existsSync(join(temporary,'never')),false);
  for (const [body,status,error] of [[{target:shell,text:'x'},409,'target_not_agent'],[{target:'missing',text:'x'},404,'target_not_found'],[{target,text:'x',force:true},501,'send_options_not_supported'],[{target,text:'x',inbox:true},503,'herdr_unavailable'],[{target,text:''},400,'target_and_text_required'],[{target,text:'x',unknown:1},400,'invalid_json']]) {
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
  assert.deepEqual((await http(url,'/api/capture?target=missing',{status:400})).json,{content:'',target:'missing',resolvedTarget:'missing',error:'capture_unavailable'});
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
  assert.deepEqual(await ws.next(),{type:'sessions',sessions});
  assert.deepEqual(await ws.next(), {type:'recent', agents:[{target, name:'codex', session:'bWFpbg/d0Q'}]}, 'recent must include the detected agent but never the shell pane');
  assert.deepEqual(await ws.next(), {type:'teams',teams:[]});
  const history = await ws.next();
  assert.equal(history.type, 'feed-history'); assert.equal(history.events.length, 1);
  const observed = {event:history.events[0]};
  assert.equal(observed.event.target, target);
  assert.equal(observed.event.event, 'Stop'); assert.equal(observed.event.source, 'herdr-agent-status');
  assert.equal(observed.event.observedState, 'idle'); assert.equal(observed.event.oracle, 'codex');
  assert.match(observed.event.message, /status projection, not a tool hook/);
  const replayTicket = (await http(url,'/api/auth/ws-ticket',{method:'POST',headers:origin,body:{path:'/ws'}})).json;
  const second = await socket(url,replayTicket.ticket);
  assert.deepEqual(await second.next(), {type:'sessions',sessions});
  assert.equal((await second.next()).type, 'recent');
  assert.deepEqual(await second.next(), {type:'teams',teams:[]});
  assert.deepEqual(await second.next(), {type:'feed-history', events:[observed.event]}, 'a second client replays once after its roster render, not another fabricated transition');
  second.close(); await second.closed;
  await http(url,'/ws',{auth:false,headers:{...origin,'Sec-WebSocket-Protocol':`maw.ws.v1, ${ticket.ticket}`},status:401});
  ws.send(JSON.stringify({type:'wake',target:shell,command:''}));
  assert.deepEqual(await ws.next(),{type:'action-ok',action:'wake',target:shell});
  ws.send(JSON.stringify({type:'wake',target:shell,command:'must-not-execute'}));
  assert.deepEqual(await ws.next(),{type:'error',error:'wake_command_not_supported'});
  ws.send(JSON.stringify({type:'select',target}));
  assert.deepEqual(await ws.next(),{type:'capture',target,content:'visible output\n'});
  ws.send(JSON.stringify({type:'subscribe-previews',targets:[shell]}));
  assert.deepEqual(await ws.next(),{type:'previews',data:{[shell]:'visible output\n'}});
  ws.send(JSON.stringify({type:'send',target,text}));
  assert.deepEqual(await ws.next(),{type:'sent',ok:true,target,text,state:'accepted'});
  ws.send(JSON.stringify({type:'send',content:'\r'}));
  assert.deepEqual(await ws.next(),{type:'sent',ok:true,target,text:'\r',state:'accepted'});
  ws.send(JSON.stringify({type:'send',target:shell,text:'',content:'must-not-send',force:true}));
  assert.deepEqual(await ws.next(),{type:'sent',ok:true,target:shell,text:'',state:'accepted'});
  ws.send(JSON.stringify({type:'send',text:null,content:'must-not-send',force:true}));
  assert.deepEqual(await ws.next(),{type:'error',error:'target_and_text_required'});
  ws.send(JSON.stringify({type:'send',target:'',text:'must-not-send',force:true}));
  assert.deepEqual(await ws.next(),{type:'error',error:'target_and_text_required'});
  const inputCalls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(args=>args[2]==='pane');
  assert.ok(inputCalls.some(args=>args[3]==='send-text'&&args[4]==='wD:p4'&&args[5]==='\r'));
  assert.ok(inputCalls.some(args=>args[3]==='send-text'&&args[4]==='wD:p9'&&args[5]===''));
  assert.ok(inputCalls.some(args=>args[3]==='send-keys'&&args[4]==='wD:p9'&&args[5]==='enter'));
  assert.ok(!inputCalls.some(args=>args.includes('must-not-send')));
  for (const [command,error] of [[{type:'send',target:'missing',text:'x'},'send_failed'],[{type:'send',target,text:'x',inbox:true},'send_options_not_supported'],[{type:'subscribe-previews',targets:Array(17).fill(target)},'too_many_previews'],[{type:'select',target:''},'subscription_invalid'],[{type:'unknown'},'command_not_supported']]) {
    ws.send(JSON.stringify(command)); assert.deepEqual(await ws.next(),{type:'error',error});
  }
  ws.send(JSON.stringify({type:'select',extra:true}));
  assert.equal((await deadline(ws.closed,'invalid command close')).code,1008);
  sockets.delete(ws);
  const oversized = await socket(url,(await mint()).ticket);
  await oversized.next(); await oversized.next(); await oversized.next();
  const promptsBefore = readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(args => args[2] === 'agent' || (args[2] === 'pane' && ['send-text','send-keys'].includes(args[3]))).length;
  oversized.send(JSON.stringify({type:'send',target,text:'x'.repeat(65537)}));
  // Bun's transport payload gate can report abnormal close (1006), unlike Go's
  // explicit 1009. Both must close without executing the oversized command.
  assert.ok([1006,1009].includes((await deadline(oversized.closed,'oversized close')).code));
  const promptsAfter = readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(args => args[2] === 'agent' || (args[2] === 'pane' && ['send-text','send-keys'].includes(args[3]))).length;
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
  assert.deepEqual((await http(url,'/api/herdr',{auth:false})).json.endpoints,['/api/herdr/sessions','/api/herdr/capture','/api/herdr/send','/api/herdr/wake','/api/herdr/ws','/api/herdr/ws/pty']);
  await http(url,'/api/sessions',{auth:false,status:404});
  await http(url,'/api/herdrish/sessions',{auth:false,status:404});
  await http(url,'/api/herdr/auth/ws-ticket',{auth:false,status:501});
  await http(url,'/api/herdr/sessions',{auth:false,headers:{Host:'evil.example'},status:403});
  for (const Origin of ['',url,'https://god.buildwithoracle.com']) {
    await http(url,'/api/herdr/sessions',{auth:false,headers:{Origin},status:403});
  }
  const ws = await socket(url,undefined,'/api/herdr/ws');
  assert.deepEqual(await ws.next(),{type:'sessions',sessions});
  assert.deepEqual(await ws.next(), {type:'recent', agents:[{target, name:'codex', session:'bWFpbg/d0Q'}]}, 'recent must include the detected agent but never the shell pane');
  assert.deepEqual(await ws.next(), {type:'teams',teams:[]});
  const history = await ws.next();
  assert.equal(history.type, 'feed-history'); assert.equal(history.events.length, 1);
  const observed = {event:history.events[0]};
  assert.equal(observed.event.target, target);
  assert.equal(observed.event.event, 'Stop'); assert.equal(observed.event.source, 'herdr-agent-status');
  assert.equal(observed.event.observedState, 'idle'); assert.equal(observed.event.oracle, 'codex');
  assert.match(observed.event.message, /status projection, not a tool hook/);
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
  await exerciseFeedActivity(join(root,'index.mjs'),'source');
  await exerciseEngine(join(root,'index.mjs'),'source');
  await exercise(join(root,'index.mjs'),'source');
  await exerciseWorktrees(join(root,'index.mjs'),'source');
  const bundle = join(temporary,'index.js');
  const build = spawnSync(bun,['build',join(root,'index.mjs'),'--target=bun','--outfile',bundle],{env,encoding:'utf8',timeout:30000});
  assert.ifError(build.error); assert.equal(build.status,0,build.stderr);
  await exerciseFeedActivity(bundle,'bundle');
  await exercise(bundle,'bundle');
  await exerciseWorktrees(bundle,'bundle');
  await exerciseEngine(bundle,'bundle');
  console.log(`PASS: ${checks} HTTP assertions; source/bundle core needs no PATH tools; worktree fixtures use Git; no Go`);
} finally {
  for (const ws of sockets) ws.close();
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled([...children].map(child => child.exited));
  rmSync(temporary,{recursive:true,force:true});
}
