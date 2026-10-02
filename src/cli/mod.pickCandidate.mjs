/**
 * Interpret what a person typed at the "pick 1-N" prompt of an ambiguous
 * `maw herdr a <name>`. Pure: no I/O, so it is tested without a terminal.
 *
 *   pickCandidate(candidates, answer) → { index } | { cancel: true } | { invalid: string }
 *
 * `index` is the zero-based position in `candidates`. Empty, `q`/`quit` and
 * null (EOF) cancel. Anything that is not a whole number from 1 to N is invalid,
 * and carries the trimmed text so the error can quote it.
 */
export function pickCandidate(candidates, answer) {
  if (answer == null) return { cancel: true };
  const text = String(answer).trim();
  if (text === '' || /^(q|quit)$/i.test(text)) return { cancel: true };
  if (/^[0-9]+$/.test(text)) {
    const n = Number(text);
    if (n >= 1 && n <= candidates.length) return { index: n - 1 };
  }
  return { invalid: text };
}
