// Runs a plugin test (scripts/test-*.mjs) after bundling it with esbuild, so the source it
// imports can be JavaScript or TypeScript: esbuild finds `./x.ts` for an import of `./x.js`.
// Packages stay external (a test that runs esbuild itself keeps using the installed one).
//   node scripts/run-test.mjs scripts/test-draft.mjs
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const test = process.argv[2];
if (!test) { console.error("usage: node scripts/run-test.mjs <test file>"); process.exit(2); }
const out = resolve(".build/tests", basename(test));
await esbuild.build({
  entryPoints: [test], bundle: true, platform: "node", format: "esm", target: "node20",
  packages: "external", outfile: out, logLevel: "error",
  // A test that resolves files from its own folder (import.meta.url) sees the original's.
  define: { "import.meta.url": JSON.stringify(pathToFileURL(resolve(test)).href) },
});
const r = spawnSync(process.execPath, [out, ...process.argv.slice(3)], { stdio: "inherit" });
process.exit(r.status ?? 1);
