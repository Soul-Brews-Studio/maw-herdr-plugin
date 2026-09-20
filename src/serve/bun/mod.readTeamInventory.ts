import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HTTPError } from './serverTypes.ts';

// Operator home only; never associate legacy tmux IDs with Herdr pane identities.
export function readTeamInventory(home = homedir(), now = Date.now()) {
  const fail = (): never => { throw new HTTPError(503, 'teams_unavailable'); };
  let bytesRead = 0, tasksRead = 0, membersRead = 0, outputBytes = 0;
  const root = resolve(home);
  const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const local = (cwd: string) => {
    if (!isAbsolute(cwd)) return false;
    const path = relative(root, resolve(cwd));
    return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
  };
  const checked = (path: string, directory: boolean) => {
    const relativePath = relative(root, path);
    if (relativePath === '..' || relativePath.startsWith('..' + sep) || isAbsolute(relativePath)) fail();
    const parts = relativePath ? relativePath.split(sep) : [];
    let current = root;
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = join(current, parts[index]);
      let stat;
      try { stat = lstatSync(current); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; return fail(); }
      if (stat.isSymbolicLink() || (index < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) fail();
      if (index === parts.length - 1) return stat;
    }
    return undefined;
  };
  const entries = (path: string, limit: number) => {
    if (!checked(path, true)) return [];
    const names: string[] = [];
    let directory;
    try {
      directory = opendirSync(path);
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        if (names.length >= limit) fail();
        names.push(entry.name);
      }
      checked(path, true);
    } catch { fail(); }
    finally { directory?.closeSync(); }
    return names.sort();
  };
  const json = (path: string): Record<string, unknown> | undefined => {
    const before = checked(path, false);
    if (!before) return undefined;
    if (before.size > 1024 * 1024 || bytesRead + before.size > 4 * 1024 * 1024) fail();
    let fd: number | undefined;
    let content: Buffer;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > 1024 * 1024) fail();
      const buffer = Buffer.alloc(Math.min(1024 * 1024 + 1, 4 * 1024 * 1024 - bytesRead + 1));
      let length = 0;
      while (length < buffer.length) {
        const size = readSync(fd, buffer, length, buffer.length - length, null);
        if (!size) break;
        length += size;
      }
      if (length > 1024 * 1024 || bytesRead + length > 4 * 1024 * 1024) fail();
      const after = checked(path, false);
      if (!after || after.dev !== stat.dev || after.ino !== stat.ino) fail();
      bytesRead += length;
      content = buffer.subarray(0, length);
    } catch { return fail(); }
    finally { if (fd !== undefined) closeSync(fd); }
    try { return object(JSON.parse(content.toString('utf8'))); } catch { return undefined; }
  };
  const teams: Array<Record<string, unknown>> = [];
  const teamsRoot = join(root, '.claude', 'teams'), tasksRoot = join(root, '.claude', 'tasks');
  for (const directory of entries(teamsRoot, 100)) {
    const teamRoot = join(teamsRoot, directory);
    let entry;
    try { entry = lstatSync(teamRoot); } catch { fail(); }
    if (entry!.isFile()) continue;
    checked(teamRoot, true);
    const config = json(join(teamRoot, 'config.json'));
    if (!config) continue;
    const name = text(config.name) || directory, leadRepo = text(config.leadRepo), createdAt = integer(config.createdAt);
    const leadAgentId = `team-lead@${name}`;
    const rawMembers = Array.isArray(config.members) ? config.members : [];
    membersRead += rawMembers.length;
    if (membersRead > 1000) fail();
    let normalizedBytes = 0;
    const members = rawMembers.map(value => {
      const member = object(value) || {};
      const memberName = text(member.name) || (text(member.agentId).includes('@') ? text(member.agentId).split('@')[0] : '') || 'member';
      const agentId = text(member.agentId) || `${memberName}@${name}`;
      const normalized = { name: memberName, agentId, agentType: text(member.agentType) || (agentId === leadAgentId || memberName === 'team-lead' || memberName === 'lead' ? 'lead' : 'member'), joinedAt: typeof member.joinedAt === 'number' && Number.isSafeInteger(member.joinedAt) && member.joinedAt >= 0 ? member.joinedAt : createdAt,
        tmuxPaneId: text(member.tmuxPaneId), cwd: text(member.cwd) || text(member.repo) || leadRepo, subscriptions: Array.isArray(member.subscriptions) ? member.subscriptions.filter(item => typeof item === 'string') : [],
        backendType: typeof member.backendType === 'string' ? member.backendType : 'in-process', model: text(member.model), repo: text(member.repo), color: text(member.color) };
      normalizedBytes += Buffer.byteLength(JSON.stringify(normalized));
      if (normalizedBytes > 4 * 1024 * 1024) fail();
      return normalized;
    });
    const tasks: Array<Record<string, unknown>> = [];
    const taskRoot = join(tasksRoot, directory);
    for (const filename of entries(taskRoot, 1001)) {
      if (!filename.endsWith('.json')) continue;
      if (++tasksRead > 1000) fail();
      const task = json(join(taskRoot, filename));
      if (!task) continue;
      const value: Record<string, unknown> = {};
      for (const key of ['id', 'subject', 'description', 'activeForm', 'owner', 'status']) if (typeof task[key] === 'string') value[key] = task[key];
      if (typeof task.id === 'number' && Number.isSafeInteger(task.id)) value.id = task.id;
      for (const key of ['blocks', 'blockedBy']) if (Array.isArray(task[key])) value[key] = task[key].filter(item => typeof item === 'string');
      normalizedBytes += Buffer.byteLength(JSON.stringify(value));
      if (normalizedBytes > 4 * 1024 * 1024) fail();
      tasks.push(value);
    }
    const alive = members.some(member => (member.backendType === 'in-process' || member.agentType === 'team-lead' || member.name === 'team-lead') && local(member.cwd) && Math.max(0, now - member.joinedAt) < 2 * 60 * 60 * 1000);
    const team = { name, description: text(config.description), leadRepo, leadSessionId: text(config.leadSessionId), leadAgentId, createdAt, members, tasks, alive };
    outputBytes += Buffer.byteLength(JSON.stringify(team));
    if (outputBytes > 4 * 1024 * 1024) fail();
    teams.push(team);
  }
  teams.sort((left, right) => String(left.name) < String(right.name) ? -1 : String(left.name) > String(right.name) ? 1 : 0);
  const result = { teams, total: teams.length };
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) fail();
  return result;
}
