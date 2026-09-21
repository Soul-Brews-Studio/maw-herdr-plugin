export async function runServe(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`maw herdr serve --token-file PATH [--listen 127.0.0.1:3457]
                [--herdr PATH] [--data-dir PATH] [--wake-engine KIND]

Core dashboard API: sessions, live pane output and prompt submission.
Dashboard wake supports existing panes and registered repositories/tasks (default codex).
The token file is required, including on loopback. Help needs no Herdr.
The server is TypeScript on Bun; there is no native runtime and no compiler step.
Host-managed serving is declared separately by plugin.json engine.serve.`);
    return 0;
  }
  for (const argument of args) {
    if (argument === '--runtime' || argument.startsWith('--runtime=') || argument === '--build') {
      throw new Error(`serve: ${argument.split('=')[0]} was removed; the server is always TypeScript on Bun\n  maw herdr serve --token-file ~/.maw-herdr-token --listen 127.0.0.1:3457`);
    }
  }
  if (process.env.MAW_HERDR_SERVE_BIN) {
    throw new Error('serve: MAW_HERDR_SERVE_BIN was removed; the server is always TypeScript on Bun\n  unset MAW_HERDR_SERVE_BIN');
  }
  if (!process.versions.bun) {
    throw new Error('serve: the dashboard server requires Bun\n  bun index.mjs serve --token-file ~/.maw-herdr-token');
  }
  const { runBunServe } = await import('./bun/mod.runBunServe.ts');
  return runBunServe(args);
}
