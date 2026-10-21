// Tests writing a session's resume link (main-session) back into the note it was started from
// (src/notes/view-note.js: maybeWriteNoteBack, with plugin/notes.js's helpers). The two
// parts are bundled with Obsidian stubbed out and run against an in-memory note:
// node scripts/test-note-writeback.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
};

const out = path.join(ROOT, ".build", "test-note-writeback.mjs");
await esbuild.build({
  stdin: { contents: 'export { ViewNoteMethods } from "./src/notes/view-note.js"; export { NoteMethods } from "./src/plugin/notes.js"; export { applyParts } from "./src/util/apply-parts.js"; export { TFile } from "obsidian";', resolveDir: ROOT, loader: "js" },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{ name: "stub", setup(b) {
    b.onResolve({ filter: /^(obsidian|@codemirror\/view)$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export class Notice { constructor() {} } export class TFile {} export class TFolder {} export class SuggestModal {} export class AbstractInputSuggest {} export class Modal {} export const setIcon = () => {};",
      loader: "js",
    }));
  } }],
});
const { ViewNoteMethods, NoteMethods, applyParts, TFile } = await import(pathToFileURL(out).href);

// One note, a plugin, and the session tabs started from it.
function world() {
  const note = Object.assign(new TFile(), { path: "Board/Task.md" });
  const fm = {};
  const tabs = [];
  // A write can be held at the start of processFrontMatter, to move the tab mid-write.
  const hold = { gate: null };
  class Plugin {}
  applyParts(Plugin, NoteMethods);
  const plugin = new Plugin();
  Object.assign(plugin, {
    sessionLeaves: () => tabs.map((t) => ({ t })),
    sessionOf: (leaf) => leaf.t,
    savedSessionState: () => null,
    buildResumeLink: ({ sessionId }) => `obsidian://agent-manager?vault=V&op=resume&session=${sessionId}`,
  });
  const app = {
    vault: { getAbstractFileByPath: (p) => (p === note.path ? note : null) },
    metadataCache: { fileToLinktext: (f) => f.basename },
    fileManager: { processFrontMatter: async (f, fn) => { await (hold.gate || null); fn(fm); } },
    workspace: { requestSaveLayout: () => {} },
  };
  const tab = (launchAt) => {
    class Tab {}
    applyParts(Tab, ViewNoteMethods);
    const t = new Tab();
    Object.assign(t, { app, plugin, _notePath: note.path, _noteClaim: true, _noteLaunchAt: launchAt, resumeSessionId: null, launchSessionId: null });
    t._ownSessionId = () => t.resumeSessionId || t.launchSessionId || null;
    plugin.resetNoteWriteback(t);
    tabs.push(t);
    return t;
  };
  return { fm, tab, plugin, hold, tabs };
}
const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";

const P = "main-session";

// 1. A launch writes its resume link as soon as it has an id, and is then done.
{
  const w = world();
  const t = w.tab(1000);
  await t.maybeWriteNoteBack();
  check("nothing is written before there's an id", !(P in w.fm));
  t.launchSessionId = A;
  await t.maybeWriteNoteBack();
  check("the link is written as soon as there's an id", w.fm[P]?.endsWith(A));
  check("then it's done", t._noteWritten === true);
  check("and nothing else is written", Object.keys(w.fm).join() === P, Object.keys(w.fm).join());
}

// 2. An older launch that learns its id after a newer one has written never takes the
// note's link back.
{
  const w = world();
  const older = w.tab(1000);
  const newer = w.tab(2000);
  newer.launchSessionId = B;
  await newer.maybeWriteNoteBack();
  older.resumeSessionId = A; // a Codex launch that only now found its transcript
  await older.maybeWriteNoteBack();
  check("the newer launch keeps the link", w.fm[P]?.endsWith(B), w.fm[P]);
  check("the older one gives up", older._noteWritten === true && older._noteClaim === false);
}

// 3. A new launch from the same note claims the link from the previous session.
{
  const w = world();
  w.fm[P] = `obsidian://agent-manager?vault=V&op=resume&session=${A}`;
  const t = w.tab(3000);
  t.launchSessionId = B;
  await t.maybeWriteNoteBack();
  check("the new launch claims the link", w.fm[P]?.endsWith(B));
}

// 4. A re-host while a write waits: the write for the old id doesn't mark the tab done,
// so the next poll writes the new id.
{
  const w = world();
  const t = w.tab(1000);
  t.resumeSessionId = A;
  let release;
  w.hold.gate = new Promise((r) => { release = r; });
  const first = t.maybeWriteNoteBack();
  // The tab follows its conversation to a new id mid-write (_repointTo resets the write-back).
  t.resumeSessionId = C;
  w.plugin.resetNoteWriteback(t);
  release();
  await first;
  w.hold.gate = null;
  check("the interrupted write doesn't mark the tab done", t._noteWritten === false);
  await t.maybeWriteNoteBack();
  check("the next write names the new id", w.fm[P]?.endsWith(C), JSON.stringify(w.fm));
}

// 5. After a re-host, the session still holds the link it wrote under its old id.
{
  const w = world();
  const t = w.tab(1000);
  t.launchSessionId = A;
  await t.maybeWriteNoteBack();
  t._noteClaim = false;
  t._rehostedFrom = { from: A, to: C };
  t.launchSessionId = null;
  t.resumeSessionId = C;
  w.plugin.resetNoteWriteback(t);
  await t.maybeWriteNoteBack();
  check("a re-hosted session moves its link to the new id", w.fm[P]?.endsWith(C), JSON.stringify(w.fm));
}

// 6. A side chat never writes.
{
  const w = world();
  const t = w.tab(1000);
  t._noteSupport = true;
  t.launchSessionId = A;
  await t.maybeWriteNoteBack();
  check("a side chat leaves the note alone", !(P in w.fm));
}

// 7. A newer launch whose tab has closed still holds the link: the older launch that
// learns its id afterwards doesn't take it back.
{
  const w = world();
  const older = w.tab(1000);
  const newer = w.tab(2000);
  w.plugin._noteLaunches = new Map([["Board/Task.md", 2000]]);
  newer.launchSessionId = B;
  await newer.maybeWriteNoteBack();
  w.tabs.splice(w.tabs.indexOf(newer), 1); // the newer tab closes
  older.resumeSessionId = A;
  await older.maybeWriteNoteBack();
  check("a closed newer launch keeps the link", w.fm[P]?.endsWith(B), w.fm[P]);
}

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
