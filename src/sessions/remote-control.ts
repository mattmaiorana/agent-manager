// The Remote Control dot on a Claude session's strip: whether claude.ai can reach this
// session, as Claude's own hooks see it. Claude sets CLAUDE_CODE_BRIDGE_SESSION_ID in a
// hook's environment while the session is connected and removes it when it isn't; the
// hooks the terminal passes report it (vault-terminal/claude.ts), so the dot is as fresh
// as the last hook, and an idle session's disconnect shows on its next turn. The plugin
// never connects a session on its own: Claude's setting does, and a click on the dot
// types /remote-control only because the user asked.
import { fs, import_obsidian, os, path } from "../externals.js";
import { INPUT_GUARD_NOTICE_MS, RC_PANEL_RE } from "./constants.js";
import type { Session } from "./controller.js";

// Unknown until a hook says: a start, an attach client (its hooks run in the background
// agent, whose terminal isn't this one), or a Claude too old to report.
type RcState = "on" | "off" | "unknown";

const RC_COMMAND = "/remote-control";

class RemoteControlMethods {
  // A hook's report (vault-terminal/host.ts). SessionStart can run before the connection
  // is made, so an empty id from it says nothing; a turn's empty id means not connected.
  bridge(this: Session, id: string, atStart: boolean): void {
    if (this.getBackendKey() !== "claude") return;
    // A read of Claude's record that began before this report is out of date (_rcRead).
    this._rcSeq++;
    if (id) this._setRc("on", id);
    else if (!atStart) this._setRc("off");
  }
  _setRc(this: Session, state: RcState, id = ""): void {
    if (this._rc === state && this._rcId === id) return;
    this._rc = state;
    this._rcId = id;
    this._syncRcDot();
  }
  // The dot, last on the strip: a Claude tab, while the setting is on (on unless false).
  _buildRcDot(this: Session, strip: HTMLElement): void {
    this._rcEl = null;
    if (this.getBackendKey() !== "claude" || this.plugin.pluginData.remoteControlDot === false) return;
    const el = strip.createSpan({ cls: "agent-manager-strip-rc", attr: { role: "button" } });
    el.addEventListener("click", () => { void this.sendRemoteControl(); });
    // Right-click: a menu with Copy link, the session's claude.ai link, known while it's on.
    el.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const url = this._rc === "on" ? this._rcUrl() : "";
      const menu = new import_obsidian.Menu();
      menu.addItem((i) => i.setTitle(url ? "Copy claude.ai link" : "Copy claude.ai link (Remote Control isn't on)").setIcon("link").setDisabled(!url).onClick(() => {
        void navigator.clipboard.writeText(url).then(
          () => { new import_obsidian.Notice("Copied the session's claude.ai link."); },
          () => { new import_obsidian.Notice("Couldn't copy the link."); },
        );
      }));
      menu.showAtMouseEvent(evt);
    });
    this._rcEl = el;
    this._syncRcDot();
  }
  _rcUrl(this: Session): string {
    return this._rcId ? `https://claude.ai/code/${encodeURIComponent(this._rcId)}` : "";
  }
  _syncRcDot(this: Session): void {
    const el = this._rcEl;
    if (!el || !el.isConnected) return;
    const state = this._rc;
    el.toggleClass("is-on", state === "on");
    el.toggleClass("is-off", state === "off");
    el.toggleClass("is-unknown", state === "unknown");
    this._stripTip(el, state === "on"
      ? `Remote Control is on: ${this._rcUrl()}\n\nClick to see Claude's Remote Control panel (types ${RC_COMMAND}); right-click to copy the link.`
      : state === "off"
        ? `Remote Control is off for this session.\n\nClick to connect it (types ${RC_COMMAND}). If it's connected somewhere else, this moves it back here. If it doesn't connect, Claude says why in the session.`
        : `Remote Control: not known yet. Claude reports it at its next turn.\n\nClick to connect it, or if it's connected, to see Claude's panel (types ${RC_COMMAND}).`);
  }
  // Type /remote-control, never over unsent text or into a question the CLI is asking,
  // and one at a time: what the plugin types isn't in the draft tracker, so a second click
  // before the first's Enter would pass the guard. The dot never changes from the reply on
  // screen. Connected, Claude answers with its status panel, left open for the user to
  // read and close.
  async sendRemoteControl(this: Session): Promise<void> {
    if (!this.running) { new import_obsidian.Notice("This session isn't running."); return; }
    if (this.hasPendingInput()) { new import_obsidian.Notice(`Not sent: you have unsent text in the prompt. Clear it, then click the Remote Control dot again.`, INPUT_GUARD_NOTICE_MS); return; }
    if (this._dialogShowing()) { new import_obsidian.Notice("Not sent: the session is asking you something. Answer it, then click the Remote Control dot again.", INPUT_GUARD_NOTICE_MS); return; }
    if (this._rcSending) return;
    this._rcSending = true;
    let sent = false;
    try { sent = await this.submitLine(RC_COMMAND); } finally { this._rcSending = false; }
    if (!sent) return;
    if (this._rc !== "on") void this._rcAfterReconnect();
    void this._rcWatchPanel();
  }
  // The user sent /remote-control (or /rc) themselves (controller.ts, input): a reconnect
  // and the panel are followed as a click's are.
  _rcTyped(this: Session, data: string): void {
    if (this.getBackendKey() !== "claude" || !/\r/.test(data)) return;
    if (!/^\/(?:remote-control|rc)$/.test(this._draft.text().trim())) return;
    if (this._rc !== "on") void this._rcAfterReconnect();
    void this._rcWatchPanel();
  }
  // No hook runs on a disconnect from Claude's panel either, so the dot would stay green
  // until the next turn. While the panel /remote-control opened is showing, look for it to
  // close, then read Claude's record of the session for what was chosen. Only then: a
  // disconnect from claude.ai or the phone shows at the next turn.
  async _rcWatchPanel(this: Session): Promise<void> {
    if (this._rcWatching) return;
    this._rcWatching = true;
    const attempt = this._attempt;
    const live = () => this._attempt === attempt && this.running && !this._closed;
    const panel = () => RC_PANEL_RE.test(this.view.screenTail(this.view.screenRows || 40));
    const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    try {
      // A disconnected session reconnects with no panel, and a panel answered at once can
      // come and go between looks: either way, read the record once the wait is over.
      // Typed while Claude works, the command waits for the turn to end, so wait with it.
      let seen = false;
      const by = Date.now() + 15 * 60 * 1000;
      for (let t = 0; !seen && (t < 10 || (this.programState === "working" && Date.now() < by)); t++) { await wait(300); if (!live()) return; seen = panel(); }
      const end = Date.now() + 15 * 60 * 1000;
      while (seen && panel() && Date.now() < end) { await wait(500); if (!live()) return; }
      if (panel()) return;
      // Claude rewrites its record as the choice takes effect: read twice, keep the later.
      let rec: string | null = null;
      for (const ms of [500, 1000]) {
        await wait(ms);
        if (!live()) return;
        rec = (await this._rcRead(attempt)) ?? rec;
      }
      if (rec === null || !live()) return;
      if (rec) this._setRc("on", rec);
      else this._setRc("off");
    } finally {
      this._rcWatching = false;
    }
  }
  // No hook runs after /remote-control, so a connect from a grey or hollow dot would stay
  // that way until the next turn.
  // Claude's own record of the running session (~/.claude/sessions/<pid>.json, undocumented)
  // has the connection's id the moment it's made (REFERENCE.md): read a few times after the
  // click, and only then. It only ever turns the dot green; a hook decides grey.
  async _rcAfterReconnect(this: Session): Promise<void> {
    const attempt = this._attempt;
    for (const wait of [1000, 1500, 2500]) {
      await new Promise((r) => window.setTimeout(r, wait));
      if (this._attempt !== attempt || !this.running || this._closed || this._rc === "on") return;
      const bridge = await this._rcRead(attempt);
      if (bridge) { this._setRc("on", bridge); return; }
    }
  }
  // Claude's record for this tab's session, as claudeBridgeId reads it; null as well when
  // the read is out of date by the time it's done: the tab restarted, closed, or followed
  // a new id, or a hook reported meanwhile, which is newer.
  async _rcRead(this: Session, attempt: number): Promise<string | null> {
    const id = this._ownSessionId();
    if (!id) return null;
    const seq = this._rcSeq;
    const rec = await claudeBridgeId(id, this._programPid);
    if (this._attempt !== attempt || !this.running || this._closed || this._rcSeq !== seq || this._ownSessionId() !== id) return null;
    return rec;
  }
}
// The claude.ai id Claude records for the running session with this id: "" while it isn't
// connected, null when no record of it can be trusted. The record of the tab's own
// process (its pid) wins; without one (an attach client, whose session runs in Claude's
// background agent), the one record whose process is still alive, since a crashed run
// can leave its record behind and two processes can hold one conversation.
async function claudeBridgeId(sessionId: string, pid: number | null): Promise<string | null> {
  const dir = path.join(os.homedir(), ".claude", "sessions");
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return null; }
  const found: { pid: unknown; bridge: unknown }[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const rec: unknown = JSON.parse(await fs.promises.readFile(path.join(dir, name), "utf8"));
      if (!rec || typeof rec !== "object") continue;
      const r = rec as Record<string, unknown>;
      if (r.sessionId === sessionId) found.push({ pid: r.pid, bridge: r.bridgeSessionId });
    } catch { /* being rewritten, or not one of Claude's */ }
  }
  const alive = (p: unknown) => {
    if (typeof p !== "number" || !Number.isInteger(p) || p <= 0) return false;
    try { process.kill(p, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
  };
  const own = pid ? found.filter((r) => r.pid === pid) : [];
  const live = own.length ? own : found.filter((r) => alive(r.pid));
  if (live.length !== 1) return null;
  const bridge = live[0].bridge;
  return typeof bridge === "string" && /^[A-Za-z0-9_-]+$/.test(bridge) ? bridge : "";
}
export { RemoteControlMethods };
export type { RcState };
