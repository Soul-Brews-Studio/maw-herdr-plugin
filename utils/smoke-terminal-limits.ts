import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openHerdrTerminal } from "../src/serve/bun/mod.openHerdrTerminal.ts";
const root = mkdtempSync("/tmp/herdr-pty-adverse-");
const target = {session:"fixture",pane:{id:"w1:p1"}} as any;
try {
for (const [mode, code] of Object.entries({stderr:"process.stderr.write(Buffer.alloc(65537));setInterval(()=>{},1000)", inherited:"require(\"node:child_process\").spawn(process.execPath,[\"-e\",\"setInterval(()=>{},1000)\"],{stdio:[\"ignore\",1,2]});process.exit(0)", input:"setInterval(()=>{},1000)"})) {
 const file = join(root,mode); writeFileSync(file,`#!${process.execPath}\n${code}\n`); chmodSync(file,0o700);
 const controller = new AbortController(); const start=Date.now();
 const terminal=openHerdrTerminal(file,target,80,24,()=>{},controller.signal);
 if(mode==="input") { let overflow=false; for(let i=0;i<100;i++)try{terminal.input(Buffer.alloc(65536));}catch{overflow=true;break;} if(!overflow)throw Error("no overflow"); }
 await Promise.race([terminal.done,new Promise((_,reject)=>setTimeout(()=>reject(Error(`${mode} cleanup timeout`)),2200))]);
 console.log(`PASS ${mode}: child cleanup ${Date.now()-start}ms`);
}

} finally { rmSync(root, {recursive:true,force:true}); }
