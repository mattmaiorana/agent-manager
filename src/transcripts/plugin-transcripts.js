// The plugin's transcript side: the writer, importing a session, and finding a transcript note.

import { fs, import_obsidian, os, path } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS } from "../constants/backends.js";
import { isCodexSubagentSessionMeta, readFileHead, readJsonlFirstRecord } from "../sessions/transcript-files.js";
import { ChoicePickerModal } from "../ui/modals.js";
import * as transcriptCore from "./transcript-core.js";
var TranscriptMethods = class {
  // The transcript writer and parsers (transcript-core.js).
  _tc() {
    return transcriptCore;
  }
  // The vault I/O the writer is given: vault-relative paths, through the vault's adapter.
  _vaultTranscriptIO() {
    const a = this.app.vault.adapter;
    return {
      exists: (rel) => a.exists(rel),
      read: (rel) => a.read(rel),
      create: (rel, content) => a.write(rel, content),
      append: (rel, content) => a.append(rel, content),
      ensureDir: async (rel) => { try { if (!(await a.exists(rel))) await a.mkdir(rel); } catch { /* best effort */ } },
      list: async (rel) => { try { const r = await a.list(rel); return (r.files || []).map((f) => f.split("/").pop()); } catch { return []; } },
    };
  }
  // ---- Importing a session started outside the plugin ----
  // The plugin captures every session it hosts; this is for a bare `claude`, `codex`, or
  // `agy` run. It lists one backend's recent transcripts, from any folder, and writes the
  // chosen one through the same writer as live capture. Codex's subagent rollouts are
  // left out: they are children of a session, not conversations of their own.
  listImportableSessions(backend) {
    const files = [];
    const rd = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
    if (backend === "claude") {
      const root = path.join(os.homedir(), ".claude", "projects");
      for (const slug of rd(root)) for (const f of rd(path.join(root, slug))) if (f.endsWith(".jsonl")) files.push(path.join(root, slug, f));
    } else if (backend === "codex") {
      const root = path.join(os.homedir(), ".codex", "sessions");
      for (const y of rd(root)) for (const m of rd(path.join(root, y))) for (const d of rd(path.join(root, y, m))) for (const f of rd(path.join(root, y, m, d))) {
        if (!f.endsWith(".jsonl")) continue;
        files.push(path.join(root, y, m, d, f));
      }
    } else if (backend === "antigravity") {
      const root = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
      for (const uuid of rd(root)) {
        const t = path.join(root, uuid, ".system_generated", "logs", "transcript.jsonl");
        try { if (fs.existsSync(t)) files.push(t); } catch { /* best effort */ }
      }
    }
    // Newest first, and only then the read that tells a Codex subagent's rollout from
    // a session: it stops at the fortieth kept, instead of reading every file.
    const sorted = files.map((f) => { try { return { file: f, mtime: fs.statSync(f).mtimeMs }; } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.mtime - a.mtime);
    const withStat = [];
    for (const entry of sorted) {
      if (backend === "codex" && isCodexSubagentSessionMeta(readJsonlFirstRecord(entry.file))) continue;
      withStat.push(entry);
      if (withStat.length === 40) break;
    }
    const tc = this._tc();
    return withStat.map(({ file, mtime }) => {
      const sessionId = tc.deriveSessionId(file, backend);
      // Label from the session's own title record when it has one, else the first
      // message a person typed.
      let head = "";
      try { head = readFileHead(file, 262144); } catch { /* best effort */ }
      const title = tc.recordedTitle(head);
      const human = tc.firstHumanSnippet(head, backend);
      let cwd = null;
      for (const line of head.split("\n")) { const m = line.match(/"cwd":"([^"]+)"/); if (m) { cwd = m[1]; break; } }
      const folder = cwd ? path.basename(cwd) : null;
      return { file, sessionId, mtime, title, human, folder, label: title || human || sessionId.slice(0, 8) };
    });
  }
  // An imported Antigravity conversation becomes this vault's, so it's listed and resumable.
  async importSession({ backend, sessionId, file }) {
    const res = await this._tc().writeDurableTranscript(this._vaultTranscriptIO(), {
      ...this.transcriptTarget(), backend, sessionId, transcriptFile: file,
    });
    if (res && backend === "antigravity") await this.rememberAntigravitySession(sessionId);
    // The sidebar lists an imported Antigravity session from now on.
    if (res) this.refreshBrowsers();
    return res;
  }
  importSessionFlow() {
    new ChoicePickerModal(this.app, REAL_BACKENDS, {
      placeholder: "Import: which CLI did the session run on?",
      label: (b) => CLI_BACKENDS[b].label,
      onPick: (backend) => {
        const sessions = this.listImportableSessions(backend);
        if (!sessions.length) { new import_obsidian.Notice(`No ${CLI_BACKENDS[backend].label} sessions found.`); return; }
        new ChoicePickerModal(this.app, sessions, {
          placeholder: "Pick the session to import",
          label: (s) => s.label,
          // Folder, short id, and age: enough to tell same-titled sessions apart.
          sub: (s) => [s.folder, s.sessionId.slice(0, 8), this.relativeTime(s.mtime)].filter(Boolean).join(" · "),
          onPick: async (s) => {
            try {
              const res = await this.importSession({ backend, sessionId: s.sessionId, file: s.file });
              if (res && res.path) new import_obsidian.Notice(`Imported ${res.added} turn(s) to ${res.path}`);
              else new import_obsidian.Notice("Nothing to import (no turns it could read).");
            } catch (e) { new import_obsidian.Notice("Import failed: " + (e?.message || e)); }
          },
        }).open();
      },
    }).open();
  }
  // The transcript note for a session id, or null: in the transcripts folder, a note
  // whose name ends in the id's short or long key and whose frontmatter records the id.
  findTranscriptNoteBySessionId(sessionId) {
    if (!sessionId) return null;
    const tc = this._tc();
    const id = String(sessionId);
    const ends = [`(${tc.noteIdKey(id)}).md`, `(${tc.noteIdKey(id, true)}).md`];
    const root = this.app.vault.getAbstractFileByPath(this.folderOf("transcriptsFolder"));
    if (!(root instanceof import_obsidian.TFolder)) return null;
    for (const child of root.children || []) {
      if (!(child instanceof import_obsidian.TFile) || !ends.some((e) => child.name.endsWith(e))) continue;
      const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
      if (fm) { if (String(fm.session_id || "") === id) return child; continue; }
      // Just written, not indexed yet: its frontmatter read from disk.
      try {
        if (tc.noteSessionId(readFileHead(path.join(this.getVaultPath(), child.path), 4096)) === id) return child;
      } catch { /* best effort */ }
    }
    return null;
  }
};
export { TranscriptMethods };
