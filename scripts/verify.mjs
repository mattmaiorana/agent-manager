// The checks every change runs (`npm run verify`): a clean build, the tests, the
// typecheck, and the things a build and the tests can't see: the built file's shape, that
// the plugin's source is all TypeScript, and import cycles.
//
//   node scripts/verify.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { Linter } from "eslint";
import { options as buildOptions, styles } from "../esbuild.config.mjs";
import { noticeComment, notices } from "./notices.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const results = [];
const pass = (name, detail = "") => results.push({ name, ok: true, detail });
const fail = (name, detail) => results.push({ name, ok: false, detail });
const report = () => {
  console.log("\n---- verify ----");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad ? `${bad} failed` : "all passed");
  process.exit(bad ? 1 : 0);
};

// ---- 1. Build ----------------------------------------------------------------------
let metafile;
try {
  const r = await esbuild.build({ ...buildOptions, logLevel: "silent", metafile: true });
  metafile = r.metafile;
  if (r.warnings.length) fail("build", `${r.warnings.length} warning(s): ${r.warnings.map((w) => w.text).join("; ")}`);
  else pass("build", "no warnings");
  // styles.css too, as npm run build writes it, so what's checked and loaded is current.
  // It isn't tracked, so there's no committed copy to compare with: this checks that
  // both parts made it in.
  const css = styles();
  fs.writeFileSync("styles.css", css);
  css.includes(".agent-manager-strip") && css.includes(".vault-terminal") ? pass("styles.css written", "src/styles.css + the terminal's") : fail("styles.css written", "a part is missing");
  // The bundled packages' licenses, in both built files and the tracked copy.
  const comment = noticeComment();
  const tracked = fs.existsSync("THIRD_PARTY_NOTICES") ? fs.readFileSync("THIRD_PARTY_NOTICES", "utf8") : "";
  const missing = [
    !fs.readFileSync("main.js", "utf8").includes(comment) && "main.js",
    !css.includes(comment) && "styles.css",
    tracked !== notices() && "THIRD_PARTY_NOTICES (run npm run notices)",
  ].filter(Boolean);
  missing.length ? fail("third-party notices", `missing or stale in ${missing.join(", ")}`) : pass("third-party notices", "in main.js, styles.css, and THIRD_PARTY_NOTICES");
} catch (e) {
  fail("build", e.message.split("\n")[0]);
  report();
}

// ---- 2. Syntax -----------------------------------------------------------------------
{
  const r = spawnSync(process.execPath, ["--check", "main.js"], { encoding: "utf8" });
  r.status === 0 ? pass("node --check main.js") : fail("node --check main.js", r.stderr.trim().split("\n")[0]);
}

// ---- 3. Tests --------------------------------------------------------------------------
{
  // Each through scripts/run-test.mjs, which bundles it so its source can be JavaScript or TypeScript.
  // Every scripts/test-*.mjs, so a new test is never left out.
  const tests = fs.readdirSync("scripts").filter((f) => /^test-.*\.mjs$/.test(f)).sort().map((f) => `scripts/${f}`);
  for (const file of tests) {
    const r = spawnSync(process.execPath, ["scripts/run-test.mjs", file], { encoding: "utf8" });
    const out = (r.stdout + r.stderr).trim().split("\n");
    r.status === 0 ? pass(`test ${path.basename(file)}`, out[out.length - 1]) : fail(`test ${path.basename(file)}`, out.filter((l) => /FAIL|Error/.test(l)).slice(0, 3).join(" | ") || `exit ${r.status}`);
  }
}

// The terminal (src/vault-terminal/): its TypeScript typechecks, and its helper and
// transport tests pass (npm run test:terminal).
{
  const tsc = spawnSync(path.join("node_modules", ".bin", "tsc"), ["--noEmit"], { encoding: "utf8" });
  tsc.status === 0 ? pass("typecheck", "tsc --noEmit") : fail("typecheck", (tsc.stdout + tsc.stderr).trim().split("\n").slice(0, 3).join(" | "));
  const t = spawnSync("npm", ["run", "--silent", "test:terminal"], { encoding: "utf8" });
  const out = (t.stdout + t.stderr).trim().split("\n");
  const oks = out.filter((l) => /^ok /.test(l)).length;
  const py = (out.find((l) => /^Ran \d+ tests/.test(l)) || "").replace(/ in .*/, "");
  t.status === 0 ? pass("test:terminal", `${py || "helper tests"}; harness ${oks} ok`) : fail("test:terminal", out.filter((l) => /FAIL|Error/.test(l)).slice(0, 3).join(" | ") || `exit ${t.status}`);
}

// ---- Parsing, with ESLint's parser ---------------------------------------------------
const linter = new Linter({ configType: "flat" });
function parse(code, sourceType = "script") {
  let captured = null;
  const messages = linter.verify(code, [{
    languageOptions: { ecmaVersion: "latest", sourceType },
    plugins: { cap: { rules: { ast: { create: (ctx) => ({ Program(node) { captured = { ast: node, sc: ctx.sourceCode }; } }) } } } },
    rules: { "cap/ast": "error" },
  }]);
  const fatal = messages.find((m) => m.fatal);
  if (fatal) throw new Error(`parse error at ${fatal.line}:${fatal.column}: ${fatal.message}`);
  return captured;
}

// ---- 4. The built file's shape ------------------------------------------------------------
// Top-level class declarations and the parts applied to them, read from the built file.
function readBuild(code) {
  const parsed = parse(code);
  const classNodes = {};
  for (const st of parsed.ast.body) {
    if (st.type === "VariableDeclaration") {
      for (const d of st.declarations) if (d.id.type === "Identifier" && d.init && d.init.type === "ClassExpression") classNodes[d.id.name] = d.init;
    } else if (st.type === "ClassDeclaration") classNodes[st.id.name] = st;
  }
  const parts = {};
  for (const st of parsed.ast.body) {
    const e = st.type === "ExpressionStatement" && st.expression;
    if (e && e.type === "CallExpression" && e.callee.type === "Identifier" && e.callee.name === "applyParts") {
      const [base, ...ps] = e.arguments.map((a) => a.name);
      (parts[base] ||= []).push(...ps);
    }
  }
  return { ast: parsed.ast, sc: parsed.sc, classNodes, parts };
}
const built = fs.readFileSync("main.js", "utf8");
const loaded = { b: readBuild(built) };

// It must be strict (the directive lives only in esbuild's banner), nothing may run at
// the top level but esbuild's export glue and the applyParts calls, and no part may use
// `super` (a method's super is fixed where it is defined, so the same text moved into a
// part fails at runtime).
if (loaded) {
  const { b } = loaded;
  const issues = [];
  const first = b.ast.body[0];
  if (!(first && first.type === "ExpressionStatement" && first.directive === "use strict")) issues.push('main.js does not start with "use strict"');
  // esbuild's export glue: the plugin's default export, and a namespace object for a
  // module imported whole (`import * as transcriptCore`), which only lists getters.
  const exportGlue = [/^__export\(main_exports, \{\s*default: \(\) => main_default\s*\}\);$/, /^module\.exports = __toCommonJS\(main_exports\);$/, /^__export\(\w+_exports, \{(\s*\w+: \(\) => \w+,?)*\s*\}\);$/];
  let calls = 0;
  for (const st of b.ast.body) {
    if (st === first || ["VariableDeclaration", "FunctionDeclaration", "ClassDeclaration"].includes(st.type)) continue;
    const e = st.type === "ExpressionStatement" && st.expression;
    if (e && e.type === "CallExpression" && e.callee.type === "Identifier" && e.callee.name === "applyParts" && e.arguments.every((x) => x.type === "Identifier")) { calls++; continue; }
    const t = b.sc.getText(st);
    if (exportGlue.some((re) => re.test(t))) continue;
    issues.push(`runs at load: ${t.replace(/\s+/g, " ").slice(0, 70)}`);
  }
  const parts = Object.values(b.parts).flat();
  for (const p of parts) {
    let found = false;
    const walk = (n) => {
      if (found || !n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (n.type === "Super") { found = true; return; }
      for (const k of Object.keys(n)) if (k !== "parent") walk(n[k]);
    };
    if (!b.classNodes[p]) { issues.push(`part ${p} is not a class declared at the top level`); continue; }
    walk(b.classNodes[p].body);
    if (found) issues.push(`part ${p} uses super`);
  }
  issues.length ? fail("built file's shape", issues.slice(0, 8).join("; ")) : pass("built file's shape", `strict; at load only the export glue and ${calls} applyParts call(s); ${parts.length} parts, none using super`);
}

// ---- 5. Plain JavaScript ------------------------------------------------------------------
// This used to check Agent Manager's JavaScript for names used but never declared, and for
// methods called on `this` or `this.plugin` that nothing defines. The plugin is all
// TypeScript now, and the typecheck (strict) refuses both, so those checks are gone. This
// says so, and fails if a JavaScript module comes back into src/, which the typecheck
// would see only loosely.
{
  const mods = Object.keys(metafile.inputs).filter((f) => f.startsWith("src/"));
  const js = mods.filter((f) => /\.(c|m)?js$/.test(f));
  js.length ? fail("all TypeScript", `JavaScript in src/: ${js.join(", ")}`) : pass("all TypeScript", `${mods.length} module(s); the typecheck covers undeclared names and missing methods`);
}

// ---- 6. No import cycles ------------------------------------------------------------------
{
  const graph = {};
  // Agent Manager's own modules. The terminal's folder has a cycle of its own (core and
  // view import each other); esbuild's modules handle it.
  const ours = (p) => p.startsWith("src/") && !p.startsWith("src/vault-terminal/");
  for (const [f, info] of Object.entries(metafile.inputs)) {
    if (!ours(f)) continue;
    graph[f] = info.imports.map((i) => i.path).filter(ours);
  }
  const cycles = [];
  const state = {};
  const visit = (n, stack) => {
    state[n] = 1; stack.push(n);
    for (const m of graph[n] || []) {
      if (state[m] === 1) cycles.push([...stack.slice(stack.indexOf(m)), m].join(" -> "));
      else if (!state[m]) visit(m, stack);
    }
    stack.pop(); state[n] = 2;
  };
  for (const n of Object.keys(graph)) if (!state[n]) visit(n, []);
  cycles.length ? fail("no import cycles", cycles.join("; ")) : pass("no import cycles", `${Object.keys(graph).length} module(s)`);
}

report();
