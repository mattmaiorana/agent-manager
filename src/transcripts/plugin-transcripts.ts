
import type { TFile } from "obsidian";
import { fs, import_obsidian, os, path } from "../externals.js";
import { CLI_BACKENDS, REAL_BACKENDS } from "../constants/backends.js";
import type { BackendKey } from "../constants/backends.js";
import { isCodexSubagentSessionMeta, readFileHead, readJsonlFirstRecord } from "../sessions/transcript-files.js";
import { ChoicePickerModal } from "../ui/modals.js";
import * as transcriptCore from "./transcript-core.js";
import type { TranscriptIO, TranscriptWrite } from "../types.js";
import { errorMessage, stringOf } from "../util/guards.js";
import type { AgentManagerPlugin } from "../plugin/main.js";
import { notice } from "../vault-terminal/notice";
interface ImportableSession {
  file: string;
  sessionId: string;
  mtime: number;
  title: string | null;
  human: string;
  folder: string | null;
  label: string;
}
class TranscriptMethods {
  _tc(this: AgentManagerPlugin): typeof transcriptCore {
    return transcriptCore;
  }
  _vaultTranscriptIO(this: AgentManagerPlugin): TranscriptIO {
    const a = this.app.vault.adapter;
    return {
      exists: (rel) => a.exists(rel),
      read: (rel) => a.read(rel),
      create: (rel, content) => a.write(rel, content),
      append: (rel, content) => a.append(rel, content),
      ensureDir: async (rel) => { try { if (!(await a.exists(rel))) await a.mkdir(rel); } catch { /* empty */ } },
      list: async (rel) => { try { const r = await a.list(rel); return (r.files || []).map((f) => f.split("/").pop() as string  ); } catch { return []; } },
    };
  }
  listImportableSessions(this: AgentManagerPlugin, backend: BackendKey): ImportableSession[] {
    const files: string[] = [];
    const rd = (d: string) => { try { return fs.readdirSync(d); } catch { return []; } };
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
        try { if (fs.existsSync(t)) files.push(t); } catch { /* empty */ }
      }
    }
    const sorted = files.map((f): { file: string; mtime: number } | null => { try { return { file: f, mtime: fs.statSync(f).mtimeMs }; } catch { return null; } })
      .filter((e) => e !== null).sort((a, b) => b.mtime - a.mtime);
    const withStat: { file: string; mtime: number }[] = [];
    for (const entry of sorted) {
      if (backend === "codex" && isCodexSubagentSessionMeta(readJsonlFirstRecord(entry.file))) continue;
      withStat.push(entry);
      if (withStat.length === 40) break;
    }
    const tc = this._tc();
    return withStat.map(({ file, mtime }) => {
      const sessionId = tc.deriveSessionId(file, backend);
      let head = "";
      try { head = readFileHead(file, 262144); } catch { /* empty */ }
      const title = tc.recordedTitle(head);
      const human = tc.firstHumanSnippet(head, backend);
      let cwd: string | null = null;
      for (const line of head.split("\n")) { const m = line.match(/"cwd":"([^"]+)"/); if (m) { cwd = m[1]; break; } }
      const folder = cwd ? path.basename(cwd) : null;
      return { file, sessionId, mtime, title, human, folder, label: title || human || sessionId.slice(0, 8) };
    });
  }
  async importSession(this: AgentManagerPlugin, { backend, sessionId, file }: { backend: BackendKey; sessionId: string; file: string }): Promise<TranscriptWrite | null> {
    const agentId = this.recordedAgentId(sessionId) ?? null;
    const res = await this._tc().writeDurableTranscript(this._vaultTranscriptIO(), {
      ...this.transcriptTarget(agentId), backend, sessionId, transcriptFile: file,
      agent: this.agentById(agentId)?.name || null,
      findExisting: () => this.findTranscriptNoteBySessionId(sessionId)?.path || null,
    });
    if (res && (backend === "claude" || backend === "codex")) await this.writeSubagentTranscripts(file, res.path, sessionId, this.agentById(agentId)?.name || null, backend);
    if (res && backend === "antigravity") await this.rememberAntigravitySession(sessionId);
    if (res) this.refreshBrowsers();
    return res;
  }
  importSessionFlow(this: AgentManagerPlugin): void {
    new ChoicePickerModal(this.app, REAL_BACKENDS, {
      placeholder: "Import: which CLI did the session run on?",
      label: (b: BackendKey) => CLI_BACKENDS[b].label,
      onPick: (backend: BackendKey) => {
        const sessions = this.listImportableSessions(backend);
        if (!sessions.length) { notice(`No ${CLI_BACKENDS[backend].label} sessions found.`); return; }
        new ChoicePickerModal(this.app, sessions, {
          placeholder: "Pick the session to import",
          label: (s: ImportableSession) => s.label,
          sub: (s: ImportableSession) => [s.folder, s.sessionId.slice(0, 8), this.relativeTime(s.mtime)].filter(Boolean).join(" · "),
          onPick: async (s: ImportableSession) => {
            try {
              const res = await this.importSession({ backend, sessionId: s.sessionId, file: s.file });
              if (res && res.path) notice(`Imported ${res.added} turn(s) to ${res.path}`);
              else notice("Nothing to import (no turns it could read).");
            } catch (e) { notice("Import failed: " + stringOf(errorMessage(e))); }
          },
        }).open();
      },
    }).open();
  }
  findTranscriptNoteBySessionId(this: AgentManagerPlugin, sessionId: string | null | undefined): TFile | null {
    if (!sessionId) return null;
    const tc = this._tc();
    const id = String(sessionId);
    const ends = [`(${tc.noteIdKey(id)}).md`, `(${tc.noteIdKey(id, true)}).md`];
    const root = this.app.vault.getAbstractFileByPath(this.folderOf("transcriptsFolder"));
    const top = root instanceof import_obsidian.TFolder ? root.children : [];
    const children = [...top];
    for (const c of top) if (c instanceof import_obsidian.TFolder) children.push(...c.children);
    for (const child of children) {
      if (!(child instanceof import_obsidian.TFile) || !ends.some((e) => child.name.endsWith(e))) continue;
      const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
      if (fm) { if (String(fm.session_id || "") === id) return child; continue; }
      try {
        if (tc.noteSessionId(readFileHead(path.join(this.getVaultPath(), child.path), 4096)) === id) return child;
      } catch { /* empty */ }
    }
    const moved = this._movedTranscriptNotes || (this._movedTranscriptNotes = new Map<string, string>());
    const ownsId = (f: unknown): f is TFile => f instanceof import_obsidian.TFile && String(this.app.metadataCache.getFileCache(f)?.frontmatter?.session_id || "") === id;
    const last = this.app.vault.getAbstractFileByPath(moved.get(id) || "");
    if (ownsId(last)) return last;
    const found = this.app.vault.getMarkdownFiles().find(ownsId) || null;
    if (found) moved.set(id, found.path); else moved.delete(id);
    return found;
  }
  subagentFiles(this: AgentManagerPlugin, transcriptFile: string, backend: string, parentId: string): { file: string; id: string; title: string; sidechain: boolean }[] {
    if (backend === "claude") {
      const subDir = path.join(transcriptFile.replace(/\.jsonl$/, ""), "subagents");
      let names: string[] = [];
      try { names = fs.readdirSync(subDir).filter((n) => /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(n)).sort(); } catch { return []; }
      return names.map((n) => {
        const file = path.join(subDir, n);
        const metas = this._subagentMetas || (this._subagentMetas = new Map<string, { description?: unknown; agentType?: unknown }>());
        let meta = metas.get(file);
        if (!meta) {
          try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")) as { description?: unknown; agentType?: unknown }; metas.set(file, meta); } catch { meta = {}; }
        }
        const what = stringOf(meta.description).trim() || "Sub-agent";
        const type = stringOf(meta.agentType).trim();
        return { file, id: n.replace(/^agent-|\.jsonl$/g, ""), title: type ? `${what} (${type})` : what, sidechain: true };
      });
    }
    if (backend !== "codex" || !parentId) return [];
    const day = path.dirname(transcriptFile);
    const m = day.match(/^(.*)\/(\d{4})\/(\d{2})\/(\d{2})$/);
    const dayCache = this._subagentLists || (this._subagentLists = new Map<string, { at: number; dirs: string[] }>());
    const cached = dayCache.get(transcriptFile);
    const dirs = cached && Date.now() - cached.at < 5000 ? cached.dirs : [day];
    if (m && dirs !== cached?.dirs) {
      let last = Date.now();
      try { last = fs.statSync(transcriptFile).mtimeMs; } catch { /* empty */ }
      const startKey = `${m[2]}${m[3]}${m[4]}`;
      const end = new Date(last + 86400000);
      const endKey = `${end.getFullYear()}${String(end.getMonth() + 1).padStart(2, "0")}${String(end.getDate()).padStart(2, "0")}`;
      const ls = (d: string) => { try { return fs.readdirSync(d).filter((n) => /^\d+$/.test(n)).sort(); } catch { return []; } };
      for (const y of ls(m[1])) {
        if (y < m[2] || y > endKey.slice(0, 4)) continue;
        for (const mo of ls(path.join(m[1], y))) for (const d of ls(path.join(m[1], y, mo))) {
          const k = `${y}${mo}${d}`;
          if (k > startKey && k <= endKey) dirs.push(path.join(m[1], y, mo, d));
        }
      }
      dayCache.set(transcriptFile, { at: Date.now(), dirs });
    }
    const heads = this._codexSubHeads || (this._codexSubHeads = new Map<string, { id: string; parent: string; root: string; title: string } | null>());
    const out: { file: string; id: string; title: string; sidechain: boolean }[] = [];
    for (const dir of dirs) {
      let names: string[] = [];
      try { names = fs.readdirSync(dir).filter((n) => /^rollout-.*\.jsonl$/.test(n)).sort(); } catch { continue; }
      for (const n of names) {
        const file = path.join(dir, n);
        if (file === transcriptFile) continue;
        let head = heads.get(file);
        if (head === undefined) {
          head = null;
          const rec = readJsonlFirstRecord(file) as { type?: unknown; payload?: Record<string, unknown> } | null;
          const p = rec?.type === "session_meta" ? rec.payload : null;
          const src = p?.source as { subagent?: unknown } | null | undefined;
          if (p && src && typeof src === "object" && src.subagent != null) {
            const spawn = (src.subagent as { thread_spawn?: { parent_thread_id?: unknown; agent_nickname?: unknown; agent_path?: unknown } } | null)?.thread_spawn;
            const nick = stringOf(p.agent_nickname ?? spawn?.agent_nickname).trim();
            const task = stringOf(p.agent_path ?? spawn?.agent_path).trim().replace(/^.*\//, "");
            const kind = typeof src.subagent === "string" ? src.subagent : "";
            head = {
              id: stringOf(p.id), parent: stringOf(p.parent_thread_id ?? spawn?.parent_thread_id), root: stringOf(p.session_id),
              title: nick && task ? `${nick} (${task})` : nick || task || (kind ? `Sub-agent (${kind})` : "Sub-agent"),
            };
          }
          if (head || rec) heads.set(file, head);
        }
        if (head && head.id && head.id !== parentId && (head.parent === parentId || head.root === parentId)) out.push({ file, id: head.id, title: head.title, sidechain: false });
      }
    }
    return out;
  }
  subagentsGrew(this: AgentManagerPlugin, transcriptFile: string, backend: string, parentId: string): boolean {
    const sizes = this._subagentSizes;
    return this.subagentFiles(transcriptFile, backend, parentId).some(({ file }) => { try { return sizes?.get(file) !== fs.statSync(file).size; } catch { return false; } });
  }
  async writeSubagentTranscripts(this: AgentManagerPlugin, transcriptFile: string, parentNote: string, parentId: string, agent: string | null, backend = "claude"): Promise<void> {
    const subs = this.subagentFiles(transcriptFile, backend, parentId);
    if (!subs.length) return;
    const sizes = this._subagentSizes || (this._subagentSizes = new Map<string, number>());
    const tc = this._tc();
    const io = this._vaultTranscriptIO();
    const root = this.folderOf("transcriptsFolder");
    for (const sub of subs) {
      const file = sub.file;
      let size = 0;
      try { size = fs.statSync(file).size; } catch { continue; }
      if (sizes.get(file) === size) continue;
      try {
        const id = sub.id;
        const title = tc.sanitizeTranscriptName(sub.title);
        const linked = await tc.withTranscriptLock(tc.transcriptLockKey(root, parentId), async () => {
          const note = this.findTranscriptNoteBySessionId(parentId)?.path || parentNote;
          const dir = (0, import_obsidian.normalizePath)(note.replace(/\.md$/, ""));
          const parentFile = this.app.vault.getAbstractFileByPath(note);
          const source = parentFile instanceof import_obsidian.TFile ? `[[${this.app.metadataCache.fileToLinktext(parentFile, `${dir}/x.md`, true)}]]` : null;
          const res = await tc.writeDurableTranscript(io, {
            transcriptDir: dir, lockDir: dir, backend, sessionId: id, transcriptFile: file,
            sessionTitle: title, source, agent, sidechain: sub.sidechain,
          });
          if (!res) return false;
          const marker = `<!-- pl-sub:${id} -->`;
          const text = await io.read(note);
          if (!text.includes(marker)) await io.append(note, `\n_⏺ Sub-agent transcript: [[${res.path.replace(/\.md$/, "")}|${title}]]_\n${marker}\n`);
          return true;
        });
        if (linked) sizes.set(file, size);
      } catch { /* empty */ }
    }
  }
}
export { TranscriptMethods };
