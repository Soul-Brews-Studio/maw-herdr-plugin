#!/usr/bin/env bun
// Pure private filesystem fixtures. No user's config, peer requests, or generated keys.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,symlinkSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readMawConfig,projectMawConfig} from '../src/serve/bun/mod.readMawConfig.ts';
import {readFederationConfig} from '../src/serve/bun/mod.readFederationConfig.ts';

if(process.argv[2] !== '--isolated') {
  const home=realpathSync(mkdtempSync(join(tmpdir(),'herdr-maw-config-')));
  try {
    const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--isolated',home],{cwd:home,env:{...process.env,HOME:home},stdio:'inherit',timeout:30000});
    assert.ifError(child.error);assert.equal(child.status,0);
  } finally {rmSync(home,{recursive:true,force:true});}
} else {
  const root=realpathSync(process.argv[3]);
  const keys=['MAW_HOME','MAW_CONFIG_DIR','MAW_TEST_MODE','XDG_CONFIG_HOME','MAW_STATE_DIR','MAW_XDG','XDG_STATE_HOME','MAW_SENDER','MAW_FEDERATION_TOKEN','MAW_PEER_KEY','PEERS_FILE','HOSTNAME'];
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const write=(path:string,value:unknown)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify(value));};
  const fail=()=>assert.throws(()=>readMawConfig(),/config_unavailable/);
  try {
    for(const key of keys)delete process.env[key];
    process.env.MAW_CONFIG_DIR=join(root,'active');
    process.env.HOSTNAME='fixture';
    assert.equal(projectMawConfig(readMawConfig()).node,'fixture');
    const file=join(root,'active','maw.config.json');
    write(file,{node:'legacy'});assert.equal(readMawConfig().node,'legacy');
    write(join(root,'active','maw.config.10.json'),{node:'user',nested:{keep:1,remove:2},namedPeers:[{name:'a',url:'http://a',secret:'old'}]});
    write(join(root,'.maw','maw.config.10.json'),{node:'project',nested:{remove:null},namedPeers:[{name:'a',url:'http://b'}]});
    let result=readMawConfig();assert.equal(result.node,'project');assert.deepEqual({...result.nested as object},{keep:1});assert.deepEqual(result.namedPeers,[{name:'a',url:'http://b'}]);
    write(join(root,'.maw','maw.config.10.local.json'),{node:'local',namedPeers:[]});assert.equal(readMawConfig().node,'local');assert.deepEqual(readMawConfig().namedPeers,result.namedPeers);
    write(join(root,'active','maw.config.20.json'),{node:'weight',namedPeers:null});result=readMawConfig();assert.equal(result.node,'weight');assert.equal(Object.hasOwn(result,'namedPeers'),false);
    rmSync(join(root,'.maw'),{recursive:true});rmSync(join(root,'active'),{recursive:true});
    write(file,{node:'fallback'});mkdirSync(join(root,'active'),{recursive:true});writeFileSync(join(root,'active','maw.config.1.json'),'{');assert.equal(readMawConfig().node,'fallback');
    write(join(root,'active','maw.config.2.json'),{});assert.equal(readMawConfig().node,undefined,'valid empty layer suppresses fallback');
    rmSync(join(root,'active'),{recursive:true});
    process.env.MAW_HOME=join(root,'instance');delete process.env.MAW_CONFIG_DIR;
    write(join(root,'.config','maw','maw.config.json'),{node:'inherited',other:1});
    write(join(root,'instance','config','maw.config.json'),{node:'instance'});
    assert.equal(readMawConfig().other,1);assert.equal(readMawConfig().node,'instance');
    process.env.MAW_CONFIG_DIR='';assert.equal(readMawConfig().other,undefined,'presence suppresses inheritance but MAW_HOME stays active');
    delete process.env.MAW_HOME;process.env.MAW_CONFIG_DIR=join(root,'active');
    // CWD ancestry is nearest 32 only, with deeper project scope winning ties.
    const deep = join(root,'tree',...Array.from({length:33},()=> 'd'));
    mkdirSync(deep,{recursive:true});
    write(join(root,'tree','.maw','maw.config.1.json'),{excluded:true});
    write(join(deep,'..','.maw','maw.config.2.json'),{node:'parent'});
    write(join(deep,'.maw','maw.config.2.json'),{node:'child'});
    assert.equal(readMawConfig(deep).excluded,undefined);assert.equal(readMawConfig(deep).node,'child');
    process.env.XDG_CONFIG_HOME='relative';delete process.env.MAW_CONFIG_DIR;
    assert.equal(readMawConfig().node,'inherited','relative XDG_CONFIG_HOME ignored');
    process.env.MAW_CONFIG_DIR=join(root,'active');delete process.env.XDG_CONFIG_HOME;
    write(file,JSON.parse('{"__proto__":{"polluted":true},"agents":{"ok":"agent","bad":{},"blank":""},"node":"node","namedPeers":[{"name":"good","url":"https://example.com/base"},{"name":"bad","url":"https://u:p@example.com"}],"federationToken":"private"}'));
    result=readMawConfig();assert.equal(({} as {polluted?:boolean}).polluted,undefined);
    const projection=projectMawConfig(result);assert.deepEqual(Object.keys(projection).sort(),['agents','namedPeers','node']);assert.deepEqual({...projection.agents},{ok:'agent',blank:''});assert.equal(projection.namedPeers?.length,1);assert.equal(JSON.stringify(projection).includes('private'),false);
    write(file,{node:'node',oracle:' oracle ',federationToken:' fleet '});process.env.MAW_PEER_KEY='key';
    let signing=readFederationConfig();assert.equal(signing.sender,'node:oracle');assert.equal(signing.fleet,'fleet');
    process.env.MAW_SENDER='';process.env.MAW_FEDERATION_TOKEN=' ';signing=readFederationConfig();assert.equal(signing.sender,'');assert.equal(signing.fleet,'fleet');assert.equal(existsSync(join(root,'.maw','peer-key')),false);
    writeFileSync(file,'x'.repeat(1048577));fail();
    writeFileSync(file,'{"a":'.repeat(65)+'{}'+'}'.repeat(65));fail();
    writeFileSync(file,Buffer.from([0xff]));assert.deepEqual({...readMawConfig()},{});
    writeFileSync(file,'\uFEFF{}');assert.deepEqual({...readMawConfig()},{});
    rmSync(file);symlinkSync(join(root,'absent'),file);fail();rmSync(file);
    rmSync(join(root,'active'),{recursive:true});symlinkSync(join(root,'absent'),join(root,'active'));fail();rmSync(join(root,'active'));
    mkdirSync(join(root,'active'));for(let i=0;i<129;i++)write(join(root,'active',`maw.config.${i}.json`),{});fail();rmSync(join(root,'active'),{recursive:true});
    mkdirSync(join(root,'active'));for(let i=0;i<1025;i++)write(join(root,'active',`clutter-${i}`),{});fail();rmSync(join(root,'active'),{recursive:true});
    for(let i=0;i<5;i++)write(join(root,'active',`maw.config.${i}.json`),{pad:'x'.repeat(900000)});fail();
    console.log('PASS maw config: private layered precedence/inheritance/fallback/merge, null/prototype safety, safe projection, signing presence, symlinks and depth/file/aggregate/layer/entry bounds');
  } finally {for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
}
