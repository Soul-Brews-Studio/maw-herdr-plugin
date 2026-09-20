import { deliverReceiverInbox } from './mod.deliverReceiverInbox.ts';
import { resolveWakeIdentity } from "./mod.resolveWakeIdentity.ts";
import { registerWakeFleet } from "./mod.registerWakeFleet.ts";
import { runWakeHooks } from "./mod.runWakeHooks.ts";
import { readMawConfig } from './mod.readMawConfig.ts';
import { resolveWakeLaunch } from './mod.resolveWakeLaunch.ts';
import { launchConfiguredWake } from './mod.launchConfiguredWake.ts';
import { planTaskWorktree } from './mod.planTaskWorktree.ts';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { resolveRegistryWake } from './mod.resolveRegistryWake.ts';
import { createFederation } from './mod.createFederation.ts';
import { readTeamInventory } from './mod.readTeamInventory.ts';
import { createObservedFeed } from "./mod.createObservedFeed.ts";
import { createHash } from "node:crypto";
import { BackendError, type Backend, type RunHerdr, type Session } from "./types.ts";
import { readRoster } from "./mod.readRoster.ts";
import { openHerdrTerminal } from "./mod.openHerdrTerminal.ts";
import { runHerdr } from "./mod.runHerdr.ts";

export function createHerdrBackend(binary: string, wakeEngine = "codex", explicitWakeEngine?: string): Backend {
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const waiters: Array<() => void> = [];
  let wakeTail: Promise<void> = Promise.resolve();
  let dashboardSnapshot: Promise<Session[]> | undefined;
  let active = 0, terminals = 0, waking = 0;
  const run: RunHerdr = (args, signal) => runHerdr(binary || "herdr", args, signal);
  async function operation<T>(fn: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    if (shutdown.signal.aborted || caller?.aborted) throw new BackendError("backend_error", "herdr operation aborted");
    if (active >= 8 && waiters.length >= 64) throw new BackendError("backend_error", "herdr operation queue is full");
    const controller = new AbortController();
    const abort = () => controller.abort();
    shutdown.signal.addEventListener("abort", abort, { once: true });
    caller?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 10_000);
    let acquired = false;
    const task = (async () => {
      try {
        if (active >= 8) {
          await new Promise<void>((resolve, reject) => {
            const ready = () => { controller.signal.removeEventListener("abort", cancelled); resolve(); };
            const cancelled = () => {
              const index = waiters.indexOf(ready);
              if (index >= 0) waiters.splice(index, 1);
              reject(new BackendError("backend_error", "herdr operation aborted"));
            };
            waiters.push(ready);
            controller.signal.addEventListener("abort", cancelled, { once: true });
          });
        } else active++;
        acquired = true;
        if (controller.signal.aborted) throw new BackendError("backend_error", "herdr operation aborted");
        return await fn(controller.signal);
      } finally {
        clearTimeout(timer);
        caller?.removeEventListener("abort", abort);
        shutdown.signal.removeEventListener("abort", abort);
        if (acquired) {
          const next = waiters.shift();
          if (next) next();
          else active--;
        }
      }
    })();
    pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  }
  const backend: Backend = {
    federation: createFederation(shutdown.signal),
    teamInventory: () => readTeamInventory(),
    observedFeed: createObservedFeed(),
    async dashboardSessions(signal) {
      if (signal?.aborted) throw new BackendError("backend_error", "herdr operation aborted");
      // Share one acquisition + observation among dashboard clients. A slower
      // old roster can never publish after a newer status observation.
      dashboardSnapshot ??= operation(async (s) => {
        const sessions = (await readRoster(run, s)).sessions;
        backend.observedFeed.observe(sessions);
        return sessions;
      }).finally(() => { dashboardSnapshot = undefined; });
      const sessions = await dashboardSnapshot;
      if (signal?.aborted) throw new BackendError("backend_error", "herdr operation aborted");
      return sessions;
    },
    sessions: (signal) => operation(async (s) => (await readRoster(run, s)).sessions, signal),
    async capture(target, lines, signal) {
      const captures = await backend.captureBatch({ [target]: lines }, signal);
      return captures[target];
    },
    async captureBatch(targets, signal) {
      const keys = Object.keys(targets).sort();
      if (keys.length > 64) throw new BackendError("backend_error", "capture batch exceeds 64 targets");
      const requests = new Map<string, number>();
      for (const key of keys) {
        const lines = targets[key];
        if (!Number.isInteger(lines) || lines < 1 || lines > 2000) throw new BackendError("backend_error", "capture lines must be between 1 and 2000");
        requests.set(key, lines);
      }
      return operation(async (s) => {
        const captures: Record<string, string> = Object.create(null);
        if (!keys.length) return captures;
        const roster = await readRoster(run, s);
        for (const key of keys) if (!roster.targets.has(key)) throw new BackendError("target_not_found", "unknown or stale target");
        for (const key of keys) {
          const target = roster.targets.get(key)!;
          captures[key] = await run(["--session", target.session, "pane", "read", target.pane.id, "--source", "visible", "--lines", String(requests.get(key)), "--format", "text"], s);
        }
        if (s.aborted) throw new BackendError("backend_error", "herdr operation aborted");
        return captures;
      }, signal);
    },
    async wake(target, signal, task) {
      if (!target || Buffer.byteLength(target) > 1024) throw new BackendError("target_not_found", "unknown or stale target");
      if(waking>=8) throw new BackendError("backend_error","wake capacity reached");
      waking++;
      try { return await operation(async (s) => {
        const previous = wakeTail;
        let release!: () => void;
        wakeTail = new Promise<void>(resolve => { release = resolve; });
        try {
          await new Promise<void>((resolve,reject) => {
            const abort = () => reject(new BackendError("backend_error","herdr operation aborted"));
            s.addEventListener("abort",abort,{once:true});
            previous.then(() => { s.removeEventListener("abort",abort); resolve(); });
            if(s.aborted) abort();
          });
          if(s.aborted) throw new BackendError("backend_error","herdr operation aborted");
          let roster = await readRoster(run,s);
          let pane = roster.targets.get(target);
          let launchWindow = pane?.pane.workspaceLabel || pane?.pane.label || pane?.pane.title || pane?.pane.id || "";
          let basePath = "";
          let oracle = launchWindow;
          if(pane && task!==undefined) throw new BackendError("backend_error","task requires a registered repository");
          if (!pane) {
            const repo = resolveRegistryWake(target);
            basePath=repo.path; oracle=repo.name;
            const session = roster.runningSessions.includes("default") ? "default" : roster.runningSessions.length===1 ? roster.runningSessions[0] : undefined;
            if(!session) throw new BackendError("backend_error","running session is ambiguous or missing");
            if(task!==undefined) {
              const plan=await planTaskWorktree(repo.path,task,s);
              const label=repo.name+"-"+plan.slug;
              if(Buffer.byteLength(label)>1024) throw new BackendError("backend_error","invalid task label");
              for(const item of roster.targets.values()) {
                if(item.session!==session || (item.pane.label!==label && item.pane.title!==label && item.pane.workspaceLabel!==label)) continue;
                let cwd;try{cwd=realpathSync(item.pane.cwd);}catch{throw new BackendError("backend_error","task pane cwd mismatch");}
                if(!isAbsolute(item.pane.cwd)||cwd!==plan.path)throw new BackendError("backend_error","task pane cwd mismatch");
              }
              await plan.materialize();repo.path=plan.path;repo.name=label;
              roster=await readRoster(run,s);
            }
            launchWindow=repo.name;
            const matches = [...roster.targets.values()].filter(item => {
              if(item.session!==session || !isAbsolute(item.pane.cwd)) return false;
              try { return realpathSync(item.pane.cwd)===repo.path; } catch { return false; }
            });
            if(matches.length>1) throw new BackendError("backend_error","repository pane is ambiguous");
            pane=matches[0];
            if(!pane) {
              let created;
              try { created=JSON.parse(await run(["--session",session,"workspace","create","--cwd",repo.path,"--label",repo.name,"--no-focus"],s)); }
              catch { throw new BackendError("backend_error","workspace creation failed"); }
              const result=created?.result;
              if(created?.error!=null || result?.error!=null || result?.type!=="workspace_created" || !result.tab || typeof result.tab!=="object" || Array.isArray(result.tab) || typeof result.root_pane?.pane_id!=="string" || typeof result.workspace?.workspace_id!=="string" || result.root_pane.workspace_id!==result.workspace.workspace_id) throw new BackendError("backend_error","workspace identity not verified");
              roster=await readRoster(run,s);
              pane=[...roster.targets.values()].find(item=>item.session===session && item.pane.id===result.root_pane.pane_id && item.pane.workspace===result.workspace.workspace_id);
              if(!pane || !isAbsolute(pane.pane.cwd)) throw new BackendError("backend_error","workspace identity not verified");
              let cwd; try {cwd=realpathSync(pane.pane.cwd);} catch {throw new BackendError("backend_error","workspace cwd not verified");}
              if(cwd!==repo.path) throw new BackendError("backend_error","workspace cwd not verified");
              const sameRepo = [...roster.targets.values()].filter(item => {
                if(item.session!==session || !isAbsolute(item.pane.cwd)) return false;
                try {return realpathSync(item.pane.cwd)===repo.path;} catch {return false;}
              });
              if(sameRepo.length!==1) throw new BackendError("backend_error","repository pane is ambiguous");
            }
          }

        if(!isAbsolute(pane.pane.cwd)) throw new BackendError("backend_error","pane cwd unavailable");
        let finalCwd;try{finalCwd=realpathSync(pane.pane.cwd);}catch{throw new BackendError("backend_error","pane cwd unavailable");}
        if(!basePath){const identity=await resolveWakeIdentity(finalCwd,launchWindow,s);basePath=identity.basePath;oracle=identity.oracle;}
        const merged=readMawConfig(finalCwd);
        const resolvedPane=pane;
        const finish=async(state:"ready"|"launched"|"already-awake")=>{
          if(s.aborted) throw new BackendError("backend_error","herdr operation aborted");
          const fresh=await readRoster(run,s);
          const stillResolved=[...fresh.targets.values()].some(p=>{
            if(p.session!==resolvedPane.session||p.pane.id!==resolvedPane.pane.id||p.pane.workspace!==resolvedPane.pane.workspace||!isAbsolute(p.pane.cwd))return false;
            try{return realpathSync(p.pane.cwd)===finalCwd;}catch{return false;}
          });
          if(!stillResolved)throw new BackendError("backend_error","wake pane identity changed");
          const live=[...fresh.targets.values()].filter(p=>p.session===resolvedPane.session).map(p=>({name:p.pane.workspaceLabel||p.pane.label||p.pane.title||p.pane.id,cwd:p.pane.cwd}));
          if(s.aborted)throw new BackendError("backend_error","herdr operation aborted");
          registerWakeFleet(resolvedPane.session,live,basePath,launchWindow);
          await runWakeHooks(merged,oracle,resolvedPane.session,launchWindow,s);
          return state;
        };
        if(pane.pane.agent.trim()) return await finish("already-awake");
        if(["commands","wake","defaultEngine","zaiPool"].some(key=>Object.hasOwn(merged,key))){
          let launch;try{launch=resolveWakeLaunch(merged,launchWindow,explicitWakeEngine);}catch{throw new BackendError("backend_error","configured launch unavailable");}
          return await finish(await launchConfiguredWake(run,pane,launch.line,s));
        }
        const name = "maw-" + createHash("sha256").update(pane.pane.id).digest("hex").slice(0, 16);
        const raw = await run(["--session", pane.session, "agent", "start", name, "--kind", wakeEngine, "--pane", pane.pane.id, "--timeout", "8000"], s);
        let response;
        try { response = JSON.parse(raw); } catch { throw new BackendError("backend_error", "invalid agent start response"); }
        const result = response?.result, agent = result?.agent;
        if (!response || typeof response !== "object" || Array.isArray(response) || response.error != null || result?.error != null || result?.type !== "agent_started" || !Array.isArray(result.argv) || !result.argv.every((arg: unknown) => typeof arg === "string") || !agent || agent.pane_id !== pane.pane.id || agent.agent !== wakeEngine || agent.interactive_ready !== true || (agent.launch_pending !== undefined && agent.launch_pending !== false) || s.aborted) throw new BackendError("backend_error", "agent readiness not verified");
        return await finish("ready");
        } finally { previous.then(release); }
      }, signal); } finally { waking--; }
    },
    async sendLiteral(target, text, enter, signal) {
      if (!target || Buffer.byteLength(target) > 1024) throw new BackendError("target_not_found", "unknown or stale target");
      if (Buffer.byteLength(text, "utf8") > 64 * 1024 || text.includes("\0")) throw new BackendError("backend_error", "invalid literal text");
      await operation(async (s) => {
        const pane = (await readRoster(run, s)).targets.get(target);
        if (!pane) throw new BackendError("target_not_found", "unknown or stale target");
        await run(["--session", pane.session, "pane", "send-text", pane.pane.id, text], s);
        if (enter) await run(["--session", pane.session, "pane", "send-keys", pane.pane.id, "enter"], s);
      }, signal);
    },
    inbox: (target, text, serverRoot, from, signal) => operation(s => deliverReceiverInbox(run, target, text, serverRoot, from, s), signal),
    async send(target, text, signal) {
      if (!text.trim() || Buffer.byteLength(text, "utf8") > 64 * 1024 || text.includes("\0")) throw new BackendError("backend_error", "invalid prompt text");
      await operation(async (s) => {
        const pane = (await readRoster(run, s)).targets.get(target);
        if (!pane) throw new BackendError("target_not_found", "unknown or stale target");
        if (!pane.pane.agent.trim()) throw new BackendError("target_not_agent", "target is not an agent pane");
        await run(["--session", pane.session, "agent", "prompt", pane.pane.id, text], s);
      }, signal);
    },
    async openTerminal(target, cols, rows, output, signal) {
      if (terminals >= 16) throw new BackendError("backend_error", "terminal capacity reached");
      terminals++;
      try {
        const pane = await operation(async (s) => {
          const found = (await readRoster(run, s)).targets.get(target);
          if (!found) throw new BackendError("target_not_found", "unknown or stale target");
          return found;
        }, signal);
        const terminal = openHerdrTerminal(binary || "herdr", pane, cols, rows, output, AbortSignal.any([signal, shutdown.signal]));
        pending.add(terminal.done);
        void terminal.done.finally(() => { terminals--; pending.delete(terminal.done); });
        return terminal;
      } catch (error) { terminals--; throw error; }
    },
    async close() {
      shutdown.abort();
      await Promise.allSettled([...pending, backend.federation.close()]);
    },
  };
  return backend;
}
