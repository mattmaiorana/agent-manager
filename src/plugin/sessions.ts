
import type { Dirent, Stats } from "fs";
import type { WorkspaceLeaf } from "obsidian";
import { fs, import_obsidian, os, path } from "../externals.js";
import { REAL_BACKENDS, isBackendKey, stripContinuationSuffix } from "../constants/backends.js";
import type { BackendKey } from "../constants/backends.js";
import { SESSION_NAME_PROMPT_PREFIX, SESSION_NAME_PROMPT_SUFFIX } from "../constants/names.js";
import { isCodexSubagentSessionMeta, lastMessageTsOf, readFileHead } from "../sessions/transcript-files.js";
import type { Browser, LaunchOptions, OpenSession, Session, SessionRecord, StoreRecord } from "../types.js";
import { isArray, stringOf } from "../util/guards.js";
import type { AgentManagerPlugin } from "./main.js";
import { notice } from "../vault-terminal/notice";
const HEAD_CACHE_MAX = 4096;

interface ClaudeTitleLine {
  type?: unknown;
  customTitle?: unknown;
  sessionId?: string;
}
interface CodexLine {
  type?: unknown;
  payload: {
    session_id?: unknown;
    id?: unknown;
    cwd?: string;
    type?: unknown;
    role?: unknown;
    message?: unknown;
    content?: { type?: unknown; text?: unknown }[];
  };
}
interface AntigravityLine {
  type?: unknown;
  content?: unknown;
}
interface ClaudeHead {
  title: string | null;
  sessionId: string | null;
  cwd: string | null;
  firstMessage: string;
}
type CodexHead = { subagent: true } | { subagent?: undefined; sessionId: string; title: string | null; cwd: string; firstMessage: string };
interface AntigravityHead {
  title: string | null;
  firstMessage: string;
}
type LaunchSource = Browser | Session | null | undefined;

class SessionMethods {
  getCurrentBackend(this: AgentManagerPlugin): BackendKey {
    const key = this.pluginData.cliBackend || "claude";
    return isBackendKey(key) ? key : "claude";
  }
  getBrowserBackends(this: AgentManagerPlugin): BackendKey[] {
    const stored = this.pluginData.browserBackends;
    const list: readonly unknown[] = isArray(stored) && stored.length ? stored : REAL_BACKENDS;
    const keys = list.filter((k) => isBackendKey(k));
    const installed = keys.filter((k) => this.isInstalled(k));
    if (installed.length) return installed;
    const anyInstalled = REAL_BACKENDS.filter((k) => this.isInstalled(k));
    return anyInstalled.length ? anyInstalled : keys;
  }
  headParse<T>(this: AgentManagerPlugin, full: string, mtimeMs: number, compute: () => T): T {
    if (!this._headParseCache) this._headParseCache = new Map();
    const hit = this._headParseCache.get(full);
    const read = this._headParseRead || 0;
    if (hit && hit.mtime === mtimeMs) { hit.read = read; return hit.value as T; }
    const value = compute();
    this._headParseCache.set(full, { mtime: mtimeMs, value, read });
    return value;
  }
  sweepHeadCache(this: AgentManagerPlugin): void {
    const cache = this._headParseCache;
    const read = this._headParseRead || 0;
    this._headParseRead = read + 1;
    if (!cache || cache.size <= HEAD_CACHE_MAX) return;
    for (const [file, entry] of cache) if (entry.read !== read) cache.delete(file);
  }
  markedTitle(this: AgentManagerPlugin, text: unknown): string | null {
    if (typeof text !== "string") return null;
    const at = text.indexOf(SESSION_NAME_PROMPT_PREFIX);
    if (at === -1) return null;
    const from = at + SESSION_NAME_PROMPT_PREFIX.length;
    const to = text.indexOf(SESSION_NAME_PROMPT_SUFFIX, from);
    return to === -1 ? null : text.slice(from, to);
  }
  storeRoot(this: AgentManagerPlugin, backendKey: string): string {
    const home = os.homedir();
    if (backendKey === "claude") return path.join(home, ".claude", "projects");
    if (backendKey === "codex") return path.join(home, ".codex", "sessions");
    return path.join(home, ".gemini", "antigravity-cli", "brain");
  }
  readStore(this: AgentManagerPlugin, backendKey: string, cwds: Set<string> | null, onlyId: string | null = null): StoreRecord[] {
    if (backendKey === "claude") return this.readClaudeStore(cwds, onlyId);
    if (backendKey === "codex") return this.readCodexStore(cwds, onlyId);
    if (backendKey === "antigravity") return this.readAntigravityStore(onlyId);
    return [];
  }
  readClaudeStore(this: AgentManagerPlugin, cwds: Set<string> | null, onlyId: string | null = null): StoreRecord[] {
    const root = this.storeRoot("claude");
    let dirs: { cwd: string | null; dir: string }[];
    if (cwds) dirs = [...cwds].map((cwd) => ({ cwd, dir: path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, "-")) }));
    else {
      try { dirs = fs.readdirSync(root).map((slug) => ({ cwd: null, dir: path.join(root, slug) })); } catch { return []; }
    }
    const out: StoreRecord[] = [];
    for (const { cwd, dir } of dirs) {
      let files: string[];
      if (onlyId) files = [`${onlyId}.jsonl`];
      else {
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      }
      for (const f of files) {
        const full = path.join(dir, f);
        let stat: Stats, parsed: ClaudeHead;
        try {
          stat = fs.statSync(full);
          parsed = this.headParse(full, stat.mtimeMs, () => this.parseClaudeHead(full));
        } catch {
          continue;
        }
        out.push({
          rawTitle: parsed.title,
          firstMessage: parsed.firstMessage || "",
          sessionId: parsed.sessionId || f.replace(/\.jsonl$/, ""),
          mtime: stat.mtimeMs,
          file: full,
          backend: "claude",
          cwd: cwd || parsed.cwd,
        });
      }
    }
    return out;
  }
  parseClaudeHead(this: AgentManagerPlugin, full: string): ClaudeHead {
    const content = readFileHead(full, 65536);
    const out: ClaudeHead = { title: null, sessionId: null, cwd: null, firstMessage: this._tc().firstHumanSnippet(content, "claude") };
    const cwd = content.match(/"cwd":("(?:[^"\\]|\\.)*")/);
    if (cwd) { try { out.cwd = path.resolve(JSON.parse(cwd[1]) as string); } catch { /* empty */ } }
    let from = 0;
    while (true) {
      const idx = content.indexOf("custom-title", from);
      if (idx === -1) break;
      const start = content.lastIndexOf("\n", idx) + 1;
      let end = content.indexOf("\n", idx);
      if (end === -1) end = content.length;
      try {
        const rec = JSON.parse(content.slice(start, end)) as ClaudeTitleLine;
        if (rec.type === "custom-title" && typeof rec.customTitle === "string") {
          out.title = this._tc().isCompactionContinuation(content) ? stripContinuationSuffix(rec.customTitle) : rec.customTitle;
          out.sessionId = rec.sessionId || null;
          break;
        }
      } catch { /* empty */ }
      from = idx + 12;
    }
    return out;
  }
  readCodexStore(this: AgentManagerPlugin, cwds: Set<string> | null, onlyId: string | null = null): StoreRecord[] {
    const files: string[] = [];
    const pending = [this.storeRoot("codex")];
    while (pending.length) {
      const dir = pending.pop() as string;
      let entries: Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) pending.push(full);
        else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name) && (!onlyId || entry.name.includes(onlyId))) files.push(full);
      }
    }
    const out: StoreRecord[] = [];
    for (const full of files) {
      let stat: Stats, parsed: CodexHead | null;
      try {
        stat = fs.statSync(full);
        parsed = this.headParse(full, stat.mtimeMs, () => this.parseCodexHead(full));
      } catch {
        continue;
      }
      if (!parsed || parsed.subagent) continue;
      if (cwds && !cwds.has(parsed.cwd)) continue;
      if (onlyId && parsed.sessionId !== onlyId) continue;
      out.push({ rawTitle: parsed.title, firstMessage: parsed.firstMessage || "", sessionId: parsed.sessionId, mtime: stat.mtimeMs, file: full, backend: "codex", cwd: parsed.cwd });
    }
    return out;
  }
  parseCodexHead(this: AgentManagerPlugin, full: string): CodexHead | null {
    const head = readFileHead(full, 262144);
    const lines = head.split("\n");
    let meta: CodexLine | null;
    try { meta = JSON.parse(lines[0]) as CodexLine | null; } catch { return null; }
    if (isCodexSubagentSessionMeta(meta)) return { subagent: true };
    if (meta?.type !== "session_meta") return null;
    const sessionId = meta.payload.session_id || meta.payload.id;
    if (typeof sessionId !== "string") return null;
    const cwd = path.resolve(meta?.payload?.cwd || "");
    let title: string | null = null;
    for (let i = 1; i < lines.length && title === null; i++) {
      let record: CodexLine | null;
      try { record = JSON.parse(lines[i]) as CodexLine | null; } catch { continue; }
      const texts: unknown[] = [];
      if (record?.type === "event_msg" && record?.payload?.type === "user_message") {
        texts.push(record.payload.message);
      } else if (record?.type === "response_item" && record?.payload?.type === "message" && record?.payload?.role === "user") {
        for (const item of record.payload.content || []) {
          if (item?.type === "input_text") texts.push(item.text);
        }
      }
      for (const text of texts) {
        title = this.markedTitle(text);
        if (title !== null) break;
      }
    }
    return { sessionId, title, cwd, firstMessage: this._tc().firstHumanSnippet(head, "codex") };
  }
  readAntigravityStore(this: AgentManagerPlugin, onlyId: string | null = null): StoreRecord[] {
    const root = this.storeRoot("antigravity");
    let names: string[];
    if (onlyId) names = [onlyId];
    else {
      try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
    }
    const out: StoreRecord[] = [];
    for (const uuid of names) {
      const full = path.join(root, uuid, ".system_generated", "logs", "transcript.jsonl");
      let stat: Stats, parsed: AntigravityHead;
      try {
        stat = fs.statSync(full);
        parsed = this.headParse(full, stat.mtimeMs, (): AntigravityHead => {
          const head = readFileHead(full, 65536);
          const firstMessage = this._tc().firstHumanSnippet(head, "antigravity");
          for (const ln of head.split("\n")) {
            let rec: AntigravityLine | null;
            try { rec = JSON.parse(ln) as AntigravityLine | null; } catch { continue; }
            if (rec?.type !== "USER_INPUT") continue;
            const title = this.markedTitle(rec.content);
            if (title !== null) return { title, firstMessage };
          }
          return { title: null, firstMessage };
        });
      } catch {
        continue;
      }
      out.push({ rawTitle: parsed.title, firstMessage: parsed.firstMessage || "", sessionId: uuid, mtime: stat.mtimeMs, file: full, backend: "antigravity", cwd: null });
    }
    return out;
  }
  sessionIndex(this: AgentManagerPlugin): Promise<SessionRecord[]> {
    const now = Date.now();
    if (this._sessionIndex && now - this._sessionIndex.at < 400) return this._sessionIndex.records;
    const records = this._readSessionIndex();
    this._sessionIndex = { at: now, records };
    return records;
  }
  invalidateSessionIndex(this: AgentManagerPlugin): void {
    this._sessionIndex = null;
  }
  async _readSessionIndex(this: AgentManagerPlugin): Promise<SessionRecord[]> {
    const cwds = this.sessionCwds();
    const found: StoreRecord[] = [];
    for (const backend of REAL_BACKENDS) {
      try { found.push(...this.readStore(backend, cwds)); } catch { /* empty */ }
    }
    const records = found.map((r) => this.classify(r));
    records.sort((a, b) => b.mtime - a.mtime);
    this.sweepHeadCache();
    return records;
  }
  sessionCwds(this: AgentManagerPlugin): Set<string> {
    const cwds = new Set([path.resolve(this.getVaultPath()), path.resolve(this.startDir())]);
    for (const dir of isArray(this.pluginData.sessionFolders) ? this.pluginData.sessionFolders : []) {
      if (typeof dir === "string" && dir) cwds.add(path.resolve(dir));
    }
    for (const leaf of this.sessionLeaves()) {
      const dir = this.sessionOf(leaf)?.workingDir || this.savedSessionState(leaf)?.workingDir;
      if (dir) cwds.add(path.resolve(dir));
    }
    for (const dir of [...cwds]) {
      try { cwds.add(fs.realpathSync(dir)); } catch { /* empty */ }
    }
    return cwds;
  }
  defaultLaunchBackend(this: AgentManagerPlugin): BackendKey {
    const offered = this.getBrowserBackends();
    return offered.includes(this.getCurrentBackend()) ? this.getCurrentBackend() : offered[0] ?? REAL_BACKENDS[0];
  }
  classify(this: AgentManagerPlugin, record: StoreRecord): SessionRecord {
    const r = record as StoreRecord & Partial<SessionRecord>;
    r.listed = r.backend !== "antigravity" || this.isAntigravitySessionHere(r.sessionId);
    const vault = path.resolve(this.getVaultPath());
    if (r.cwd === vault) r.cwd = null;
    const launched = r.rawTitle || r.firstMessage || (r.sessionId ? `Session ${String(r.sessionId).slice(0, 8)}` : "Untitled");
    const override = this.pluginData.sessionNames?.[r.sessionId];
    r.displayName = override != null ? override : launched;
    r.title = r.displayName;
    return r as SessionRecord;
  }
  async listedSessions(this: AgentManagerPlugin): Promise<SessionRecord[]> {
    return (await this.sessionIndex()).filter((r) => r.listed);
  }
  isAntigravitySessionHere(this: AgentManagerPlugin, id: string | null | undefined): boolean {
    return !!id && Array.isArray(this.pluginData.antigravitySessions) && this.pluginData.antigravitySessions.includes(id);
  }
  async rememberAntigravitySession(this: AgentManagerPlugin, id: string | null | undefined): Promise<void> {
    if (!id || !/^[0-9a-fA-F-]{16,}$/.test(id) || this.isAntigravitySessionHere(id)) return;
    this.pluginData.antigravitySessions = [...(this.pluginData.antigravitySessions || []), id];
    this.invalidateSessionIndex();
    await this.savePluginData();
  }
  antigravityConversationIds(this: AgentManagerPlugin): string[] {
    try { return fs.readdirSync(this.storeRoot("antigravity"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  }
  newAntigravityConversation(this: AgentManagerPlugin, before: Set<string>, since: number, sourceId: string | null | undefined): string | null {
    const root = this.storeRoot("antigravity");
    const held = new Set(this.sessionObjects().map((v) => v._ownSessionId()).filter(Boolean));
    const found = this.antigravityConversationIds().filter((id) => {
      if (before.has(id) || id === sourceId || held.has(id) || !/^[0-9a-fA-F-]{16,}$/.test(id)) return false;
      try { const st = fs.statSync(path.join(root, id)); const born = st.birthtimeMs || st.mtimeMs; return born >= since - 250 && born <= since + 30000; } catch { return false; }
    });
    return found.length === 1 ? found[0] : null;
  }
  async adoptSideChat(this: AgentManagerPlugin, id: string | null | undefined, name: string | null | undefined, sourceId: string | null = null): Promise<void> {
    if (!id) return;
    this.pluginData.sideChats = { ...(this.pluginData.sideChats || {}), [id]: sourceId || "" };
    if (name) this.pluginData.sessionNames = { ...(this.pluginData.sessionNames || {}), [id]: name };
    const agy = this.antigravityConversationIds().includes(id);
    if (agy && !this.isAntigravitySessionHere(id)) this.pluginData.antigravitySessions = [...(this.pluginData.antigravitySessions || []), id];
    this.invalidateSessionIndex();
    await this.savePluginData();
  }
  forgetAntigravitySession(this: AgentManagerPlugin, id: string): void {
    const list = this.pluginData.antigravitySessions;
    if (Array.isArray(list) && list.includes(id)) list.splice(list.indexOf(id), 1);
  }
  async findSessionById(this: AgentManagerPlugin, sessionId: string | null | undefined, { own = false }: { own?: boolean } = {}): Promise<SessionRecord | null> {
    if (!sessionId || !/^[0-9a-fA-F-]{16,}$/.test(String(sessionId))) return null;
    const hit = (await this.sessionIndex()).find((r) => r.sessionId === sessionId);
    if (hit) return hit.listed || own ? hit : null;
    for (const backend of REAL_BACKENDS) {
      if (backend === "antigravity" && !own) continue;
      let found: StoreRecord[] = [];
      try { found = this.readStore(backend, null, sessionId); } catch { /* empty */ }
      if (found.length) return this.classify(found[0]);
    }
    return null;
  }
  lastActivity(this: AgentManagerPlugin, backend: string, file: string | null | undefined, mtime: number | null | undefined): number {
    if (backend !== "claude" || !file) return mtime || 0;
    const cache = this._lastActivityCache || (this._lastActivityCache = new Map<string, { mtime: number | null | undefined; at: number }>());
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit.at;
    const at = lastMessageTsOf(file) || mtime || 0;
    cache.set(file, { mtime, at });
    return at;
  }
  isPinned(this: AgentManagerPlugin, sessionId: string | null | undefined): boolean {
    return !!sessionId && Object.prototype.hasOwnProperty.call(this.pluginData.pinnedSessions || {}, sessionId);
  }
  dropPin(this: AgentManagerPlugin, sessionId: string): void {
    if (this.pluginData.pinnedSessions) delete this.pluginData.pinnedSessions[sessionId];
  }
  async togglePin(this: AgentManagerPlugin, sessionId: string | null | undefined): Promise<void> {
    if (!sessionId) return;
    if (this.isPinned(sessionId)) this.dropPin(sessionId);
    else this.pluginData.pinnedSessions = { ...(this.pluginData.pinnedSessions || {}), [sessionId]: Date.now() };
    await this.savePluginData();
  }
  shortDate(this: AgentManagerPlugin, ms: number | null | undefined): string {
    const d = new Date(ms || Date.now());
    const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }
  async readPinnedSessions(this: AgentManagerPlugin): Promise<SessionRecord[]> {
    const pins = this.pluginData.pinnedSessions || {};
    if (!Object.keys(pins).length) return [];
    const has = (id: string | null | undefined): id is string => !!id && Object.prototype.hasOwnProperty.call(pins, id);
    const found = (await this.listedSessions()).filter((s) => has(s.sessionId));
    const ids = new Set(found.map((s) => s.sessionId));
    const tabs: OpenSession[] = this.getOpenSessions();
    for (const leaf of this.sessionLeaves()) {
      if (this.sessionOf(leaf)) continue;
      const st = this.savedSessionState(leaf);
      if (st && st.sessionTitle && st.backendKey) tabs.push({ title: st.sessionTitle, backendKey: st.backendKey, sessionId: st.sessionId || null });
    }
    for (const o of tabs) {
      if (!has(o.sessionId) || ids.has(o.sessionId)) continue;
      ids.add(o.sessionId);
      found.push(this.openSessionRecord(o));
    }
    return found.sort((a, b) => pins[a.sessionId as string] - pins[b.sessionId as string]);
  }
  async reorderPinnedSession(this: AgentManagerPlugin, draggedId: string | null | undefined, beforeId: string | null | undefined): Promise<void> {
    if (!draggedId || draggedId === beforeId) return;
    const pins = this.pluginData.pinnedSessions || {};
    const order = Object.keys(pins).filter((x) => x !== draggedId).sort((a, b) => pins[a] - pins[b]);
    const idx = beforeId ? order.indexOf(beforeId) : -1;
    if (idx >= 0) order.splice(idx, 0, draggedId); else order.push(draggedId);
    this.pluginData.pinnedSessions = Object.fromEntries(order.map((id, i) => [id, i + 1]));
    await this.savePluginData();
  }
  relativeTime(this: AgentManagerPlugin, ms: number): string {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(mo / 12)}y ago`;
  }
  async startSession(this: AgentManagerPlugin, subject: string, sourceView: LaunchSource, opts: LaunchOptions | null = null): Promise<Session | null> {
    if (this.startFolderMissing()) {
      notice(`Agent Manager: the AGENTS.md folder “${stringOf(this.pluginData.startFolder)}” isn't in this vault anymore, so no session was started. Choose another in Settings → Agent Manager.`);
      return null;
    }
    const lb = (sourceView as { _launchBackend?: unknown } | null | undefined)?._launchBackend;
    const fallback = this.defaultLaunchBackend();
    const launchBackend = (opts?.backendOverride && isBackendKey(opts.backendOverride)) ? opts.backendOverride
      : (lb && isBackendKey(lb) ? lb : fallback);
    const prepare = (v: Session) => {
      if (launchBackend) v.backendKey = launchBackend;
      v._notePath = opts?.notePath || null;
      v._folderPath = opts?.folderPath || null;
      v._ticketLinks = {};
      this.resetNoteWriteback(v);
      v._handoffNote = opts?.handoffNote || null;
      v._handoffFromBackend = opts?.handoffFromBackend || null;
      v._handoffIntent = opts?.handoffIntent || null;
      v._handoffMode = opts?.handoffMode || (opts?.handoffNote ? "side-chat" : null);
      v._daily = !!opts?.daily;
      v._setup = !!opts?.setup;
      v._agentId = opts?.agentId !== undefined ? opts.agentId : this.launchAgentId({ notePath: opts?.notePath, folderPath: opts?.folderPath });
      v._forkFrom = opts?.forkFrom || null;
      v._noteSupport = !!opts?.sideSession;
      v._noteClaim = !!opts?.notePath && !opts?.sideSession;
      v._noteReplaces = !!opts?.newMain;
      v._noteLaunchAt = v._noteClaim ? Date.now() : null;
      if (v._noteClaim) (this._noteLaunches || (this._noteLaunches = new Map<string, number | null>())).set(opts?.notePath as string, v._noteLaunchAt);
    };
    const ticket = opts?.notePath && !opts.sideSession && !opts.forkFrom && !opts.newMain && this.isTicketNote(opts.notePath) ? opts.notePath : null;
    if (ticket) {
      const launching = this._ticketLaunching || (this._ticketLaunching = new Set<string>());
      if (launching.has(ticket)) return null;
      const open = this.ticketMainLeaf(ticket);
      if (open) {
        void this.revealAndFlash(open);
        return this.sessionOf(open);
      }
      launching.add(ticket);
    }
    try {
      this.invalidateSessionIndex();
      const view = await this.openSessionLeaf("tab");
      if (!view) return null;
      prepare(view);
      view.launchSession(subject);
      return view;
    } finally {
      if (ticket) this._ticketLaunching?.delete(ticket);
    }
  }
  todaysChatLeaf(this: AgentManagerPlugin, agentId?: string | null): WorkspaceLeaf | null {
    const switched = agentId === undefined ? this.switchedAgentId() : agentId;
    const name = this.dailyChatName(switched);
    for (const leaf of this.sessionLeaves()) {
      const v = this.sessionOf(leaf);
      const title = v ? v.sessionTitle : this.savedSessionState(leaf)?.sessionTitle;
      if (title === name && (switched === null || this.listedAgentOf(this.agentOfLeaf(leaf)) === switched)) return leaf;
    }
    return null;
  }
  sourceOf(this: AgentManagerPlugin, sessionId: string | null | undefined): { notePath: string } | { folderPath: string } | null {
    const t = this.findTranscriptNoteBySessionId(sessionId);
    const src: unknown = t && this.app.metadataCache.getFileCache(t)?.frontmatter?.source;
    if (typeof src !== "string") return null;
    if (src.endsWith("/") && !src.startsWith("[[")) {
      const dir = this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(src.slice(0, -1)));
      return dir instanceof import_obsidian.TFolder && !dir.isRoot() ? { folderPath: dir.path } : null;
    }
    const m = src.match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/);
    const note = m && t && this.app.metadataCache.getFirstLinkpathDest(m[1], t.path);
    return note instanceof import_obsidian.TFile ? { notePath: note.path } : null;
  }
  async openTodaysChat(this: AgentManagerPlugin, sourceView: LaunchSource = null, agentId?: string | null): Promise<void> {
    const switched = agentId === undefined ? this.switchedAgentId() : agentId;
    const opening = this._openingToday || (this._openingToday = new Set());
    const key = switched ?? "";
    if (opening.has(key)) return;
    opening.add(key);
    try {
      const leaf = this.todaysChatLeaf(switched);
      if (leaf) {
        void this.revealAndFlash(leaf);
        return;
      }
      const name = this.dailyChatName(switched);
      let sessions: SessionRecord[] = [];
      try { sessions = await this.listedSessions(); } catch { /* empty */ }
      const earlier = sessions.find((s) => s.displayName === name && (switched === null || this.listedAgentOf(this.recordedAgentId(s.sessionId)) === switched));
      if (earlier) { await this.startResume(earlier, sourceView); return; }
      const offered = this.getBrowserBackends();
      const backend = offered.includes(this.getCurrentBackend()) ? this.getCurrentBackend() : offered[0];
      await this.startSession(name, null, { backendOverride: backend, daily: true, agentId: switched || "" });
    } finally {
      opening.delete(key);
    }
  }
  placeMissing(this: AgentManagerPlugin, session: { cwd: string | null } | null | undefined): boolean {
    if (!session || !session.cwd) return false;
    try { return !fs.statSync(session.cwd).isDirectory(); } catch { return true; }
  }
  async startResume(this: AgentManagerPlugin, session: SessionRecord, sourceView: LaunchSource): Promise<void> {
    if (this.placeMissing(session)) {
      const note = this.findTranscriptNoteBySessionId(session.sessionId);
      notice(`Agent Manager: that session ran in ${session.cwd}, which is not on this machine.${note ? " Opening its transcript." : ""}`);
      if (note) await this.openInNotesArea(note);
      return;
    }
    const key = `${session.backend}\n${session.sessionId || session.title}`;
    this._resuming = this._resuming || new Set();
    if (this._resuming.has(key)) return;
    this._resuming.add(key);
    try {
      const view = await this.openSessionLeaf("tab");
      if (!view) return;
      view.resumeSession(session);
    } finally {
      this._resuming.delete(key);
    }
  }
}
export { SessionMethods };
