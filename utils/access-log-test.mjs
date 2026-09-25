import { formatAccess, safeTarget } from "../src/serve/bun/mod.accessLog.ts";
import { parseAllowedOrigin, requestOrigin } from "../src/serve/bun/mod.requestOrigin.ts";

let pass = 0, fail = 0;
const is = (name, got, want) => {
  if (got === want) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}\n  got:  ${got}\n  want: ${want}`); }
};
const throws = (name, fn) => {
  try { fn(); fail++; console.log(`FAIL ${name} (no throw)`); }
  catch { pass++; console.log(`PASS ${name}`); }
};

// A credential in the query string must never survive into the log.
is("scrub token param", safeTarget(new URL("http://x/api/capture?target=a&token=SECRET")), "/api/capture?target=a&…");
is("scrub lone secret", safeTarget(new URL("http://x/api/x?ticket=mwt1_deadbeef")), "/api/x?…");
is("keep safe params", safeTarget(new URL("http://x/api/capture?target=a&lines=30")), "/api/capture?target=a&lines=30");
is("no query", safeTarget(new URL("http://x/api/sessions")), "/api/sessions");

const line = formatAccess({ ip: "127.0.0.1", method: "GET", url: new URL("http://x/api/sessions"),
  status: 200, bytes: 42, ms: 7.4, origin: "https://bridge.buildwithoracle.com" }, new Date(2026, 8, 22, 1, 2, 3));
is("nginx shape", line.replace(/\[[^\]]+\]/, "[TS]"),
  '127.0.0.1 [TS] "GET /api/sessions" 200 42 7ms "https://bridge.buildwithoracle.com"');

const req = (origin) => new Request("http://127.0.0.1/api/sessions", { headers: origin ? { origin } : {} });
is("no origin ok", requestOrigin(req()), "");
is("loopback ok", requestOrigin(req("http://127.0.0.1:5273")), "http://127.0.0.1:5273");
is("god builtin", requestOrigin(req("https://god.buildwithoracle.com")), "https://god.buildwithoracle.com");
is("allowlisted", requestOrigin(req("https://village.buildwithoracle.com"), ["https://village.buildwithoracle.com"]), "https://village.buildwithoracle.com");
throws("stranger rejected", () => requestOrigin(req("https://evil.example.com")));
throws("not allowlisted by suffix", () => requestOrigin(req("https://evil-buildwithoracle.com"), ["https://village.buildwithoracle.com"]));
is("parse normalises", parseAllowedOrigin("https://bridge.buildwithoracle.com/"), "https://bridge.buildwithoracle.com");
throws("wildcard refused", () => parseAllowedOrigin("https://*.example.com"));
throws("path refused", () => parseAllowedOrigin("https://x.com/app"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
