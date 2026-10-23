// Sessions, the plugin's side: the CLIs' session stores, the session index, stars and pins, and starting or resuming a session.

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

// The CLIs' JSON lines, typed as the CLIs write them. A field the code checks before use
// is `unknown`; the rest are used as written, as they always were (a line that isn't the
// shape throws inside the reader's try, or reads undefined).
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
// What a head parse finds (cached by headParse).
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
// Where a launch came from: the sidebar, with its backend pick, or a session tab.
type LaunchSource = Browser | Session | null | undefined;

class SessionMethods {
  // The backend currently selected in the browser (the switcher sets this).
  getCurrentBackend(this: AgentManagerPlugin): BackendKey {
    const key = this.pluginData.cliBackend || "claude";
    return isBackendKey(key) ? key : "claude";
  }
  // Which backends the sidebar offers: the ones checked in settings (all three until
  // the list is edited; it never goes empty), less any the setup check didn't find.
  // When none of those is installed, the installed ones; when none at all is, the list
  // stands, and the sidebar says what to install.
  getBrowserBackends(this: AgentManagerPlugin): BackendKey[] {
    const stored = this.pluginData.browserBackends;
    const list: readonly unknown[] = isArray(stored) && stored.length ? stored : REAL_BACKENDS;
    const keys = list.filter((k) => isBackendKey(k));
    const installed = keys.filter((k) => this.isInstalled(k));
    if (installed.length) return installed;
    const anyInstalled = REAL_BACKENDS.filter((k) => this.isInstalled(k));
    return anyInstalled.length ? anyInstalled : keys;
  }
  // Head-parse cache. A transcript's name marker and session id live in its head and
  // are written once at launch, so they never change as the session grows; only its
  // mtime does. Keyed by (path, mtime): once warm, an idle file costs one statSync.
  // `compute` runs on a miss and returns the cacheable value, which may be null.
  headParse<T>(this: AgentManagerPlugin, full: string, mtimeMs: number, compute: () => T): T {
    if (!this._headParseCache) this._headParseCache = new Map();
    const hit = this._headParseCache.get(full);
    // A file is always parsed by the same reader (each CLI's files are in its own store),
    // so what's cached for it is what `compute` returns.
    if (hit && hit.mtime === mtimeMs) return hit.value as T;
    const value = compute();
    // A soft cap, so the cache can't grow without bound; clearing re-warms it.
    if (this._headParseCache.size > 4096) this._headParseCache.clear();
    this._headParseCache.set(full, { mtime: mtimeMs, value });
    return value;
  }
  // The title between the session-name marker's quotes, or null.
  markedTitle(this: AgentManagerPlugin, text: unknown): string | null {
    if (typeof text !== "string") return null;
    const at = text.indexOf(SESSION_NAME_PROMPT_PREFIX);
    if (at === -1) return null;
    const from = at + SESSION_NAME_PROMPT_PREFIX.length;
    // The suffix is found after the value, not anchored on the end, so anything
    // appended after the marker doesn't hide the session.
    const to = text.indexOf(SESSION_NAME_PROMPT_SUFFIX, from);
    return to === -1 ? null : text.slice(from, to);
  }
  // ---- Session stores ----
  // Each reader returns one backend's sessions as raw records, not filtered by title:
  // { rawTitle, sessionId, mtime, file, backend, cwd }. `cwds` is the set of working
  // directories to read (the vault); null reads every directory, which only a lookup
  // by id does.
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
  // Claude keeps one folder per working directory, named by the directory with every
  // non-alphanumeric replaced by "-", and one <uuid>.jsonl per conversation in it.
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
  // The launch name (`claude -n "<title>"`) is the FIRST custom-title record, at the
  // head. Claude retitles a session from its content as it runs, in later records, so
  // the last one would not be the name the user gave it. A rename rides on top as an
  // override. A session started outside the plugin has no launch name; its first
  // message stands in for one.
  parseClaudeHead(this: AgentManagerPlugin, full: string): ClaudeHead {
    const content = readFileHead(full, 65536);
    const out: ClaudeHead = { title: null, sessionId: null, cwd: null, firstMessage: this._tc().firstHumanSnippet(content, "claude") };
    const cwd = content.match(/"cwd":("(?:[^"\\]|\\.)*")/);
    // The match is a JSON string, so it parses to a string.
    if (cwd) { try { out.cwd = path.resolve(JSON.parse(cwd[1]) as string); } catch { /* best effort */ } }
    let from = 0;
    while (true) {
      const idx = content.indexOf("custom-title", from);
      if (idx === -1) break;
      const start = content.lastIndexOf("\n", idx) + 1;
      let end = content.indexOf("\n", idx);
      if (end === -1) end = content.length;
      try {
        // The parse and type check reject a "custom-title" that is only message text.
        const rec = JSON.parse(content.slice(start, end)) as ClaudeTitleLine;
        if (rec.type === "custom-title" && typeof rec.customTitle === "string") {
          // Claude's " (N)" comes off only when the head proves a compaction
          // continuation; a title that merely ends in "(digits)" stays as written.
          out.title = this._tc().isCompactionContinuation(content) ? stripContinuationSuffix(rec.customTitle) : rec.customTitle;
          out.sessionId = rec.sessionId || null;
          break;
        }
      } catch { /* best effort */ }
      from = idx + 12;
    }
    return out;
  }
  // Codex keeps every session in one tree of rollout files, each recording its working
  // directory in its first line. It has no name flag, so the title is the marker in
  // the opening message.
  readCodexStore(this: AgentManagerPlugin, cwds: Set<string> | null, onlyId: string | null = null): StoreRecord[] {
    const files: string[] = [];
    const pending = [this.storeRoot("codex")];
    while (pending.length) {
      // Never undefined: the loop runs while there's one to pop.
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
    // Reviewers and delegated agents inherit their parent's id and name marker. They
    // are not sessions a person resumes.
    if (isCodexSubagentSessionMeta(meta)) return { subagent: true };
    if (meta?.type !== "session_meta") return null;
    const sessionId = meta.payload.session_id || meta.payload.id;
    if (typeof sessionId !== "string") return null;
    const cwd = path.resolve(meta?.payload?.cwd || "");
    // The first marker wins: it is written once at launch, and a later message that
    // quotes the marker must not retitle the session.
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
  // Antigravity keeps one folder per conversation, named by its uuid, and records no
  // working directory, so every vault's conversations are in one store. The title is
  // the marker in the opening message.
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
  // ---- The session index ----
  // Every session in the vault's store, on every backend, read once. A render asks for
  // it several times, so one read serves calls that arrive together.
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
    // The vault's root, the starting folder, and every folder a session of this plugin
    // has run in, so a session started in an earlier starting folder stays listed.
    const cwds = new Set([path.resolve(this.getVaultPath()), path.resolve(this.startDir())]);
    for (const dir of isArray(this.pluginData.sessionFolders) ? this.pluginData.sessionFolders : []) {
      if (typeof dir === "string" && dir) cwds.add(path.resolve(dir));
    }
    // And wherever an open tab's session runs, so its reload restore and its
    // continuation and re-host tracking can still find it.
    for (const leaf of this.sessionLeaves()) {
      const dir = this.sessionOf(leaf)?.workingDir || this.savedSessionState(leaf)?.workingDir;
      if (dir) cwds.add(path.resolve(dir));
    }
    // A CLI records the folder's real path, so a vault reached through a symlink is
    // looked for under both.
    for (const dir of [...cwds]) {
      try { cwds.add(fs.realpathSync(dir)); } catch { /* a folder that's gone */ }
    }
    const found: StoreRecord[] = [];
    for (const backend of REAL_BACKENDS) {
      try { found.push(...this.readStore(backend, cwds)); } catch { /* best effort */ }
    }
    const records = found.map((r) => this.classify(r));
    records.sort((a, b) => b.mtime - a.mtime);
    return records;
  }
  // A record's name and whether it is listed. Claude and Codex sessions are read from
  // the vault's folder only, so each is listed; Antigravity's store is shared by every
  // vault, so only the conversations this plugin started in this vault are.
  classify(this: AgentManagerPlugin, record: StoreRecord): SessionRecord {
    // Classified in place: the record itself gains its name and listing.
    const r = record as StoreRecord & Partial<SessionRecord>;
    r.listed = r.backend !== "antigravity" || this.isAntigravitySessionHere(r.sessionId);
    const vault = path.resolve(this.getVaultPath());
    if (r.cwd === vault) r.cwd = null;
    // The name the session was launched with; else, for a session started outside the
    // plugin, its first message; else its short id. A rename is an override in plugin
    // data, keyed by session id.
    const launched = r.rawTitle || r.firstMessage || (r.sessionId ? `Session ${String(r.sessionId).slice(0, 8)}` : "Untitled");
    const override = this.pluginData.sessionNames?.[r.sessionId];
    r.displayName = override != null ? override : launched;
    r.title = r.displayName;
    // Every field of a SessionRecord is set just above.
    return r as SessionRecord;
  }
  // Every listed session, newest first.
  async listedSessions(this: AgentManagerPlugin): Promise<SessionRecord[]> {
    return (await this.sessionIndex()).filter((r) => r.listed);
  }
  // The Antigravity conversations started in this vault, by id (pluginData), since
  // Antigravity's store doesn't say which vault a conversation belongs to.
  isAntigravitySessionHere(this: AgentManagerPlugin, id: string | null | undefined): boolean {
    return !!id && Array.isArray(this.pluginData.antigravitySessions) && this.pluginData.antigravitySessions.includes(id);
  }
  async rememberAntigravitySession(this: AgentManagerPlugin, id: string | null | undefined): Promise<void> {
    if (!id || !/^[0-9a-fA-F-]{16,}$/.test(id) || this.isAntigravitySessionHere(id)) return;
    this.pluginData.antigravitySessions = [...(this.pluginData.antigravitySessions || []), id];
    this.invalidateSessionIndex();
    await this.savePluginData();
  }
  // Every conversation folder in Antigravity's store, by id.
  antigravityConversationIds(this: AgentManagerPlugin): string[] {
    try { return fs.readdirSync(this.storeRoot("antigravity"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  }
  // The conversation an Antigravity /fork just made: a folder that wasn't in `before`,
  // made since `since`, that isn't the source and no tab holds. Null until there is one,
  // or when there are two (another fork at the same moment), since guessing would put
  // two tabs on one conversation.
  newAntigravityConversation(this: AgentManagerPlugin, before: Set<string>, since: number, sourceId: string | null | undefined): string | null {
    const root = this.storeRoot("antigravity");
    const held = new Set(this.sessionObjects().map((v) => v._ownSessionId()).filter(Boolean));
    const found = this.antigravityConversationIds().filter((id) => {
      if (before.has(id) || id === sourceId || held.has(id) || !/^[0-9a-fA-F-]{16,}$/.test(id)) return false;
      try { const st = fs.statSync(path.join(root, id)); const born = st.birthtimeMs || st.mtimeMs; return born >= since - 250 && born <= since + 30000; } catch { return false; }
    });
    return found.length === 1 ? found[0] : null;
  }
  // A side chat has its id: it's recorded as one (sideChats, id to the source's id), so
  // following a re-host never mistakes it for its source's or another side chat's; it
  // keeps the name it was started with (a Codex or Antigravity fork has no name marker,
  // so the name is kept as a rename); and an Antigravity one is this vault's.
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
  // A session by id alone. The index covers the vault; a Claude or Codex session
  // anywhere else is found by looking across the whole store. An Antigravity
  // conversation another vault started is never found here.
  // `own`: a tab looking up its own id, which no vault filter applies to.
  async findSessionById(this: AgentManagerPlugin, sessionId: string | null | undefined, { own = false }: { own?: boolean } = {}): Promise<SessionRecord | null> {
    if (!sessionId || !/^[0-9a-fA-F-]{16,}$/.test(String(sessionId))) return null;
    const hit = (await this.sessionIndex()).find((r) => r.sessionId === sessionId);
    if (hit) return hit.listed || own ? hit : null;
    for (const backend of REAL_BACKENDS) {
      if (backend === "antigravity" && !own) continue;
      let found: StoreRecord[] = [];
      try { found = this.readStore(backend, null, sessionId); } catch { /* best effort */ }
      if (found.length) return this.classify(found[0]);
    }
    return null;
  }
  // When a session was last active, for sorting Recent's open sessions: a Claude transcript's last real
  // message, since Remote Control keeps appending bookkeeping to a session nobody is
  // using and bumps its file time.
  // Cached per file and mtime, so a file is read again only when it changes. Codex and
  // Antigravity transcripts don't timestamp each message, so they use the file time.
  lastActivity(this: AgentManagerPlugin, backend: string, file: string | null | undefined, mtime: number | null | undefined): number {
    if (backend !== "claude" || !file) return mtime || 0;
    const cache = this._lastActivityCache || (this._lastActivityCache = new Map<string, { mtime: number | null | undefined; at: number }>());
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit.at;
    const at = lastMessageTsOf(file) || mtime || 0;
    cache.set(file, { mtime, at });
    return at;
  }
  // Pinned sessions stay at the top of the home page when their tab closes, so ongoing
  // work is easy to get back to. Stored as session id to a sort key: the time it was
  // pinned, so a new pin goes last, renumbered 1..n when the section is reordered.
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
  // "Oct 1", with the year when it isn't this one.
  shortDate(this: AgentManagerPlugin, ms: number | null | undefined): string {
    const d = new Date(ms || Date.now());
    const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }
  // Every pinned session, in the section's order (drag-reorderable). An open session
  // the index hasn't listed yet (a Claude session before its first message has no
  // transcript) is pinned from its tab, so pinning it shows at once.
  async readPinnedSessions(this: AgentManagerPlugin): Promise<SessionRecord[]> {
    const pins = this.pluginData.pinnedSessions || {};
    if (!Object.keys(pins).length) return [];
    const has = (id: string | null | undefined): id is string => !!id && Object.prototype.hasOwnProperty.call(pins, id);
    const found = (await this.listedSessions()).filter((s) => has(s.sessionId));
    const ids = new Set(found.map((s) => s.sessionId));
    // From each tab: a running one, or one restored on reload that isn't loaded yet.
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
    // Every record here passed has(), so its id is a pin's.
    return found.sort((a, b) => pins[a.sessionId as string] - pins[b.sessionId as string]);
  }
  // Drop a session into the pinned list: reorder it if it is already pinned, or pin it
  // (a drag from Recent).
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
  // A new session in a new tab. `opts`: backendOverride (a menu's or a link's pick),
  // notePath (the note it was started from, which it writes its resume link back to),
  // folderPath (the folder it was started from), daily (today's chat), forkFrom
  // ({ id, backend, cwd }: a side chat, a fork of that session), and sideSession and
  // handoff* (a side chat that reads another session's transcript note instead).
  async startSession(this: AgentManagerPlugin, subject: string, sourceView: LaunchSource, opts: LaunchOptions | null = null): Promise<Session | null> {
    // A starting folder that's gone stops every launch, rather than start at the root of
    // a vault someone chose to keep agents out of.
    if (this.startFolderMissing()) {
      new import_obsidian.Notice(`Agent Manager: the AGENTS.md folder “${stringOf(this.pluginData.startFolder)}” isn't in this vault anymore, so no session was started. Choose another in Settings → Agent Manager.`, 10000);
      return null;
    }
    // The launching browser's backend pick drives the new session; a menu's or a link's
    // pick wins over it; with neither, the view uses the default.
    // Only the sidebar has a pick; a session tab reads undefined here.
    const lb = (sourceView as { _launchBackend?: unknown } | null | undefined)?._launchBackend;
    const offered = this.getBrowserBackends();
    const fallback = offered.includes(this.getCurrentBackend()) ? this.getCurrentBackend() : offered[0];
    const launchBackend = (opts?.backendOverride && isBackendKey(opts.backendOverride)) ? opts.backendOverride
      : (lb && isBackendKey(lb) ? lb : fallback);
    const prepare = (v: Session) => {
      if (launchBackend) v.backendKey = launchBackend;
      // A note launch carries the note's path, so the session can write its link back
      // once its id resolves (maybeWriteNoteBack).
      v._notePath = opts?.notePath || null;
      v._folderPath = opts?.folderPath || null;
      this.resetNoteWriteback(v);
      v._handoffNote = opts?.handoffNote || null;
      v._handoffFromBackend = opts?.handoffFromBackend || null;
      v._handoffIntent = opts?.handoffIntent || null;
      v._daily = !!opts?.daily;
      v._forkFrom = opts?.forkFrom || null;
      // A side chat never takes over its note's link; a launch from the note does.
      v._noteSupport = !!opts?.sideSession;
      v._noteClaim = !!opts?.notePath && !opts?.sideSession;
      // Which launch from a note is the latest decides who holds its link, whichever
      // learns its id first (newerLaunchFrom), even after the latest one's tab closes.
      v._noteLaunchAt = v._noteClaim ? Date.now() : null;
      // A claim means a notePath (just above).
      if (v._noteClaim) (this._noteLaunches || (this._noteLaunches = new Map<string, number | null>())).set(opts?.notePath as string, v._noteLaunchAt);
    };
    this.invalidateSessionIndex();
    const view = await this.openSessionLeaf("tab");
    if (!view) return null;
    prepare(view);
    view.launchSession(subject);
    return view;
  }
  // ---- Today's chat ----
  // Today's chat's tab, loaded or not, or null: a session tab named for today.
  todaysChatLeaf(this: AgentManagerPlugin): WorkspaceLeaf | null {
    const name = this.dailyChatName();
    for (const leaf of this.sessionLeaves()) {
      const v = this.sessionOf(leaf);
      const title = v ? v.sessionTitle : this.savedSessionState(leaf)?.sessionTitle;
      if (title === name) return leaf;
    }
    return null;
  }
  // The note a session was started from, by the `source` its transcript note records,
  // or null.
  sourceNoteOf(this: AgentManagerPlugin, sessionId: string | null | undefined): string | null {
    const t = this.findTranscriptNoteBySessionId(sessionId);
    const src: unknown = t && this.app.metadataCache.getFileCache(t)?.frontmatter?.source;
    const m = typeof src === "string" ? src.match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/) : null;
    // A match means t was found (its frontmatter gave src), so `t &&` changes nothing.
    const note = m && t && this.app.metadataCache.getFirstLinkpathDest(m[1], t.path);
    return note instanceof import_obsidian.TFile ? note.path : null;
  }
  // Go to today's chat: its tab, else resume it (the newest session by that name), else
  // start it on the default CLI. Never a second one.
  async openTodaysChat(this: AgentManagerPlugin, sourceView: LaunchSource = null): Promise<void> {
    if (this._openingToday) return;
    this._openingToday = true;
    try {
      const leaf = this.todaysChatLeaf();
      if (leaf) {
        void this.app.workspace.revealLeaf(leaf);
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        return;
      }
      const name = this.dailyChatName();
      let sessions: SessionRecord[] = [];
      try { sessions = await this.listedSessions(); } catch { /* best effort */ }
      const earlier = sessions.find((s) => s.displayName === name);
      if (earlier) { await this.startResume(earlier, sourceView); return; }
      const offered = this.getBrowserBackends();
      const backend = offered.includes(this.getCurrentBackend()) ? this.getCurrentBackend() : offered[0];
      await this.startSession(name, null, { backendOverride: backend, daily: true });
    } finally {
      this._openingToday = false;
    }
  }
  // Does this session's working directory still exist? A repo that moved or was
  // deleted can't host a resume.
  placeMissing(this: AgentManagerPlugin, session: { cwd: string | null } | null | undefined): boolean {
    if (!session || !session.cwd) return false;
    try { return !fs.statSync(session.cwd).isDirectory(); } catch { return true; }
  }
  async startResume(this: AgentManagerPlugin, session: SessionRecord, sourceView: LaunchSource): Promise<void> {
    if (this.placeMissing(session)) {
      const note = this.findTranscriptNoteBySessionId(session.sessionId);
      new import_obsidian.Notice(`Agent Manager: that session ran in ${session.cwd}, which is not on this machine.${note ? " Opening its transcript." : ""}`, 8000);
      if (note) await this.app.workspace.getLeaf("tab").openFile(note);
      return;
    }
    // One resume at a time per session: a double-click on a row would otherwise open a
    // second tab before the first has its title, and two tabs would write one session.
    const key = `${session.backend}\n${session.sessionId || session.title}`;
    this._resuming = this._resuming || new Set();
    if (this._resuming.has(key)) return;
    this._resuming.add(key);
    try {
      const view = await this.openSessionLeaf("tab");
      if (!view) return;
      view.resumeSession(session);
    } finally {
      // Released once the tab has the session's title, when a row's click finds the tab
      // itself; held any longer, a click after closing that tab would do nothing.
      this._resuming.delete(key);
    }
  }
}
export { SessionMethods };
