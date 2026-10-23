// Session identity: which transcript a tab is, restoring it, repointing after a re-host or a continuation, and lineage.

import { fs, import_obsidian, path } from "../externals.js";
import { stringOf } from "../util/guards.js";
import { lastMessageTsOf, readFileHead, readFileTail } from "../sessions/transcript-files.js";
import type { TranscriptLine } from "../sessions/transcript-files.js";
import type { Session } from "./controller.js";
import type { IndexRecord, SessionRecord, TranscriptMessage } from "../types.js";
// A `continued-in` record: where a session went on, and when.
interface ContinuedIn {
  id: string;
  ts: number;
}
// A transcript line, as the continued-in reader checks it.
type ContinuedLine = TranscriptLine & { continuedInSessionId?: unknown };
class IdentityMethods {
  // Every field that ties this view to ONE transcript, cleared at each launch and resume,
  // so a reused view never carries the previous session's file or the caches the
  // detector and the transcript writer keep per file.
  _resetSessionIdentity(this: Session): void {
    this._modelFile = null;
    this._durableReconciledSize = undefined;
    this._durableCaughtUp = false;
    this._durableMisses = 0;
    this._durableRetryAt = 0;
    this._forkScanDirMtime = undefined;
    this._modelRefreshedAt = 0;
    this._rehostedFrom = null;
    this._claimedResumeId = null;
    this._firstTextsOwn = null;
    this.plugin.resetNoteWriteback(this);
  }
  // The id this view is bound to right now: the resumed (or followed) id, else the id the
  // plugin minted for a fresh Claude launch. Null only for a fresh Codex or Antigravity
  // launch before its first turn.
  _ownSessionId(this: Session): string | null {
    return this.resumeSessionId || this.launchSessionId || null;
  }
  // Reload restore: find the persisted session's record and resume it, so a reloaded
  // tab comes back as the same session. The tab closes, with a notice, when the
  // record can't be found or another tab already has it.
  async restoreResumeFromState(this: Session): Promise<void> {
    if (this._restoring) return;
    this._restoring = true;
    const title = this._pendingResumeTitle;
    this._pendingResumeTitle = null;
    const backend = this.backendKey || this.getBackendKey();
    const savedId = this._pendingResumeId;
    this._pendingResumeId = null;
    // Set inside the queued pick below: typed here, since TypeScript reads it as null.
    let session = null as SessionRecord | null;
    // Restores run one at a time: the pick reads other tabs' claims, and two tabs
    // restoring at once would both pick the same record before either had claimed it.
    const prev = this.plugin._restoreQueue || Promise.resolve();
    const mine = prev.then(async () => {
      try {
        session = this._pickRestoreRecord(await this.plugin.sessionIndex(), backend, title, savedId);
        // The index covers the vault. A session anywhere else is looked up by its id.
        if (!session && savedId && this._restoreReason === "gone") {
          const found = await this.plugin.findSessionById(savedId);
          if (found && found.backend === backend) session = this._pickRestoreRecord([found], backend, title, savedId);
        }
        if (session && session.sessionId) this._claimedResumeId = session.sessionId; // claimed before the next tab picks
      } catch { /* best effort */ }
    });
    this.plugin._restoreQueue = mine.catch(() => {});
    await mine;
    if (session && session.sessionId && !this.plugin.placeMissing(session)) {
      // A restore that picked the conversation's continuation under a new id: its agent
      // records come along before the resume reads them.
      if (savedId && this.plugin.carrySessionAgent(savedId, session.sessionId)) void this.plugin.savePluginData();
      this.resumeSession(session);
    } else if (!session && this._restoreReason === "gone" && !this._started && !this._forkFrom) {
      // Never took a turn, so the CLI has nothing to resume (a Claude session writes
      // its transcript only with its first message): start it afresh, same name, and
      // for Claude the same id.
      this.launchSession(title, this.backendKey === "claude" ? savedId : null);
    } else if (this.restoreFailed) {
      // A session tab stays open and says why; Agent Manager never closes a tab itself.
      this.restoreFailed(
        session ? `“${title}” ran in ${session.cwd}, which is not on this machine, so it can't be resumed here.`
        : this._restoreReason === "claimed" ? `“${title}” is already open in another tab, so this one wasn't restored (two tabs on one session would both write it).`
        : `No transcript found for “${title}” (it never took a turn, or the CLI deleted it), so there's nothing to resume.`);
    } else {
      if (title) new import_obsidian.Notice(
        session ? `Agent Manager: "${title}" ran in ${session.cwd}, which is not on this machine; closing the tab.`
        : this._restoreReason === "claimed" ? `Agent Manager: "${title}" is already open in another tab; closing the duplicate.`
        : `Agent Manager: no transcript found for "${title}" (it never took a turn, or the CLI deleted it); closing the tab.`, 6000);
      this.leaf?.detach();
    }
    this._restoring = false;
  }
  // Which record a restored tab resumes. Resolving by title alone would send two tabs
  // that share a title (a compaction continuation beside its parent) to one background
  // agent, painting one PTY at two sizes. So: (1) a tab that saved its
  // id comes back to that id, following a `continued-in` pointer only when the old file
  // went quiet at the pointer (no real message after it), so a branch that was resumed and
  // kept working stays its own tab; (2) an id another tab has already claimed in this
  // restore pass is skipped, falling back to the newest unclaimed same-title record; (3)
  // nothing unclaimed means the tab is a duplicate and is closed with a Notice.
  _pickRestoreRecord(this: Session, sessions: SessionRecord[], backend: string, title: string | null | undefined, savedId: string | null | undefined): SessionRecord | null {
    // Every id another open tab is bound to: the id it claimed at restore, the id it is on
    // now (a followed re-host or continuation moves it), the id it minted at launch, and
    // the target of its recorded re-host.
    const claimed = new Set<string | null>();
    for (const v of this.plugin.sessionObjects()) {
      if (!v || v === this) continue;
      for (const id of [v._claimedResumeId, v.resumeSessionId, v.launchSessionId, v._rehostedFrom && v._rehostedFrom.to]) if (id) claimed.add(id);
    }
    const byId = (id: string | null | undefined): SessionRecord | null => sessions.find((s) => s.backend === backend && s.sessionId === id) || null;
    this._restoreReason = null;
    if (savedId) {
      // A saved id is authoritative: this tab was that session. Follow a continued-in pointer
      // only while the old file went quiet at it; then either that branch is free, or it is
      // claimed (a duplicate tab), or it is gone (never took a turn, or GC'd). Never fall
      // back to a title match here: that is how a tab resumed an OLDER same-title session.
      let rec = byId(savedId);
      if (!rec) { this._restoreReason = "gone"; return null; }
      const seen = new Set([rec.sessionId]);
      for (let i = 0; i < 8 && rec.file; i++) {
        const ptr = this._continuedInRecords(rec.file).pop();
        if (!ptr) break;
        let lastTs = 0; try { lastTs = this._lastMessageTs(rec.file); } catch { /* best effort */ }
        if (ptr.ts && lastTs > ptr.ts + 5000) break; // the old file kept talking after the pointer: a live branch
        const next = byId(ptr.id);
        if (!next || seen.has(next.sessionId)) break;
        seen.add(next.sessionId);
        rec = next;
      }
      if (claimed.has(rec.sessionId)) { this._restoreReason = "claimed"; return null; }
      return rec;
    }
    // No saved id (a Codex or Antigravity launch whose id hadn't resolved): the record
    // whose head holds its launch token, else nothing, never another same-title session.
    if (this._launchToken) {
      const marker = `(launch ${this._launchToken})`;
      const mine = sessions.find((s) => {
        if (s.backend !== backend || !s.file || claimed.has(s.sessionId)) return false;
        try { return readFileHead(s.file, 262144).includes(marker); } catch { return false; }
      });
      if (!mine) this._restoreReason = "gone";
      return mine || null;
    }
    // A side chat that never learned its id: its fork can't be told from another.
    if (this._forkFrom) { this._restoreReason = "gone"; return null; }
    // No token either: the newest unclaimed same-title record.
    const rec = this._newestSameTitleRecord(sessions, backend, title, claimed);
    if (!rec) this._restoreReason = sessions.some((s) => s.backend === backend && s.title === title) ? "claimed" : "gone";
    return rec;
  }
  // The `continued-in` records in a transcript, oldest first: { id, ts }. Claude writes
  // one ({ continuedInSessionId }) when it compacts a session's context and carries on
  // under a new id, and for a Remote Control re-host too. Read from the tail (256KB)
  // by default, since little normally follows the record in the old file; `whole`
  // reads the file through, for a branch that kept working long after. Each line is
  // parsed and its type checked, so conversation text naming the record can't count.
  _continuedInRecords(file: string, whole = false): ContinuedIn[] {
    const out: ContinuedIn[] = [];
    let raw = "";
    try { raw = whole ? fs.readFileSync(file, "utf8") : readFileTail(file, 262144); } catch { return out; }
    for (const line of raw.split("\n")) {
      if (line.indexOf("continued-in") === -1) continue;
      try {
        // A line of `null` throws on its first field, inside this try, as it always has.
        const o = JSON.parse(line) as ContinuedLine;
        if (o.type === "continued-in" && typeof o.continuedInSessionId === "string") out.push({ id: o.continuedInSessionId, ts: o.timestamp ? Date.parse(stringOf(o.timestamp)) || 0 : 0 });
      } catch { /* best effort */ }
    }
    return out;
  }
  _continuedInIds(file: string, whole = false): Set<string> {
    return new Set(this._continuedInRecords(file, whole).map((r) => r.id));
  }
  // Do two transcripts open with the same two user messages? A re-host replays the
  // history, so it does. One shared message proves nothing: launches from one note open
  // with the same instruction.
  _replays(this: Session, fileA: string, fileB: string): boolean {
    const a = this._firstUserTexts(fileA, 2);
    if (a.length < 2) return false;
    const b = this._firstUserTexts(fileB, 2);
    return b.length >= 2 && a[0] === b[0] && a[1] === b[1];
  }
  // Bind this view to another session id and file, and reset what was kept per file,
  // so capture, the model badge, and the note write-back all start again on it.
  _repointTo(this: Session, sessionId: string, file: string): void {
    // A rename belongs to the conversation, not the id: the new id takes the old one's,
    // unless it has its own.
    const oldId = this._ownSessionId();
    const d = this.plugin.pluginData;
    let carried = false;
    if (oldId && d.sessionNames && oldId in d.sessionNames && !(sessionId in d.sessionNames)) { d.sessionNames[sessionId] = d.sessionNames[oldId]; carried = true; }
    // So does its agent.
    if (this.plugin.carrySessionAgent(oldId, sessionId)) carried = true;
    // A pin moves to the new id outright, keeping its place, so home doesn't keep a row
    // for the old twin beside the live one.
    if (oldId && oldId !== sessionId) {
      const pins = d.pinnedSessions;
      if (pins && oldId in pins) {
        if (!(sessionId in pins)) pins[sessionId] = pins[oldId];
        delete pins[oldId];
        carried = true;
      }
    }
    if (carried) { void this.plugin.savePluginData(); this.plugin.invalidateSessionIndex(); }
    // The id this tab had, so the note write-back still knows the link as its own.
    if (oldId && oldId !== sessionId) (this._notePriorIds = this._notePriorIds || new Set()).add(String(oldId));
    this.resumeSessionId = sessionId;
    this.refreshStripId();
    this._modelFile = file;
    this._durableCaughtUp = false;
    this._durableReconciledSize = undefined;
    this._modelRefreshedAt = 0;
    this.plugin.resetNoteWriteback(this);
    // The new id is saved with the tab, so a reload comes back to it.
    this.app.workspace.requestSaveLayout();
  }
  // Which same-title record a reload should resume. A Remote
  // Control bridge re-host is a same-title sibling under a NEW id, so a title can name
  // two branches; taking the first record (store order, i.e. mtime) followed
  // whichever file was touched last, and bridge checkpoints bump mtime without any
  // conversation. Pick the branch with the newest last MESSAGE
  // instead: the re-host when remote work continued there, this session's own id when
  // the re-host is a stale twin. attach-first (startShell) then reconnects if that branch
  // is a live agent, else -r resumes it. Non-Claude records have no per-message
  // timestamps (_lastMessageTs reads 0 for all), so they keep the old first-record
  // pick; an unreadable file counts as 0 too. Returns null when nothing matches.
  _newestSameTitleRecord(this: Session, sessions: SessionRecord[], backend: string, title: string | null | undefined, exclude: Set<string | null> | null = null): SessionRecord | null {
    let best: SessionRecord | null = null, bestTs = -1;
    for (const s of sessions) {
      if (s.backend !== backend || s.title !== title) continue;
      if (exclude && exclude.has(s.sessionId)) continue;
      let ts = 0;
      if (s.file) { try { ts = this._lastMessageTs(s.file); } catch { ts = 0; } }
      if (ts > bestTs) { best = s; bestTs = ts; }
    }
    return best;
  }
  // This session's stable id, for the rename override key: the resume id, or derived
  // from the live transcript (a just-launched session has neither until its first turn).
  async _liveSessionId(this: Session): Promise<string | null> {
    const own = this._ownSessionId();
    if (own) return own;
    try {
      const cur = await this._transcriptFile();
      return cur ? this.plugin._tc().deriveSessionId(cur, this.getBackendKey()) || null : null;
    } catch { return null; }
  }
  // ---- Following a session to a new id ----
  // A running Claude session can move to a new id two ways. Remote Control can re-host a
  // published session as a background agent under a new id, replaying the history into a
  // new transcript file; and a compaction can continue a session in a new file, writing
  // a `continued-in` record naming the new id into the old one. Either way the tab must
  // follow, or the transcript note, the model badge, and the note write-back keep
  // reading a file that has stopped growing. The proof of lineage is the pointer, or the
  // first two user messages replayed; the direction is whichever side has the later
  // last message. Runs on the poll's working-to-idle edge; the cheap path (a cached
  // title scan) finds nothing almost always.
  async _detectRehostedSession(this: Session): Promise<boolean> {
    // Claude only: the direction check reads Claude's message timestamps, so for Codex
    // and Antigravity a candidate could never pass, and the scan would be wasted.
    if (!this.sessionTitle || this.getBackendKey() !== "claude") return false;
    const cur = await this._transcriptFile();
    if (!cur) return false;
    const backend = this.getBackendKey();
    const curId = this._ownSessionId() || this.plugin._tc().deriveSessionId(cur, backend);
    // Cheap gate: a re-host always CREATES a new transcript file in this session's store,
    // which bumps the store directory's mtime; appends to existing files (turns, bridge
    // checkpoints) don't. Skip the scan when the dir is unchanged since a scan that found
    // NO same-title sibling. The baseline is set ONLY in that no-sibling case: set after
    // every scan, one scan that saw the re-host but couldn't confirm it yet (a bridge
    // checkpoint can make the old file momentarily "newer") would lock detection out for
    // good. With a sibling present it re-scans every edge (rare, and cheap).
    let dirMtime: number;
    try { dirMtime = fs.statSync(path.dirname(cur)).mtimeMs; } catch { return false; }
    if (this._forkScanDirMtime === dirMtime) return false;
    // A re-host or continuation lands in the same store folder as this session's file.
    const store = path.dirname(cur);
    let recs: IndexRecord[] = [];
    // The index lists store records (plugin/sessions.ts), each with its id and its file.
    try { this.plugin.invalidateSessionIndex(); recs = await this.plugin.sessionIndex() as IndexRecord[]; } catch { return false; }
    // A sibling matches on the title this tab shows, or on the raw title this session was
    // launched with: a rename is keyed by the old id, so the new id doesn't carry it
    // until the repoint below. Lineage is proved separately either way.
    // A candidate is a file our own points at (whatever it's called: a compaction may
    // write no title into it, and a rename is keyed by our id until the repoint), or one
    // with our name, which a replay then has to prove.
    const continuedIds = this._continuedInIds(cur);
    const ownRaw = recs.find((r) => r.sessionId === curId)?.rawTitle;
    // A side chat replays its source's history and can share a name with another side
    // chat, so one the plugin made counts only when a pointer names it.
    const sideChats = this.plugin.pluginData.sideChats || {};
    const siblings = recs.filter((r) => r.backend === backend && r.sessionId !== curId && r.file && (backend !== "claude" || path.dirname(r.file) === store)
      && (continuedIds.has(r.sessionId) || (!Object.prototype.hasOwnProperty.call(sideChats, r.sessionId) && (r.title === this.sessionTitle || (ownRaw && r.rawTitle === ownRaw)))));
    if (!siblings.length) { this._forkScanDirMtime = dirMtime; return false; }
    // Direction comes from the LAST REAL MESSAGE timestamp, not the file mtime: the old
    // file keeps receiving bridge checkpoints (not messages), so mtime can't say which
    // side is the continuation. The kind comes from the candidate's own head: Claude
    // writes a continued-in pointer for a bridge re-host too, so the pointer alone doesn't
    // say which; a compaction continuation starts from the compaction summary.
    const curTs = this._lastMessageTs(cur);
    for (const cand of siblings.sort((a, b) => b.mtime - a.mtime)) {
      if (!continuedIds.has(cand.sessionId) && !this._replays(cur, cand.file)) continue;
      let kind: "rehost" | "continued" = "rehost";
      try { if (this.plugin._tc().isCompactionContinuation(readFileHead(cand.file, 65536))) kind = "continued"; } catch { /* best effort */ }
      if (!(this._lastMessageTs(cand.file) > curTs)) continue; // shares lineage but isn't the continuation
      // A re-host or continuation of this session that kept going: follow it.
      this._repointTo(cand.sessionId, cand.file);
      // Shown on the strip as a pill that survives a reload, and said once.
      this._rehostedFrom = { from: String(curId), to: String(cand.sessionId), at: Date.now(), kind };
      this._showRehostPill();
      new import_obsidian.Notice(kind === "continued"
        ? `Agent Manager: Claude compacted “${this.sessionTitle}” and carried on as a new session (${String(curId).slice(0, 8)} → ${String(cand.sessionId).slice(0, 8)}). This tab followed it, and its transcript note now grows from the new session.`
        : `Agent Manager: Remote Control moved “${this.sessionTitle}” to a new session id (${String(curId).slice(0, 8)} → ${String(cand.sessionId).slice(0, 8)}). This tab followed it, and its transcript note now grows from the new session.`, 12000);
      return true;
    }
    return false;
  }
  // Timestamp (ms) of the last real user/assistant record in a transcript, read from
  // the tail. Bridge checkpoints and cost records are skipped, which is the whole point:
  // they touch the file's mtime without being conversation.
  _lastMessageTs(file: string): number {
    return lastMessageTsOf(file);
  }
  // First n user-message texts of a transcript, from its head (a re-host replays the
  // original messages at the top, so the head is enough for the signature check).
  _firstUserTexts(this: Session, file: string, n: number): string[] {
    // Cached per file once n texts exist: transcripts are append-only, so a file's first
    // messages never change, and with a same-title sibling present the detector would
    // otherwise read a 256KB head per file on every completed turn.
    const cache = this.plugin._firstTextsCache || (this.plugin._firstTextsCache = new Map<string, string[]>());
    const hit = cache.get(file);
    if (hit && hit.length >= n) return hit.slice(0, n);
    const out: string[] = [];
    let raw = "";
    try { raw = readFileHead(file, 262144); } catch { return out; }
    const tc = this.plugin._tc();
    const backend = this.getBackendKey();
    for (const line of raw.split("\n")) {
      if (out.length >= n) break;
      let rec: TranscriptMessage | null = null;
      try { rec = tc.parseTranscriptRecord(line, backend); } catch { continue; }
      if (rec && rec.role === "user" && rec.text) out.push(String(rec.text).slice(0, 200));
    }
    if (out.length >= n) {
      if (cache.size > 2048) cache.clear();
      cache.set(file, out);
    }
    return out;
  }
}
export { IdentityMethods };
