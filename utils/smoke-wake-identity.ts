#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWakeIdentity } from "../src/serve/bun/mod.resolveWakeIdentity.ts";
const root=realpathSync(mkdtempSync(join(tmpdir(),"herdr-wake-identity-"))),old=process.env.MAW_ORACLES_JSON;
const repo=join(root,"github.com","org","base-oracle"),task=join(repo,"agents","task"),registry=join(root,"registry.json");
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_")));
Object.assign(env,{GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0"});
const git=(...args:string[])=>execFileSync("git",["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","commit.gpgsign=false","-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-C",repo,...args],{env,stdio:"pipe"});
const entry={name:"original-oracle",local_path:repo};
const save=(...oracles:unknown[])=>writeFileSync(registry,JSON.stringify({oracles}));
const signal=new AbortController().signal;
try {
  mkdirSync(repo,{recursive:true});git("init");git("commit","--allow-empty","-m","fixture");git("worktree","add",task,"-b","task");
  process.env.MAW_ORACLES_JSON=registry;save(entry);
  for(const cwd of [repo,task])assert.deepEqual(await resolveWakeIdentity(cwd,"task-window",signal),{basePath:repo,oracle:entry.name});
  const fake=join(repo,"agents","not-a-worktree");mkdirSync(fake);
  assert.deepEqual(await resolveWakeIdentity(fake,"fallback",signal),{basePath:fake,oracle:"fallback"});
  save(entry,{...entry,name:"alias"});await assert.rejects(resolveWakeIdentity(task,"task-window",signal),/registry unavailable/);
  save(entry,{name:"task-alias",local_path:task});await assert.rejects(resolveWakeIdentity(task,"task-window",signal),/registry unavailable/);
  for(const raw of ['{broken','{"oracles":[null]}','{"oracles":[{"name":"broken","local_path":"relative"}]}']){
    writeFileSync(registry,raw);await assert.rejects(resolveWakeIdentity(task,"task-window",signal),/registry unavailable/);
  }
  rmSync(registry);assert.deepEqual(await resolveWakeIdentity(task,"fallback",signal),{basePath:task,oracle:"fallback"});
  const controller=new AbortController();controller.abort();await assert.rejects(resolveWakeIdentity(task,"fallback",controller.signal));
  console.log("PASS canonical wake identity: real Git membership, original base/name, no layout guessing, ambiguity/malformed rejection, missing registry fallback, cancellation");
} finally {
  if(old===undefined)delete process.env.MAW_ORACLES_JSON;else process.env.MAW_ORACLES_JSON=old;
  rmSync(root,{recursive:true,force:true});
}
