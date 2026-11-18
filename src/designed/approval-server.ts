
import { crypto, http } from "../externals.js";
import { TOKEN_HEADER, parseAsk, parseStream, promptContext } from "./approvals-core.js";
import type { PermissionAsk, StreamBatch } from "./approvals-core.js";

const MAX_BODY = 1024 * 1024;
const MAX_HELD = 8;
const HOLD_MS = 590 * 1000;

export interface HeldAsk {
  id: number;
  ask: PermissionAsk;
  answered: boolean;
  answer(body: string): void;
}

export interface ApprovalTab {
  asked(held: HeldAsk): void;
  ended(held: HeldAsk): void;
  finished(done: PermissionAsk): void;
  streamed(batch: StreamBatch): void;
  prompted(): { text: string; delivered?: () => void };
}

export class ApprovalServer {
  readonly token = crypto.randomBytes(24).toString("hex");
  private server: http.Server | null = null;
  private port = 0;
  private starting: Promise<boolean> | null = null;
  private stopped = false;
  private tabs = new Map<string, ApprovalTab>();
  private held = new Map<string, Set<HeldAsk>>();
  private nextId = 1;

  start(): Promise<boolean> {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      this.server = server;
      server.on("error", (e) => { console.error("[Agent Manager] the session view's approval server failed:", e); this.server = null; this.starting = null; resolve(false); });
      server.listen(0, "127.0.0.1", () => {
        if (this.stopped) { server.close(); resolve(false); return; }
        const addr = server.address();
        this.port = addr && typeof addr === "object" ? addr.port : 0;
        resolve(this.port > 0);
      });
    });
    return this.starting;
  }

  base(tabId: string): string | null {
    return this.server && this.port && !this.stopped ? `http://127.0.0.1:${this.port}/${tabId}` : null;
  }

  register(tabId: string, tab: ApprovalTab): void {
    this.tabs.set(tabId, tab);
  }

  unregister(tabId: string): void {
    this.tabs.delete(tabId);
    for (const h of [...(this.held.get(tabId) ?? [])]) h.answer("");
    this.held.delete(tabId);
  }

  stop(): void {
    this.stopped = true;
    for (const set of this.held.values()) for (const h of [...set]) h.answer("");
    this.held.clear();
    this.tabs.clear();
    const s = this.server;
    this.server = null;
    this.port = 0;
    if (s) {
      s.closeAllConnections();
      s.close();
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const end = (status: number, body = ""): void => {
      if (res.writableEnded) return;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    };
    const m = /^\/([a-z0-9]{8,64})\/(permission|done|stream|prompt)$/.exec(req.url || "");
    const given = String(req.headers[TOKEN_HEADER] || "");
    if (req.method !== "POST" || !m || !this.tokenMatches(given)) { end(404); req.resume(); return; }
    const [, tabId, kind] = m;
    if (kind === "done" && !this.held.get(tabId)?.size) { end(200); req.resume(); return; }
    if (kind === "prompt") {
      req.resume();
      let note: { text: string; delivered?: () => void } = { text: "" };
      try { note = this.tabs.get(tabId)?.prompted() ?? note; } catch { /* empty */ }
      if (note.delivered) res.on("finish", note.delivered);
      end(200, promptContext(note.text));
      return;
    }
    if (kind === "stream") {
      end(200);
      const tab = this.tabs.get(tabId);
      if (!tab) { req.resume(); return; }
      const parts: Buffer[] = [];
      let n = 0;
      req.on("data", (c: Buffer) => { n += c.length; if (n <= MAX_BODY) parts.push(c); });
      req.on("end", () => {
        const batch = n <= MAX_BODY ? parseStream(Buffer.concat(parts).toString("utf8")) : null;
        if (batch) tab.streamed(batch);
      });
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks.length = 0; if (kind !== "done") { end(413); req.destroy(); } return; }
      if (!over) chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      if (over) { end(200); return; }
      const ask = parseAsk(Buffer.concat(chunks).toString("utf8"));
      const tab = this.tabs.get(tabId);
      if (!ask || !tab) { end(200); return; }
      if (kind === "done") { end(200); tab.finished(ask); return; }
      this.hold(tabId, tab, ask, end, res);
    });
  }

  private hold(tabId: string, tab: ApprovalTab, ask: PermissionAsk, end: (status: number, body?: string) => void, res: http.ServerResponse): void {
    let set = this.held.get(tabId);
    if (!set) this.held.set(tabId, set = new Set());
    if (set.size >= MAX_HELD) { end(200); return; }
    const tabSet = set;
    let byTab = false;
    let timer = 0;
    const finish = (): void => {
      window.clearTimeout(timer);
      tabSet.delete(held);
      if (!byTab) tab.ended(held);
    };
    const held: HeldAsk = {
      id: this.nextId++,
      ask,
      answered: false,
      answer: (body: string) => {
        if (held.answered) return;
        held.answered = true;
        byTab = body !== "";
        end(200, body);
        finish();
      },
    };
    res.on("close", () => {
      if (held.answered) return;
      held.answered = true;
      finish();
    });
    timer = window.setTimeout(() => held.answer(""), HOLD_MS);
    tabSet.add(held);
    tab.asked(held);
  }

  private tokenMatches(given: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
