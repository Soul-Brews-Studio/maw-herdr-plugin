#!/usr/bin/env bun
// Local disposable stores only: no peer connections or user's files are read.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFederationConfig} from '../src/serve/bun/mod.readFederationConfig.ts';

// Bun caches os.homedir at startup, so isolate HOME before loading child code.
if (process.argv[2] !== '--isolated-home') {
  const home=realpathSync(mkdtempSync(join(tmpdir(),'herdr-federation-config-')));
  try {
    const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--isolated-home',home],{env:{...process.env,HOME:home,MAW_CONFIG_DIR:join(home,'config'),MAW_TEST_MODE:'1'},cwd:home,stdio:'inherit',timeout:15000});
    assert.ifError(child.error);assert.equal(child.status,0);
  } finally {rmSync(home,{recursive:true,force:true});}
} else {
  const root=realpathSync(process.argv[3]);assert.equal(root,realpathSync(process.env.HOME!));
  const keys=['PEERS_FILE','MAW_HOME','MAW_STATE_DIR','MAW_XDG','XDG_STATE_HOME','MAW_SENDER','MAW_FEDERATION_TOKEN','MAW_PEER_KEY'];
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const store=(path:string,name='peer')=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify({version:1,peers:{[name]:{url:'http://127.0.0.1:1'}}}));};
  const fails=()=>assert.throws(()=>readFederationConfig(),/federation_unavailable/);
  try {
    for(const key of keys)delete process.env[key];
    assert.deepEqual(readFederationConfig().peers,[]);assert.equal(readFederationConfig().key,'');assert.equal(existsSync(join(root,'.maw','peer-key')),false);
    store(join(root,'.maw','peers.json'),'home');assert.equal(readFederationConfig().peers[0].name,'home');
    process.env.MAW_XDG='true';process.env.XDG_STATE_HOME=join(root,'xdg');store(join(root,'xdg','maw','peers.json'),'xdg');assert.equal(readFederationConfig().peers[0].name,'xdg');
    process.env.MAW_STATE_DIR=join(root,'state');store(join(root,'state','peers.json'),'state');assert.equal(readFederationConfig().peers[0].name,'state');
    rmSync(join(root,'state','peers.json'));writeFileSync(join(root,'state','peer-key'),' state-key ');
    assert.equal(readFederationConfig().peers[0].name,'home');assert.equal(readFederationConfig().key,'state-key','fallback does not change key location');
    process.env.MAW_HOME=join(root,'maw');assert.deepEqual(readFederationConfig().peers,[],'explicit MAW_HOME suppresses legacy fallback');
    store(join(root,'maw','peers.json'),'maw');assert.equal(readFederationConfig().peers[0].name,'maw');
    process.env.PEERS_FILE=join(root,'explicit.json');assert.deepEqual(readFederationConfig().peers,[],'explicit missing file suppresses fallback');
    store(process.env.PEERS_FILE,'explicit');assert.equal(readFederationConfig().peers[0].name,'explicit');
    writeFileSync(join(root,'maw','peer-key'),'  file-key  ');assert.equal(readFederationConfig().key,'file-key');
    process.env.MAW_PEER_KEY='  env-key  ';process.env.MAW_FEDERATION_TOKEN='  fleet  ';assert.equal(readFederationConfig().key,'  env-key  ');assert.equal(readFederationConfig().fleet,'fleet');
    for(const raw of ['', '{', JSON.stringify({version:2,peers:{}}),JSON.stringify({version:1,peers:Object.fromEntries(Array.from({length:33},(_,i)=>[String(i),{url:'http://127.0.0.1:1'}]))})]){writeFileSync(process.env.PEERS_FILE,raw);fails();}
    for(const url of ['http://u:p@localhost/','http://@localhost/','http://localhost/?','http://localhost/#','http://localhost:0','file:///tmp/peer','http:localhost']){writeFileSync(process.env.PEERS_FILE,JSON.stringify({version:1,peers:{p:{url}}}));fails();}
    writeFileSync(process.env.PEERS_FILE,'x'.repeat(1048577));fails();writeFileSync(process.env.PEERS_FILE,Buffer.from([0xff]));fails();
    store(process.env.PEERS_FILE);delete process.env.MAW_PEER_KEY;writeFileSync(join(root,'maw','peer-key'),Buffer.from([0xff]));fails();
    process.env.MAW_PEER_KEY='override';symlinkSync(join(root,'maw'),join(root,'link'));process.env.PEERS_FILE=join(root,'link','missing.json');fails();
    process.env.PEERS_FILE=join(root,'directory');mkdirSync(process.env.PEERS_FILE);fails();
    console.log('PASS federation config: isolated HOME, precedence/fallback, key semantics/no creation, schemas/URL guards, strict UTF-8, byte/count limits, missing-leaf symlinks/nonregular files');
  } finally {for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
}
