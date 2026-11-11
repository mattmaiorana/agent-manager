
import { fs, path } from "../externals.js";
import { stringOf } from "../util/guards.js";
import { lastMessageTsOf, readFileHead, readFileTail } from "../sessions/transcript-files.js";
import type { TranscriptLine } from "../sessions/transcript-files.js";
import type { Session } from "./controller.js";
import type { IndexRecord, SessionRecord, TranscriptMessage } from "../types.js";
import { notice } from "../vault-terminal/notice";
interface ContinuedIn {
  id: string;
  ts: number;
}
type ContinuedLine = TranscriptLine & { continuedInSessionId?: unknown };
class IdentityMethods {
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
  _ownSessionId(this: Session): string | null {
    return this.resumeSessionId || this.launchSessionId || null;
  }
  async restoreResumeFromState(this: Session): Promise<void> {
    if (this._restoring) return;
    this._restoring = true;
    const title = this._pendingResumeTitle;
    this._pendingResumeTitle = null;
    const backend = this.backendKey || this.getBackendKey();
    const savedId = this._pendingResumeId;
    this._pendingResumeId = null;
    let session = null as SessionRecord | null;
    const prev = this.plugin._restoreQueue || Promise.resolve();
    const mine = prev.then(async () => {
      try {
        session = this._pickRestoreRecord(await this.plugin.sessionIndex(), backend, title, savedId);
        if (!session && savedId && this._restoreReason === "gone") {
          const found = await this.plugin.findSessionById(savedId);
          if (found && found.backend === backend) session = this._pickRestoreRecord([found], backend, title, savedId);
        }
        if (session && session.sessionId) this._claimedResumeId = session.sessionId;
      } catch { /* empty */ }
    });
    this.plugin._restoreQueue = mine.catch(() => {});
    await mine;
    if (session && session.sessionId && !this.plugin.placeMissing(session)) {
      if (savedId && this.plugin.carrySessionAgent(savedId, session.sessionId)) void this.plugin.savePluginData();
      this.resumeSession(session);
    } else if (!session && this._restoreReason === "gone" && !this._started && !this._forkFrom) {
      this.launchSession(title, this.backendKey === "claude" ? savedId : null);
    } else if (this.restoreFailed) {
      this.restoreFailed(
        session ? `“${title}” ran in ${session.cwd}, which is not on this machine, so it can't be resumed here.`
        : this._restoreReason === "claimed" ? `“${title}” is already open in another tab, so this one wasn't restored (two tabs on one session would both write it).`
        : `No transcript found for “${title}” (it never took a turn, or the CLI deleted it), so there's nothing to resume.`);
    } else {
      const why = !title ? ""
        : session ? `Agent Manager: "${title}" ran in ${session.cwd}, which is not on this machine; closing the tab.`
        : this._restoreReason === "claimed" ? `Agent Manager: "${title}" is already open in another tab; closing the duplicate.`
        : `Agent Manager: no transcript found for "${title}" (it never took a turn, or the CLI deleted it); closing the tab.`;
      this.leaf?.detach();
      if (why) notice(why);
    }
    this._restoring = false;
  }
  _pickRestoreRecord(this: Session, sessions: SessionRecord[], backend: string, title: string | null | undefined, savedId: string | null | undefined): SessionRecord | null {
    const claimed = new Set<string | null>();
    for (const v of this.plugin.sessionObjects()) {
      if (!v || v === this) continue;
      for (const id of [v._claimedResumeId, v.resumeSessionId, v.launchSessionId, v._rehostedFrom && v._rehostedFrom.to]) if (id) claimed.add(id);
    }
    const byId = (id: string | null | undefined): SessionRecord | null => sessions.find((s) => s.backend === backend && s.sessionId === id) || null;
    this._restoreReason = null;
    if (savedId) {
      let rec = byId(savedId);
      if (!rec) { this._restoreReason = "gone"; return null; }
      const seen = new Set([rec.sessionId]);
      for (let i = 0; i < 8 && rec.file; i++) {
        const ptr = this._continuedInRecords(rec.file).pop();
        if (!ptr) break;
        let lastTs = 0; try { lastTs = this._lastMessageTs(rec.file); } catch { /* empty */ }
        if (ptr.ts && lastTs > ptr.ts + 5000) break;
        const next = byId(ptr.id);
        if (!next || seen.has(next.sessionId)) break;
        seen.add(next.sessionId);
        rec = next;
      }
      if (claimed.has(rec.sessionId)) { this._restoreReason = "claimed"; return null; }
      return rec;
    }
    if (this._launchToken) {
      const marker = `(launch ${this._launchToken})`;
      const mine = sessions.find((s) => {
        if (s.backend !== backend || !s.file || claimed.has(s.sessionId)) return false;
        try { return readFileHead(s.file, 262144).includes(marker); } catch { return false; }
      });
      if (!mine) this._restoreReason = "gone";
      return mine || null;
    }
    if (this._forkFrom) { this._restoreReason = "gone"; return null; }
    const rec = this._newestSameTitleRecord(sessions, backend, title, claimed);
    if (!rec) this._restoreReason = sessions.some((s) => s.backend === backend && s.title === title) ? "claimed" : "gone";
    return rec;
  }
  _continuedInRecords(file: string, whole = false): ContinuedIn[] {
    const out: ContinuedIn[] = [];
    let raw = "";
    try { raw = whole ? fs.readFileSync(file, "utf8") : readFileTail(file, 262144); } catch { return out; }
    for (const line of raw.split("\n")) {
      if (line.indexOf("continued-in") === -1) continue;
      try {
        const o = JSON.parse(line) as ContinuedLine;
        if (o.type === "continued-in" && typeof o.continuedInSessionId === "string") out.push({ id: o.continuedInSessionId, ts: o.timestamp ? Date.parse(stringOf(o.timestamp)) || 0 : 0 });
      } catch { /* empty */ }
    }
    return out;
  }
  _continuedInIds(file: string, whole = false): Set<string> {
    return new Set(this._continuedInRecords(file, whole).map((r) => r.id));
  }
  _replays(this: Session, fileA: string, fileB: string): boolean {
    const a = this._firstUserTexts(fileA, 2);
    if (a.length < 2) return false;
    const b = this._firstUserTexts(fileB, 2);
    return b.length >= 2 && a[0] === b[0] && a[1] === b[1];
  }
  _repointTo(this: Session, sessionId: string, file: string): void {
    this._setRc("unknown");
    const oldId = this._ownSessionId();
    const d = this.plugin.pluginData;
    let carried = false;
    if (oldId && d.sessionNames && oldId in d.sessionNames && !(sessionId in d.sessionNames)) { d.sessionNames[sessionId] = d.sessionNames[oldId]; carried = true; }
    if (this.plugin.carrySessionAgent(oldId, sessionId)) carried = true;
    if (oldId && oldId !== sessionId) {
      const pins = d.pinnedSessions;
      if (pins && oldId in pins) {
        if (!(sessionId in pins)) pins[sessionId] = pins[oldId];
        delete pins[oldId];
        carried = true;
      }
    }
    if (carried) { void this.plugin.savePluginData(); this.plugin.invalidateSessionIndex(); }
    if (oldId && oldId !== sessionId) (this._notePriorIds = this._notePriorIds || new Set()).add(String(oldId));
    this.resumeSessionId = sessionId;
    this.refreshStripId();
    this._modelFile = file;
    this._durableCaughtUp = false;
    this._durableReconciledSize = undefined;
    this._modelRefreshedAt = 0;
    this.plugin.resetNoteWriteback(this);
    this.app.workspace.requestSaveLayout();
    void this._scanTickets?.();
  }
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
  async _liveSessionId(this: Session): Promise<string | null> {
    const own = this._ownSessionId();
    if (own) return own;
    try {
      const cur = await this._transcriptFile();
      return cur ? this.plugin._tc().deriveSessionId(cur, this.getBackendKey()) || null : null;
    } catch { return null; }
  }
  async _detectRehostedSession(this: Session): Promise<boolean> {
    if (!this.sessionTitle || this.getBackendKey() !== "claude") return false;
    const cur = await this._transcriptFile();
    if (!cur) return false;
    const backend = this.getBackendKey();
    const curId = this._ownSessionId() || this.plugin._tc().deriveSessionId(cur, backend);
    let dirMtime: number;
    try { dirMtime = fs.statSync(path.dirname(cur)).mtimeMs; } catch { return false; }
    if (this._forkScanDirMtime === dirMtime) return false;
    const store = path.dirname(cur);
    let recs: IndexRecord[] = [];
    try { this.plugin.invalidateSessionIndex(); recs = await this.plugin.sessionIndex() as IndexRecord[]; } catch { return false; }
    const continuedIds = this._continuedInIds(cur);
    const ownRaw = recs.find((r) => r.sessionId === curId)?.rawTitle;
    const sideChats = this.plugin.pluginData.sideChats || {};
    const siblings = recs.filter((r) => r.backend === backend && r.sessionId !== curId && r.file && (backend !== "claude" || path.dirname(r.file) === store)
      && (continuedIds.has(r.sessionId) || (!Object.prototype.hasOwnProperty.call(sideChats, r.sessionId) && (r.title === this.sessionTitle || (ownRaw && r.rawTitle === ownRaw)))));
    if (!siblings.length) { this._forkScanDirMtime = dirMtime; return false; }
    const curTs = this._lastMessageTs(cur);
    for (const cand of siblings.sort((a, b) => b.mtime - a.mtime)) {
      if (!continuedIds.has(cand.sessionId) && !this._replays(cur, cand.file)) continue;
      let kind: "rehost" | "continued" = "rehost";
      try { if (this.plugin._tc().isCompactionContinuation(readFileHead(cand.file, 65536))) kind = "continued"; } catch { /* empty */ }
      if (!(this._lastMessageTs(cand.file) > curTs)) continue;
      this._repointTo(cand.sessionId, cand.file);
      this._rehostedFrom = { from: String(curId), to: String(cand.sessionId), at: Date.now(), kind };
      this._showRehostPill();
      this.plugin.notify(this.sessionTitle || "A session",
        `${kind === "continued" ? "Claude compacted it and carried on as a new session" : "Remote Control moved it to a new session id"} (${String(curId).slice(0, 8)} → ${String(cand.sessionId).slice(0, 8)}). Its tab and transcript note followed.`,
        () => this.view.bringForward(), this.view?.noticeKey, "info");
      return true;
    }
    return false;
  }
  _lastMessageTs(file: string): number {
    return lastMessageTsOf(file);
  }
  _firstUserTexts(this: Session, file: string, n: number): string[] {
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
