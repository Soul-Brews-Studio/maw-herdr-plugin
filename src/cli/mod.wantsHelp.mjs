// `--help` / `-h` on any subcommand means "show me the usage", never
// "unknown argument". Answered before a verb runs, so asking for help can
// never reach herdr, and can never send, wake or attach anything.

const HELP_FLAGS = new Set(['--help', '-h']);

// The verbs this gate answers for. A verb that does not exist stays an
// "unknown command" even with --help after it: otherwise a script probing
// `maw herdr restart --help` reads exit 0 as "restart exists", and a typo like
// `pek alpha -h` prints the usage without saying the verb is wrong. A new verb
// joins this set in the same change that adds its dispatch line. `serve` is
// absent on purpose: it parses its own --help.
export const HELP_VERBS = new Set(['ls', 'list', 'a', 'attach', 'wake', 'hey', 'peek', 'read', 'federation', 'fed']);

// Flags whose next argv element is a value, not a flag. `wake --prompt -h`
// prompts the agent with "-h"; it is not a request for usage.
//
// wake's --engine/--kind are deliberately NOT here. No herdr agent kind starts
// with "-", so `wake <oracle> --kind -h` can only mean help. Treating "-h" as
// the engine instead created a workspace in the live session before
// `agent start --kind -h` failed, and left it behind.
const VALUE_FLAGS = {
  wake: new Set(['--prompt']),
  peek: new Set(['--lines', '--session']),
  hey: new Set(['--session']),
};

/**
 * True when `args` asks for usage rather than for the verb to run.
 *
 * `hey` is the one verb whose trailing words are free text: everything after
 * the target is the message, unquoted included. `hey neo --help` has no
 * message and is a help request; `hey neo why does -h fail` is a message that
 * happens to contain "-h" and must still be sent. So for hey, a help flag
 * counts only when nothing but the target (and --dry-run) is left.
 *
 * Every other verb stops at a `--` terminator, the POSIX convention.
 */
export function wantsHelp(verb, args) {
  if (!HELP_VERBS.has(verb)) return false;
  const values = VALUE_FLAGS[verb];
  const words = [];
  let asked = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' && verb !== 'hey') break;
    if (values?.has(arg)) {
      i++;
      continue;
    }
    if (HELP_FLAGS.has(arg)) asked = true;
    else words.push(arg);
  }
  if (!asked) return false;
  if (verb === 'hey') return words.filter(w => w !== '--dry-run').length <= 1;
  return true;
}
