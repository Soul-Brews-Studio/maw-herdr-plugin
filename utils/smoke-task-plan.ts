#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planTaskWorktree,taskSlug} from '../src/serve/bun/mod.planTaskWorktree.ts';
const root=realpathSync(mkdtempSync(join(tmpdir(),'herdr-task-plan-'))),repo=join(root,'repo with spaces');mkdirSync(repo);
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
const git=(...args:string[])=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','-C',repo,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000});
try {
  git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('commit','--allow-empty','-m','fixture');
  const signal=AbortSignal.timeout(30000);
  assert.equal(taskSlug('Issue 90'),'issue-90');assert.equal(taskSlug('feat/foo'),'featfoo');assert.equal(taskSlug('foo..'),'foo');assert.equal(taskSlug('foo.lock'),'foo.lock');assert.equal(taskSlug('x'.repeat(60)),'x'.repeat(50));
  for(const raw of ['','-bad','x\0','...','ภาษา','x'.repeat(1025)])assert.throws(()=>taskSlug(raw));
  let plan=await planTaskWorktree(repo,'Issue 90',signal);assert.equal(plan.create,true);assert.equal(existsSync(plan.path),false);await plan.materialize();assert.equal(plan.path,join(repo,'agents','issue-90'));
  writeFileSync(join(plan.path,'dirty.txt'),'preserve');plan=await planTaskWorktree(repo,'issue-90',signal);assert.equal(plan.create,false);await plan.materialize();assert.equal(readFileSync(join(plan.path,'dirty.txt'),'utf8'),'preserve');
  git('branch','agents/collision');plan=await planTaskWorktree(repo,'collision',signal);assert.equal(plan.branch,'agents/1-collision');await plan.materialize();
  git('worktree','add',join(repo,'agents','20-suffix'),'-b','agents/20-suffix');plan=await planTaskWorktree(repo,'suffix',signal);assert.equal(plan.create,false);assert.equal(plan.branch,'agents/20-suffix');
  git('worktree','add',join(root,'repo with spaces.wt-sibling'),'-b','agents/sibling');plan=await planTaskWorktree(repo,'sibling',signal);assert.equal(plan.path,join(root,'repo with spaces.wt-sibling'));
  for(const name of ['21-ambiguous','22-ambiguous'])git('worktree','add',join(repo,'agents',name),'-b','agents/'+name);
  await assert.rejects(planTaskWorktree(repo,'ambiguous',signal));
  mkdirSync(join(repo,'agents','occupied'));await assert.rejects(planTaskWorktree(repo,'occupied',signal));
  plan=await planTaskWorktree(repo,'bad.lock',signal);await assert.rejects(plan.materialize());assert.equal(existsSync(plan.path),false);
  symlinkSync(join(root,'escape'),join(repo,'agents','escape'));await assert.rejects(planTaskWorktree(repo,'escape',signal));
  const aborted=new AbortController();aborted.abort();await assert.rejects(planTaskWorktree(repo,'cancelled',aborted.signal));
  console.log('PASS task plan: sanitizer, real Git create/repeat, dirty preservation, branch allocation, registered suffix/sibling, ambiguity/occupied/symlink/invalid branch/cancellation guards');
} finally {rmSync(root,{recursive:true,force:true});}
