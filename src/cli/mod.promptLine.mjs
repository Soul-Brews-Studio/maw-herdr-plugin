/**
 * Ask one question and read ONE line. node:readline, no dependencies.
 *
 *   promptLine(question, { input, output }) → Promise<{ line } | { eof: true } | { sigint: true }>
 *
 * Ctrl-C (a terminal's SIGINT) resolves { sigint } instead of killing the
 * process, so the caller can say "nothing was done" and exit 130. EOF (Ctrl-D, or
 * a closed pipe) resolves { eof }. `input`/`output` default to stdin/stderr and
 * exist so a smoke can drive the prompt with a plain stream.
 */
import { createInterface } from 'node:readline';

export function promptLine(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise(done => {
    const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      rl.close();
      done(result);
    };
    rl.on('SIGINT', () => finish({ sigint: true }));
    rl.on('close', () => finish({ eof: true }));
    rl.question(question, line => finish({ line }));
  });
}
