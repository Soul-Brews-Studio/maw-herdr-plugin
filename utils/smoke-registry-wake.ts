#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,realpathSync,writeFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveRegistryWake} from '../src/serve/bun/mod.resolveRegistryWake.ts';
const root=realpathSync(mkdtempSync(join(tmpdir(),'herdr-registry-guards-')));
const previous=process.env.MAW_ORACLES_JSON;
const registry=join(root,'oracles.json'),repo=join(root,'repo with spaces');
mkdirSync(join(repo,'.git'),{recursive:true});
const record={name:'fixture',org:'org',repo:'repo',local_path:repo};
const save=(value:unknown)=>writeFileSync(registry,JSON.stringify(value));
const fail=(target='fixture',code='backend_error')=>assert.throws(()=>resolveRegistryWake(target),(error: unknown)=>!!error && typeof error==='object' && 'code' in error && error.code===code);
try {
  process.env.MAW_ORACLES_JSON=registry;
  fail('fixture','target_not_found');assert.equal(existsSync(registry),false);
  save({oracles:[record]});assert.deepEqual(resolveRegistryWake('fixture'),{name:'fixture',path:repo});assert.deepEqual(resolveRegistryWake('org/repo'),{name:'fixture',path:repo});
  for(const target of ['unknown','../repo','/absolute','org/../repo','-flag','fixture\0'])fail(target,'target_not_found');
  save({oracles:[record,{...record,org:'other'}]});fail('fixture','target_not_found');
  for(const value of [null,[],{}, {oracles:{}},{oracles:[null]},{oracles:[{...record,name:7}]},{oracles:Array.from({length:1025},()=>record)}]){save(value);fail();}
  writeFileSync(registry,Buffer.from([0xff]));fail();writeFileSync(registry,'x'.repeat(1048577));fail();
  for(const local_path of ['relative',join(root,'missing')]) {save({oracles:[{...record,local_path}]});fail('fixture','backend_error');}
  const noGit=join(root,'not-checkout');mkdirSync(noGit);save({oracles:[{...record,local_path:noGit}]});fail('fixture','backend_error');
  const alias=join(root,'alias');symlinkSync(repo,alias);save({oracles:[{...record,local_path:alias}]});assert.equal(resolveRegistryWake('fixture').path,repo);
  rmSync(join(repo,'.git'),{recursive:true});writeFileSync(join(repo,'.git'),'gitdir: fixture');assert.equal(resolveRegistryWake('fixture').path,repo);
  rmSync(join(repo,'.git'));symlinkSync(join(root,'target-git'),join(repo,'.git'));fail();
  rmSync(registry);symlinkSync(join(root,'missing-registry'),registry);fail();rmSync(registry);
  symlinkSync(root,join(root,'link'));process.env.MAW_ORACLES_JSON=join(root,'link','missing.json');fail();
  console.log('PASS registry guards: exact/ambiguous selectors, canonical local checkout, schema/UTF8/size/count, missing/no writes, registry and git symlinks');
} finally {if(previous===undefined)delete process.env.MAW_ORACLES_JSON;else process.env.MAW_ORACLES_JSON=previous;rmSync(root,{recursive:true,force:true});}
