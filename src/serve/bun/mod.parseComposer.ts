/**
 * What an agent's input box holds, read from `herdr pane read --format ansi`.
 *
 * Ported from maw-tmux pending_input_detection.rs (maw-rs 76f1308), with two
 * measured changes for herdr panes:
 *
 * - Dim text is dropped before parsing. Claude Code and Codex both render
 *   their placeholder ("Ask Codex to do anything", a suggested `/command`)
 *   with SGR 2; the legacy tmux capture stripped styling and so read a
 *   placeholder as a draft. A real draft is not dim.
 * - Claude Code draws its box between two horizontal rules with a multi-line
 *   footer underneath that the legacy chrome list does not recognise (repo and
 *   context lines start with arbitrary emoji). A prompt line directly under a
 *   rule and closed by a second rule is read as the box, whatever the footer.
 *
 * `unknown` means no input box was recognised. That is not evidence of an empty
 * box; callers must not report delivery on it.
 */
export type Composer = { state: 'pending'; text: string } | { state: 'empty' } | { state: 'unknown' };

const MARKERS = new Set(['#', '$', '%', '>', '›', '❯', '»']);
const RULE = /^[─━╌┄┈]{3,}/;

/** Remove escape sequences; unless keepDim, also drop text rendered dim (placeholders). */
export function visibleText(input: string, keepDim = false): string {
  let out = '', dim = false;
  for (let i = 0; i < input.length;) {
    if (input[i] === '\x1b') {
      if (input[i + 1] === '[') {
        let j = i + 2;
        while (j < input.length && /[0-9;:?<=>]/.test(input[j])) j++;
        const final = input[j];
        if (final === 'm') {
          const params = input.slice(i + 2, j).split(';');
          for (let k = 0; k < params.length; k++) {
            const code = params[k] === '' ? 0 : Number(params[k].split(':')[0]);
            if (code === 38 || code === 48 || code === 58) { k += params[k + 1] === '5' ? 2 : params[k + 1] === '2' ? 4 : 0; continue; }
            if (code === 0 || code === 22) dim = false;
            else if (code === 2) dim = true;
          }
        }
        i = j + 1;
        continue;
      }
      if (input[i + 1] === ']') { // OSC: title/hyperlink, ended by BEL or ST
        let j = i + 2;
        while (j < input.length && input[j] !== '\x07' && !(input[j] === '\x1b' && input[j + 1] === '\\')) j++;
        i = input[j] === '\x07' ? j + 1 : j + 2;
        continue;
      }
      i += 2;
      continue;
    }
    const ch = String.fromCodePoint(input.codePointAt(i)!);
    if (keepDim || !dim || ch === '\n') out += ch;
    i += ch.length;
  }
  return out.replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
}

type PromptLine = { kind: 'pending'; text: string } | { kind: 'empty' } | { kind: 'none' };
function promptLine(line: string): PromptLine {
  const trimmed = line.trimStart();
  const marker = trimmed ? String.fromCodePoint(trimmed.codePointAt(0)!) : '';
  if (!MARKERS.has(marker)) return { kind: 'none' };
  const rest = trimmed.slice(marker.length);
  // A marker with nothing after it is an empty box once dim placeholder text
  // is gone; a marker glued to text ("$HOME", ">>>") is not a prompt.
  if (rest && !/^\s/.test(rest)) return { kind: 'none' };
  const text = rest.trim();
  return text ? { kind: 'pending', text } : { kind: 'empty' };
}
function isRule(line: string) { return RULE.test(line.trim()); }
function isChrome(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || promptLine(trimmed).kind === 'empty') return true;
  if ([...trimmed].every(ch => /\s/.test(ch) || '─━╌┄┈-—'.includes(ch))) return true;
  if (['🖥', '📡', '🟢', '🟡', '🔴', '⏵', '◯', '⧉'].some(icon => trimmed.startsWith(icon))) return true;
  const lower = trimmed.toLowerCase();
  return ['gpt-', 'claude', 'opus', 'sonnet', 'haiku', 'fable', '? for shortcuts'].some(prefix => lower.startsWith(prefix)) || lower.includes('context left');
}

export function parseComposer(ansi: string): Composer {
  const lines = visibleText(ansi).split('\n');
  // Boxed input (Claude Code): rule, prompt line, continuation lines, rule.
  for (let i = lines.length - 1; i > 0; i--) {
    const prompt = promptLine(lines[i]);
    if (prompt.kind === 'none' || !isRule(lines[i - 1])) continue;
    let end = i + 1;
    while (end < lines.length && !isRule(lines[end])) end++;
    if (end >= lines.length) continue;
    const text = [prompt.kind === 'pending' ? prompt.text : '', ...lines.slice(i + 1, end).map(line => line.trim())].join('\n').trim();
    return text ? { state: 'pending', text } : { state: 'empty' };
  }
  // Unboxed input (Codex, shells): the last prompt line with only chrome below.
  for (let i = lines.length - 1; i >= 0; i--) {
    const prompt = promptLine(lines[i]);
    if (prompt.kind === 'none' || !lines.slice(i + 1).every(isChrome)) continue;
    return prompt.kind === 'pending' ? { state: 'pending', text: prompt.text } : { state: 'empty' };
  }
  return { state: 'unknown' };
}

/** True when a pending box holds what was just submitted (or its first line). */
export function composerMatchesSent(pending: string, sent: string): boolean {
  const p = visibleText(pending).trim(), s = visibleText(sent).trim();
  if (!p || !s) return false;
  return p === s || p === (s.split('\n').map(line => line.trim()).find(Boolean) ?? '');
}

/** Claude Code shows this while a submitted prompt waits behind a running turn. */
export const QUEUED_MARKER = 'Press up to edit queued messages';

export function lastNonEmptyLine(ansi: string): string {
  return visibleText(ansi, true).split('\n').reverse().find(line => line.trim())?.trimEnd() ?? '';
}
