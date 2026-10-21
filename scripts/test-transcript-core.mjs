// Tests for the transcript writer (src/transcripts/transcript-core.js), against an
// in-memory vault: node scripts/test-transcript-core.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tc from "../src/transcripts/transcript-core.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
};

// An in-memory vault adapter, the shape the plugin passes.
function memoryIO() {
  const files = new Map();
  return {
    files,
    exists: async (rel) => files.has(rel),
    read: async (rel) => files.get(rel),
    create: async (rel, content) => { files.set(rel, content); },
    append: async (rel, content) => { files.set(rel, files.get(rel) + content); },
    ensureDir: async () => {},
    list: async (rel) => [...files.keys()].filter((k) => k.startsWith(rel + "/") && !k.slice(rel.length + 1).includes("/")).map((k) => k.split("/").pop()),
  };
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-tc-"));
// A Codex rollout file: its session meta, then user and assistant messages.
function codexRollout(id, texts) {
  const lines = [JSON.stringify({ type: "session_meta", payload: { id, cwd: "/vault" } })];
  texts.forEach((t, i) => lines.push(JSON.stringify({ type: "response_item", payload: { type: "message", role: i % 2 ? "assistant" : "user", id: `${id}-m${i}`, content: [{ type: "input_text", text: t }] } })));
  const file = path.join(tmp, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

// Two Codex sessions started within a minute: their time-ordered ids share the first
// eight characters, and each must still get a note of its own.
const idA = "019a1b2c-0000-7000-8000-00000000aaaa";
const idB = "019a1b2c-0000-7000-8000-00000000bbbb";
const io = memoryIO();
const dir = "Agent Transcripts";
const fileA = codexRollout(idA, ["first session's question", "first answer"]);
const fileB = codexRollout(idB, ["second session's question", "second answer"]);
const a = await tc.writeDurableTranscript(io, { transcriptDir: dir, backend: "codex", sessionTitle: "Untitled", sessionId: null, transcriptFile: fileA });
const b = await tc.writeDurableTranscript(io, { transcriptDir: dir, backend: "codex", sessionTitle: "Untitled", sessionId: null, transcriptFile: fileB });
check("each session gets its own note", a && b && a.path !== b.path, `${a?.path} / ${b?.path}`);
check("the first takes the short id", a.path === `${dir}/Untitled (019a1b2c).md`, a.path);
check("the second takes the long id", b.path === `${dir}/Untitled (019a1b2c-bbbb).md`, b.path);
check("each note records its full id", tc.noteSessionId(io.files.get(a.path)) === idA && tc.noteSessionId(io.files.get(b.path)) === idB);
check("neither note holds the other's turns", !io.files.get(a.path).includes("second session") && !io.files.get(b.path).includes("first session"));

// More turns land in the right note, and only the new ones.
fs.appendFileSync(fileB, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", id: `${idB}-m9`, content: [{ type: "input_text", text: "a later question" }] } }) + "\n");
const b2 = await tc.writeDurableTranscript(io, { transcriptDir: dir, backend: "codex", sessionTitle: "Untitled", sessionId: idB, transcriptFile: fileB });
check("a later turn appends to the second note", b2.path === b.path && b2.added === 1 && io.files.get(b.path).includes("a later question"));
const a2 = await tc.writeDurableTranscript(io, { transcriptDir: dir, backend: "codex", sessionTitle: "Untitled", sessionId: idA, transcriptFile: fileA });
check("writing again adds nothing", a2.path === a.path && a2.added === 0);

// A renamed session keeps its note: found by id, not by title.
const a3 = await tc.writeDurableTranscript(io, { transcriptDir: dir, backend: "codex", sessionTitle: "Renamed", sessionId: idA, transcriptFile: fileA });
check("a rename keeps writing the same note", a3.path === a.path);

// Two captures at once write each turn once.
const io2 = memoryIO();
await Promise.all([1, 2, 3].map(() => tc.writeDurableTranscript(io2, { transcriptDir: dir, backend: "codex", sessionTitle: "Busy", sessionId: idA, transcriptFile: fileA })));
const notes = [...io2.files.keys()];
check("captures at once make one note", notes.length === 1, notes.join(", "));
check("and write each turn once", (io2.files.get(notes[0]).match(/pl-rec:/g) || []).length === 2);

// Two sessions whose ids share their first eight characters, captured at the same
// moment into an empty folder: still two notes.
const io3 = memoryIO();
const [c, d] = await Promise.all([
  tc.writeDurableTranscript(io3, { transcriptDir: dir, backend: "codex", sessionTitle: "Untitled", sessionId: idA, transcriptFile: fileA }),
  tc.writeDurableTranscript(io3, { transcriptDir: dir, backend: "codex", sessionTitle: "Untitled", sessionId: idB, transcriptFile: fileB }),
]);
check("sessions sharing a prefix, captured at once, get two notes", c.path !== d.path && io3.files.size === 2, [...io3.files.keys()].join(", "));
check("and neither holds the other's turns", !io3.files.get(c.path).includes("second session") && !io3.files.get(d.path).includes("first session"));

// A note's session id is read from its frontmatter only, quoted either way.
check("an id in single quotes is read", tc.noteSessionId(`---\nsession_id: '${idA}'\n---\n# x`) === idA);
check("an id in the body is not", tc.noteSessionId(`---\nsession: "x"\n---\nsession_id: ${idA}\n`) === null);

// The note a session was started from goes into a new transcript note's frontmatter.
const withSource = tc.transcriptHeader("Task", idA, "claude", "[[Board/Task]]");
check("a header names its source note", /^source: "\[\[Board\/Task\]\]"$/m.test(withSource), withSource);
check("and a header without one has none", !/^source:/m.test(tc.transcriptHeader("Task", idA, "claude")));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
