// Tests that a session tab follows its conversation to a new id, keeping its tab, pin,
// name, and transcript (src/sessions/identity.ts: _detectRehostedSession, _repointTo).
// The identity part is bundled with Obsidian stubbed out, then run against real
// transcript files in a temporary folder: node scripts/test-follow.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import * as tc from "../src/transcripts/transcript-core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
};

// The identity part, with `obsidian` replaced by a stub whose Notice does nothing.
const out = path.join(ROOT, ".build", "test-follow.mjs");
await esbuild.build({
  stdin: { contents: 'export { IdentityMethods } from "./src/sessions/identity.js"; export { applyParts } from "./src/util/apply-parts.js";', resolveDir: ROOT, loader: "js" },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{ name: "stub", setup(b) {
    b.onResolve({ filter: /^(obsidian|@codemirror\/view)$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export class Notice { constructor() {} }", loader: "js" }));
  } }],
});
const { IdentityMethods, applyParts } = await import(pathToFileURL(out).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-follow-"));
const at = (min) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();
const user = (uuid, text, ts, extra = {}) => JSON.stringify({ type: "user", uuid, timestamp: ts, message: { role: "user", content: text }, ...extra });
const reply = (uuid, text, ts) => JSON.stringify({ type: "assistant", uuid, timestamp: ts, message: { role: "assistant", model: "claude-test", content: [{ type: "text", text }] } });
const write = (id, lines) => { const f = path.join(tmp, `${id}.jsonl`); fs.writeFileSync(f, lines.join("\n") + "\n"); return f; };

// A fake session tab with the identity part applied, and the plugin calls it makes.
function makeTab(oldId, oldFile, records, pluginData) {
  class Tab {}
  applyParts(Tab, IdentityMethods);
  const tab = new Tab();
  Object.assign(tab, {
    sessionTitle: "Planning",
    resumeSessionId: oldId,
    launchSessionId: null,
    _modelFile: oldFile,
    getBackendKey: () => "claude",
    _transcriptFile: async () => tab._modelFile,
    refreshStripId: () => {},
    _showRehostPill: () => { tab._pillShown = true; },
    plugin: {
      pluginData,
      _tc: () => tc,
      sessionIndex: async () => records,
      invalidateSessionIndex: () => {},
      savePluginData: () => { tab._saved = true; },
      resetNoteWriteback: () => {},
      // plugin/agents.ts's: the agent records follow the id, as a name does.
      carrySessionAgent: (oldId, newId) => {
        let carried = false;
        for (const map of [pluginData.sessionAgents, pluginData.sessionLaunchAgents]) {
          if (map && oldId && newId && oldId !== newId && oldId in map && !(newId in map)) { map[newId] = map[oldId]; carried = true; }
        }
        return carried;
      },
    },
    app: { workspace: { requestSaveLayout: () => { tab._layoutSaved = true; } } },
  });
  return tab;
}
const rec = (id, file, title = "Planning") => ({ backend: "claude", sessionId: id, file, title, rawTitle: title, mtime: fs.statSync(file).mtimeMs });

// 1. A compaction: the old file points at the new one, which starts from a summary and
// keeps going.
{
  const oldId = "11111111-1111-4111-8111-111111111111", newId = "22222222-2222-4222-8222-222222222222";
  const oldFile = write(oldId, [user("u1", "plan the week", at(0)), reply("a1", "ok", at(1)), JSON.stringify({ type: "continued-in", continuedInSessionId: newId, timestamp: at(2) })]);
  const newFile = write(newId, [user("s1", "This session is being continued from a previous conversation.", at(2), { isCompactSummary: true }), reply("a2", "carrying on", at(5))]);
  const data = { pinnedSessions: { [oldId]: 1 }, sessionNames: { [oldId]: "Planning" } };
  const tab = makeTab(oldId, oldFile, [rec(oldId, oldFile), rec(newId, newFile)], data);
  const moved = await tab._detectRehostedSession();
  check("a compacted session is followed", moved && tab.resumeSessionId === newId, tab.resumeSessionId);
  check("its tab now reads the new transcript", tab._modelFile === newFile);
  check("it's marked as continued, with a pill", tab._rehostedFrom?.kind === "continued" && tab._pillShown);
  check("its pin moves to the new id", data.pinnedSessions[newId] === 1 && !(oldId in data.pinnedSessions));
  check("its name moves to the new id", data.sessionNames[newId] === "Planning");
  check("and the change is saved, the tab's new id with it", tab._saved === true && tab._layoutSaved === true);
}

// 2. A Remote Control re-host: the new file replays the first two messages and keeps going.
{
  const oldId = "33333333-3333-4333-8333-333333333333", newId = "44444444-4444-4444-8444-444444444444";
  const lines = [user("u1", "first message", at(0)), reply("a1", "one", at(1)), user("u2", "second message", at(2)), reply("a2", "two", at(3))];
  const oldFile = write(oldId, lines);
  const newFile = write(newId, [...lines, user("u3", "from my phone", at(9)), reply("a3", "three", at(10))]);
  const data = { pinnedSessions: { [oldId]: 3 }, sessionNames: {} };
  const tab = makeTab(oldId, oldFile, [rec(oldId, oldFile), rec(newId, newFile)], data);
  const moved = await tab._detectRehostedSession();
  check("a re-hosted session is followed", moved && tab.resumeSessionId === newId);
  check("it's marked as re-hosted", tab._rehostedFrom?.kind === "rehost");
  check("its pin moves to the new id, keeping its place", data.pinnedSessions[newId] === 3 && !(oldId in data.pinnedSessions));
}

// 3. A renamed session, compacted into a file that carries another name: the pointer
// is enough, whatever the new file is called.
{
  const oldId = "77777777-7777-4777-8777-777777777777", newId = "88888888-8888-4888-8888-888888888888";
  const oldFile = write(oldId, [user("u1", "start", at(0)), reply("a1", "ok", at(1)), JSON.stringify({ type: "continued-in", continuedInSessionId: newId, timestamp: at(2) })]);
  const newFile = write(newId, [user("s1", "This session is being continued from a previous conversation.", at(2), { isCompactSummary: true }), reply("a2", "on we go", at(6))]);
  const data = { pinnedSessions: {}, sessionNames: { [oldId]: "Renamed here" } };
  const tab = makeTab(oldId, oldFile, [rec(oldId, oldFile, "Planning"), rec(newId, newFile, "Something Claude chose")], data);
  tab.sessionTitle = "Renamed here";
  const moved = await tab._detectRehostedSession();
  check("a renamed session is followed by its pointer, whatever the new file is named", moved && tab.resumeSessionId === newId);
  check("and its rename moves with it", data.sessionNames[newId] === "Renamed here");
}

// 4. A same-name session that isn't the same conversation is left alone.
{
  const oldId = "55555555-5555-4555-8555-555555555555", otherId = "66666666-6666-4666-8666-666666666666";
  const oldFile = write(oldId, [user("u1", "one thing", at(0)), reply("a1", "ok", at(1)), user("u2", "another", at(2))]);
  const otherFile = write(otherId, [user("v1", "something else", at(3)), reply("b1", "ok", at(4)), user("v2", "more", at(5))]);
  const tab = makeTab(oldId, oldFile, [rec(oldId, oldFile), rec(otherId, otherFile)], { pinnedSessions: { [oldId]: 1 }, sessionNames: {} });
  const moved = await tab._detectRehostedSession();
  check("an unrelated session of the same name is not followed", !moved && tab.resumeSessionId === oldId);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
