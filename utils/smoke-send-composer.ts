#!/usr/bin/env bun
// Input-box parsing for HTTP send. Fixtures copy the shapes measured read-only
// from real herdr panes (`herdr pane read <pane> --source visible --format ansi`)
// on 2026-09-25: Claude Code's ruled box with a dim suggestion, Codex's `›`
// line with a dim placeholder and a model/context footer.
import assert from 'node:assert/strict';
import { composerMatchesSent, lastNonEmptyLine, parseComposer, visibleText } from '../src/serve/bun/mod.parseComposer.ts';
import { formatSenderMessage } from '../src/serve/bun/mod.formatSenderMessage.ts';

const E = '\x1b', dim = (s: string) => `${E}[0m${E}[2m${s}${E}[0m`;
const rule = '─'.repeat(40);
const claudeFooter = ['  🖥  m5/beta  📁 laris-co/neo-oracle  main@9accb25a', '  🌱 Soul-Brews-Studio/maw-cli  +4', '  📡 5ff7e64f • Opus', '  ── wt ── main', '  ⏵⏵ bypass permissions on (shift+tab to cycle)', '', '  ◯ workflow  0/4 agents done'];
const claude = (box: string[]) => ['● previous answer', '', `${rule} ultracode ─`, ...box, rule, ...claudeFooter].join('\r\n');
const codexFooter = ' \r\n  ' + `${E}[38;2;246;226;183mgpt-5.6-terra max${E}[0m${dim(' · ')}${E}[38;2;242;181;144mContext 82% left${E}[0m`;
const codex = (line: string) => `  done\r\n\r\n${dim('  Worked for 18m')}\r\n \r\n${E}[0m${E}[1m${E}[38;2;255;178;66m›${E}[0m ${line}\r\n${codexFooter}`;

assert.deepEqual(parseComposer(claude([`❯ ${dim('/wf-peek')}`])), { state: 'empty' }, 'dim suggestion is not a draft');
assert.deepEqual(parseComposer(claude(['❯ '])), { state: 'empty' });
assert.deepEqual(parseComposer(claude(['❯ half typed', '  second line'])), { state: 'pending', text: 'half typed\nsecond line' }, 'unknown emoji footer does not hide a draft');
assert.deepEqual(parseComposer(codex(dim('Ask Codex to do anything'))), { state: 'empty' });
assert.deepEqual(parseComposer(codex('fix the flaky test')), { state: 'pending', text: 'fix the flaky test' });
// 38;2;R;G;B carries a literal 2 that is a colour component, not SGR dim.
assert.deepEqual(parseComposer(`${E}[38;2;2;2;2m›${E}[0m ${E}[48;2;39;42;48mreal draft${E}[0m\r\n  gpt-5 · 80% context left`), { state: 'pending', text: 'real draft' });
assert.deepEqual(parseComposer('build output\n$ \n'), { state: 'empty' });
assert.deepEqual(parseComposer('build output\n$ make test\n'), { state: 'pending', text: 'make test' });
assert.deepEqual(parseComposer('just output, no prompt\nmore output'), { state: 'unknown' });
assert.deepEqual(parseComposer('> quoted line\nplain output after it'), { state: 'unknown' }, 'a quote followed by output is not an input box');
assert.deepEqual(parseComposer('$HOME is set\n'), { state: 'unknown' });
assert.equal(visibleText(`a${E}]0;title${E}\\b${E}[2mc${E}[22md`), 'abd');
assert.equal(lastNonEmptyLine(claude(['❯ '])), '  ◯ workflow  0/4 agents done');
assert.ok(composerMatchesSent('[local:x] hello', '[local:x] hello'));
assert.ok(composerMatchesSent('first', 'first\nsecond'));
assert.ok(!composerMatchesSent('someone else', 'first'));
assert.ok(!composerMatchesSent('', ''));

// Sender tag, maw-rs sender_identity.rs format_local_hey_message.
assert.equal(formatSenderMessage('hello', 'neo:white', 'm5:server'), '[white:neo] hello', 'wire oracle:node shows as node:oracle');
assert.equal(formatSenderMessage('hello', '', 'm5:server'), '[m5:server] hello');
assert.equal(formatSenderMessage('hello', 'no-colon', 'm5:server'), '[m5:server] hello', 'non-wire header falls back to the local identity');
assert.equal(formatSenderMessage('hello', 'neo:', 'm5:server'), '[m5:server] hello');
assert.equal(formatSenderMessage('/compact', 'neo:white', 'm5:server'), '/compact', 'slash commands pass through');
assert.equal(formatSenderMessage('/abs/path\nlook', 'neo:white', 'm5:server'), '/abs/path\nlook', 'legacy: an absolute-path first attachment is untagged too');
assert.equal(formatSenderMessage('', 'neo:white', 'm5:server'), '[white:neo] ');
console.log('PASS send composer: dim placeholders, ruled Claude box, Codex footer, SGR colour params, shells, unknown; sender tag');
