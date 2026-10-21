// Drives src/session.ts from plain Node, the way the view does, to check the
// transport outside Obsidian: fd 3 as one two-way control channel, the first
// size, resizes, output and exit, a close that ends a background job, and the
// finder. Built by `node esbuild.config.mjs test` into .build/harness.cjs.
// Obsidian's renderer is checked separately, in a test vault.

import { execFileSync, spawn } from "child_process";
import { chmodSync, readFileSync, mkdtempSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HelperSession, type ExitInfo, type StartError } from "../src/vault-terminal/session";
import { DEFAULT_STRIPPED_VARIABLES, agentEnv, parseNames, parseVariables, probeLoginEnv, fallbackPath, findPython, loginShell, probeLoginPath, programEnv, splitCommand, expandPath, withNotificationChannel } from "../src/vault-terminal/finder";
import { findPaths, findUrls } from "../src/vault-terminal/links";
import { HOOK_ID, StatusTracker, splitTitle, type Attention } from "../src/vault-terminal/status";
import { zshIntegrationEnv } from "../src/vault-terminal/zsh";
import { AGENTS, agentById, agentFor, agentForProgram, prepareAgent } from "../src/vault-terminal/agents";
import { afterExitKey, ctrlCCopies } from "../src/vault-terminal/keys";
import { closeText } from "../src/vault-terminal/close";
import { prepareClaude, userScrollSetting } from "../src/vault-terminal/claude";
import { ReportQueue, REPORT_GAP_MS, WheelCounter, DOM_DELTA_LINE, DOM_DELTA_PAGE, DOM_DELTA_PIXEL, drainCount, scrollSpeed } from "../src/vault-terminal/wheel";
import { DIACRITICS, findPattern, GraphicsFilter, IMAGE_COST, KittyGraphics, PICTURE_LINK, PLACEMENT_COST, PLACEMENTS_KEPT, READ_ERROR, diacriticValue, readPlaceholder, tempToDelete, withoutPlaceholders, type Piece } from "../src/vault-terminal/kitty";
import { deflateSync } from "zlib";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Run {
  session: HelperSession;
  output: () => string;
  exited: Promise<ExitInfo | StartError>;
  ready: Promise<{ pid: number; tty: string }>;
}

function run(python: string, program: string[], rows: number, cols: number, cwd: string, env: NodeJS.ProcessEnv, px?: { width: number; height: number }): Run {
  const chunks: Buffer[] = [];
  let onExit!: (i: ExitInfo | StartError) => void;
  let onReady!: (i: { pid: number; tty: string }) => void;
  const exited = new Promise<ExitInfo | StartError>((r) => (onExit = r));
  const ready = new Promise<{ pid: number; tty: string }>((r) => (onReady = r));
  const session = new HelperSession(
    { id: "harness", python, program, cwd, env, rows, cols, ...px },
    { data: (c) => chunks.push(Buffer.from(c)), ready: (i) => onReady(i), exit: onExit, error: onExit },
  );
  return { session, output: () => Buffer.concat(chunks).toString("utf8"), exited, ready };
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}

async function main(): Promise<void> {
  kittyChecks();
  seamChecks();
  // Only the picture checks, which need no pty: node .build/harness.cjs kitty
  if (process.argv.includes("kitty")) {
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
  }
  // Run by the test below as its own process, standing in for Obsidian dying
  // mid-probe: start a probe, then exit without any chance to end it.
  if (process.argv[2] === "probe-then-die") {
    void probeLoginPath("/bin/zsh", { ...process.env, ZDOTDIR: process.argv[3] });
    const pidFile = join(process.argv[3], "sleep.pid");
    const end = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < end) await sleep(50);
    process.exit(0);
  }
  check("splitCommand quotes", JSON.stringify(splitCommand(`claude --model "opus 5" 'a b' c\\ d`)) === JSON.stringify(["claude", "--model", "opus 5", "a b", "c d"]));
  check("expandPath keeps the leading slash", expandPath("/Users/x/My Vault//a/") === "/Users/x/My Vault/a/");
  {
    const urls = (t: string) => findUrls(t).map((l) => `${l.start}:${l.url}`).join(" ");
    check("links: plain", urls("see https://example.com/a?b=1 now") === "4:https://example.com/a?b=1", urls("see https://example.com/a?b=1 now"));
    check("links: sentence punctuation dropped", urls("at https://example.com/x.") === "3:https://example.com/x");
    check("links: wrapping parens dropped", urls("(https://example.com/x)") === "1:https://example.com/x");
    check("links: own parens kept", urls("https://en.wikipedia.org/wiki/A_(b)") === "0:https://en.wikipedia.org/wiki/A_(b)");
    check("links: two, and none", urls("http://a.io and https://b.io/c, ftp://no") === "0:http://a.io 16:https://b.io/c" && urls("https:// nothing") === "");
  }

  {
    const files = new Set(["/etc/hosts", "~/notes/a.md", "src/view.ts", "README.md", "/Users/x/Obsidian Vaults/My Vault/Daily note.md", "/Users/x/Obsidian Vaults/My Vault"]);
    const paths = (t: string) => findPaths(t, (p) => files.has(p)).map((l) => `${l.start}:${l.path}`).join(" | ");
    check("paths: absolute, ~/, relative, bare name", paths("see /etc/hosts and ~/notes/a.md, src/view.ts or README.md.") === "4:/etc/hosts | 19:~/notes/a.md | 33:src/view.ts | 48:README.md", paths("see /etc/hosts and ~/notes/a.md, src/view.ts or README.md."));
    check("paths: a line number is left out", paths("src/view.ts:120:4: error") === "0:src/view.ts", paths("src/view.ts:120:4: error"));
    check("paths: only ones that exist", paths("missing/file.ts and nothing.md") === "");
    check("paths: spaces, the longest that exists", paths("Wrote /Users/x/Obsidian Vaults/My Vault/Daily note.md now") === "6:/Users/x/Obsidian Vaults/My Vault/Daily note.md", paths("Wrote /Users/x/Obsidian Vaults/Other Vault/Daily note.md now"));
    check("paths: not across quotes or brackets", paths("('/etc/hosts') [README.md]") === "2:/etc/hosts | 16:README.md", paths("('/etc/hosts') [README.md]"));
    check("paths: web addresses aren't paths", paths("https://example.com/src/view.ts") === "");
    const more = new Set(["Daily note.md", "note.md", "/tmp/report(final).md", "/tmp/report", "café.md"]);
    const paths2 = (t: string) => findPaths(t, (p) => more.has(p)).map((l) => `${l.start}:${l.path}`).join(" | ");
    check("paths: a relative name with a space, not its tail", paths2("Wrote Daily note.md.") === "6:Daily note.md", paths2("Wrote Daily note.md."));
    check("paths: parentheses inside a name", paths2("saved /tmp/report(final).md") === "6:/tmp/report(final).md", paths2("saved /tmp/report(final).md"));
    check("paths: parentheses around a path", paths2("(see note.md)") === "5:note.md", paths2("(see note.md)"));
    check("paths: names in other scripts", paths2("open café.md") === "5:café.md", paths2("open café.md"));
    check("paths: a path in its own parentheses", paths2("(note.md) and (/tmp/report(final).md)") === "1:note.md | 15:/tmp/report(final).md", paths2("(note.md) and (/tmp/report(final).md)"));
  }

  {
    const run = (cmd: string) => {
      const w = splitCommand(cmd);
      withNotificationChannel(w);
      return w;
    };
    const k = '{"preferredNotifChannel":"kitty"}';
    check("channel: added", JSON.stringify(run("claude")) === JSON.stringify(["claude", "--settings", k]));
    check("channel: merged into inline --settings", JSON.stringify(run(`claude --settings '{"model":"haiku"}'`)) === JSON.stringify(["claude", "--settings", '{"model":"haiku","preferredNotifChannel":"kitty"}']), JSON.stringify(run(`claude --settings '{"model":"haiku"}'`)));
    check("channel: --settings= form merged", run(`claude '--settings={"a":1}'`)[1] === '--settings={"a":1,"preferredNotifChannel":"kitty"}', JSON.stringify(run(`claude '--settings={"a":1}'`)));
    check("channel: the user's own channel kept", run(`claude --settings '{"preferredNotifChannel":"terminal_bell"}'`)[2] === '{"preferredNotifChannel":"terminal_bell"}');
    check("channel: a settings file left alone", JSON.stringify(run("claude --settings ./s.json")) === JSON.stringify(["claude", "--settings", "./s.json"]));
  }

  // Steady scrolling for claude: added only where the user set neither.
  {
    const home = mkdtempSync(join(tmpdir(), "tl-claude-"));
    const project = join(home, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    const config = join(home, "config");
    mkdirSync(config);
    const base = { CLAUDE_CONFIG_DIR: config };
    const prep = (cmd: string, env: NodeJS.ProcessEnv = { ...base }, cwd = project) => {
      const w = splitCommand(cmd);
      prepareClaude(w, env, cwd, {});
      return { w, env };
    };
    // The settings passed, without the hooks (checked on their own below).
    const sansHooks = (json: string) => {
      const { hooks: _hooks, ...rest } = JSON.parse(json) as Record<string, unknown>;
      return JSON.stringify(rest);
    };
    const fresh = prep("claude");
    check("claude scroll: added when nothing is set (speed 0.25: one line a report)", fresh.env.CLAUDE_CODE_SCROLL_SPEED === "0.25" && sansHooks(fresh.w[2]) === '{"preferredNotifChannel":"kitty","wheelScrollAccelerationEnabled":false}', JSON.stringify(fresh));
    {
      const hooks = JSON.parse(fresh.w[2]).hooks as Record<string, { hooks: { command: string }[] }[]>;
      const states = Object.fromEntries(Object.entries(hooks).map(([e, l]) => [e, l[0].hooks[0].command.match(/vault-terminal-state;(\w+)/)?.[1]]));
      check("hooks: one per event, each reporting its state", JSON.stringify(states) === JSON.stringify({ UserPromptSubmit: "working", PostToolUse: "working", PostToolUseFailure: "working", PermissionRequest: "waiting", Stop: "finished", StopFailure: "error" }), JSON.stringify(states));
      const out = execFileSync("/bin/sh", ["-c", hooks.Stop[0].hooks[0].command]).toString();
      check("hooks: the command prints claude's answer, the sequence intact", (JSON.parse(out) as { terminalSequence: string }).terminalSequence === "\x1b]99;i=vault-terminal-state;finished\x07", JSON.stringify(out));
      const own = prep(`claude --settings '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"true"}]}]}}'`);
      const ownHooks = JSON.parse(own.w[2]).hooks as Record<string, { hooks: { command: string }[] }[]>;
      check("hooks: added to the command's own, both kept", ownHooks.Stop.length === 2 && ownHooks.Stop[0].hooks[0].command === "true" && ownHooks.Stop[1].hooks[0].command.includes("finished") && !!ownHooks.UserPromptSubmit, JSON.stringify(ownHooks.Stop));
    }
    const nothing = (r: { w: string[]; env: NodeJS.ProcessEnv }) => r.env.CLAUDE_CODE_SCROLL_SPEED !== "0.25" && !r.w.join(" ").includes('"wheelScrollAccelerationEnabled":false');
    const env = prep("claude", { ...base, CLAUDE_CODE_SCROLL_SPEED: "3" });
    check("claude scroll: a speed in the environment: nothing added", nothing(env) && env.env.CLAUDE_CODE_SCROLL_SPEED === "3", JSON.stringify(env));
    check("claude scroll: acceleration in the command's --settings: nothing added", nothing(prep(`claude --settings '{"wheelScrollAccelerationEnabled":true}'`)));
    check("claude scroll: a speed in the command's --settings env: nothing added", nothing(prep(`claude --settings '{"env":{"CLAUDE_CODE_SCROLL_SPEED":"2"}}'`)));
    check("claude scroll: a speed set before the program: nothing added", nothing(prep("env CLAUDE_CODE_SCROLL_SPEED=2 claude")));
    writeFileSync(join(project, "s.json"), '{"wheelScrollAccelerationEnabled":true}');
    check("claude scroll: acceleration in a --settings file: nothing added", nothing(prep("claude --settings s.json")) && userScrollSetting(["claude", "--settings", "s.json"], {}, project) === "command");
    writeFileSync(join(project, "t.json"), "{}");
    check("claude scroll: an unrelated --settings file: still nothing added, it can't be merged", nothing(prep("claude --settings t.json")));
    writeFileSync(join(config, "settings.json"), '{"env":{"CLAUDE_CODE_SCROLL_SPEED":"5"}}');
    check("claude scroll: a saved /scroll-speed (user settings env): nothing added", nothing(prep("claude")) && userScrollSetting(["claude"], { ...base }, project) === join(config, "settings.json"));
    writeFileSync(join(config, "settings.json"), '{"wheelScrollAccelerationEnabled":true}');
    check("claude scroll: acceleration on in user settings: nothing added", nothing(prep("claude")));
    writeFileSync(join(config, "settings.json"), '{"theme":"dark"}');
    writeFileSync(join(project, ".claude", "settings.local.json"), '{"wheelScrollAccelerationEnabled":false}');
    check("claude scroll: set in the project's local settings: nothing added", nothing(prep("claude")));
    writeFileSync(join(project, ".claude", "settings.local.json"), "{}");
    check("claude scroll: unrelated settings files: added", prep("claude").env.CLAUDE_CODE_SCROLL_SPEED === "0.25");
    check("claude: synchronized output forced, as the terminal supports it", prep("claude").env.CLAUDE_CODE_FORCE_SYNC_OUTPUT === "1");
    check("claude: strikethrough forced, as the terminal supports it", prep("claude").env.CLAUDE_CODE_FORCE_STRIKETHROUGH === "1");
    check("claude: FORCE_HYPERLINK not added, as the commands claude runs would inherit it", !("FORCE_HYPERLINK" in prep("claude").env));
    check("claude: the user's own strikethrough setting kept", prep("claude", { ...base, CLAUDE_CODE_FORCE_STRIKETHROUGH: "0" }).env.CLAUDE_CODE_FORCE_STRIKETHROUGH === "0");
    check("claude: the user's own FORCE_HYPERLINK kept", prep("claude", { ...base, FORCE_HYPERLINK: "0" }).env.FORCE_HYPERLINK === "0");
    check("claude: an empty value of the user's own kept", prep("claude", { ...base, CLAUDE_CODE_FORCE_STRIKETHROUGH: "", CLAUDE_CODE_FORCE_SYNC_OUTPUT: "" }).env.CLAUDE_CODE_FORCE_STRIKETHROUGH === "" && prep("claude", { ...base, CLAUDE_CODE_FORCE_SYNC_OUTPUT: "" }).env.CLAUDE_CODE_FORCE_SYNC_OUTPUT === "");
    check("claude: the user's own sync setting kept", prep("claude", { ...base, CLAUDE_CODE_FORCE_SYNC_OUTPUT: "0" }).env.CLAUDE_CODE_FORCE_SYNC_OUTPUT === "0");
    const merged = prep(`claude --settings '{"model":"haiku"}'`);
    check("claude scroll: merged into the command's own inline --settings", sansHooks(merged.w[2]) === '{"model":"haiku","preferredNotifChannel":"kitty","wheelScrollAccelerationEnabled":false}', merged.w[2]);
  }

  {
    check("agents: known by the program's file name", agentForProgram("/Users/x/.local/bin/codex")?.id === "codex" && agentForProgram("/opt/claude")?.id === "claude" && agentForProgram("/usr/local/bin/agy")?.id === "antigravity");
    check("agents: a shell or an unknown program has no profile, and gets the defaults", agentForProgram("/bin/zsh") === null && agentForProgram("/usr/local/bin/opencode") === null);
    check("agents: ids are unique and found", new Set(AGENTS.map((a) => a.id)).size === AGENTS.length && AGENTS.every((a) => agentById(a.id) === a) && agentById("shell") === null);
    const w = ["codex", "--model", "x"];
    const ctx = { env: {}, cwd: tmpdir(), pictures: false };
    agentForProgram("/x/codex")?.prepare?.(w, ctx);
    const c = ["claude"];
    agentForProgram("/x/claude")?.prepare?.(c, ctx);
    check("agents: only claude gets claude's --settings", w.length === 3 && c[1] === "--settings", JSON.stringify([w, c]));
    check("agents: opened as Claude, started through npx or a wrapper, still Claude", agentFor("claude", "/usr/local/bin/npx")?.id === "claude" && agentFor("claude", "/Users/x/bin/run-claude")?.id === "claude");
    check("agents: Codex set as Claude's command is Codex", agentFor("claude", "/x/codex")?.id === "codex");
    check("agents: a shell has no profile", agentFor("shell", "/bin/zsh") === null);
  }

  {
    // An agent recognized in a shell tab after its first signals: they carry over.
    const shell = new StatusTracker("running", false, () => {}, () => {});
    shell.start();
    shell.statusQuery();
    shell.setTitle("⠐ Claude Code");
    const agent = new StatusTracker("unknown", true, () => {}, () => {});
    agent.start();
    agent.adopt(shell);
    check("status: an agent recognized late keeps its status query and working title", agent.asksStatus && agent.state === "working" && agent.title === "Claude Code", JSON.stringify({ asks: agent.asksStatus, state: agent.state, title: agent.title }));
  }
  {
    // A turn's end is announced at once, from the hook; claude's own reminder a minute later isn't.
    const said: string[] = [];
    const t = new StatusTracker("unknown", true, () => {}, (a) => said.push(a.body || a.title));
    t.start();
    const hook = (state: string) => t.kittyNotification(`i=${HOOK_ID};${state}`);
    hook("working");
    hook("finished");
    t.kittyNotification("i=n1:d=0;Claude Code");
    t.kittyNotification("i=n1:p=body;Claude is waiting for your input");
    const first = [...said];
    t.answered();
    hook("working");
    t.kittyNotification("i=n2:p=body;Claude needs your permission to use Bash");
    hook("working");
    hook("error");
    check(
      "notifications: a turn's end is announced at once; claude's later reminder is left out; a permission prompt still notifies; an error ends a turn too",
      JSON.stringify(first) === JSON.stringify(["Claude finished"]) && JSON.stringify(said.slice(1)) === JSON.stringify(["Claude needs your permission to use Bash", "Claude stopped with an error"]),
      JSON.stringify(said),
    );
    // An agent recognized late that had already asked permission stays waiting.
    const shell = new StatusTracker("running", false, () => {}, () => {});
    shell.start();
    shell.statusQuery();
    shell.setTitle("\u2733 Claude Code");
    shell.kittyNotification("i=n3:p=body;Claude needs your permission to use Bash");
    const agent = new StatusTracker("unknown", true, () => {}, () => {});
    agent.start();
    agent.adopt(shell);
    check("status: an agent recognized late keeps a permission prompt it already showed", agent.state === "waiting", `${shell.state} then ${agent.state}`);
  }
  // Progress and session status.
  {
    const t = new StatusTracker("running", false, () => {}, () => {});
    t.start();
    t.otherNotification(9, "4;1;42");
    check("progress: a percent is working, with the percent", t.shown === "working" && t.percent === 42);
    t.otherNotification(9, "4;3");
    check("progress: indeterminate is working, no percent", t.shown === "working" && t.percent === null);
    t.otherNotification(9, "4;2;50");
    check("progress: error shows error", t.shown === "error");
    t.otherNotification(9, "4;1;60");
    check("progress: the next progress replaces the error", t.shown === "working" && t.percent === 60);
    t.otherNotification(9, "4;4;60");
    check("progress: paused is paused, not waiting", t.shown === "paused");
    t.otherNotification(9, "4;0");
    check("progress: clear returns to the other signals, not finished", t.shown === "running" && t.percent === null);
    t.sessionStatus("status=Waiting;indicator=#ff0000");
    check("session status: Waiting is waiting", t.shown === "waiting" && t.statusText === "");
    t.sessionStatus("status=Compiling assets;detail=x");
    check("session status: other text is shown, the state isn't changed by it", t.statusText === "Compiling assets" && t.shown === "waiting", t.shown);
    t.sessionStatus("status=Working");
    t.otherNotification(9, "4;4");
    check("precedence: between the two, the most recent wins (progress after status)", t.shown === "paused");
    t.sessionStatus("status=Idle");
    check("precedence: the most recent wins (status after progress)", t.shown === "idle");
    t.sessionStatus("status=");
    check("session status: an empty value clears it; progress shows again", t.shown === "paused" && t.statusText === "");
    t.sessionStatus("foo=bar;unknown=1");
    check("session status: unknown keys ignored", t.shown === "paused");
    t.otherNotification(9, "4;1;42");
    t.sessionStatus("status=Working");
    check("progress: a later session status of the same state hides the percent", t.shown === "working" && t.percent === null, String(t.percent));
    t.sessionStatus("status=constructor");
    check("session status: an inherited name (constructor) is text, not a state", t.shown === "working" && t.statusText === "constructor", t.shown);
    t.sessionStatus("status=");
    const c = new StatusTracker("unknown", true, () => {}, () => {});
    c.start();
    c.statusQuery();
    c.setTitle("◐ Working on it");
    c.otherNotification(9, "4;2");
    c.sessionStatus("status=Idle");
    check("precedence: claude's own signals win over both", c.shown === "working", c.shown);
    c.programReturned();
    t.programReturned();
    t.start();
    check("a new program starts with no reports", t.shown === "running" && t.statusText === "" && t.percent === null);
  }

  // The wheel: one line per cell height of travel, at most a screen per event.
  for (const h of [15, 15.5, 17]) {
    const px = (deltaY: number, shiftKey = false) => ({ deltaY, deltaX: 0, deltaMode: DOM_DELTA_PIXEL, shiftKey });
    const sum = (w: WheelCounter, evs: ReturnType<typeof px>[]) => evs.reduce((a, e) => a + w.lines(e, h, 30), 0);
    let w = new WheelCounter();
    const slow = sum(w, Array.from({ length: 160 }, () => px(4)));
    check(`wheel h=${h}: 160 events of 4 px give floor(640/h), within 1`, Math.abs(slow - Math.floor(640 / h)) <= 1, `${slow} vs ${Math.floor(640 / h)}`);
    w = new WheelCounter();
    const big = w.lines(px(1000), h, 30);
    const after = w.lines(px(1), h, 30);
    check(`wheel h=${h}: 1,000 px gives at most a screen, and the excess isn't carried`, big === Math.min(Math.floor(1000 / h), 30) && after === 0, `${big}, then ${after}`);
    w = new WheelCounter();
    check(`wheel h=${h}: a line-mode 3 gives 3, a page-mode 1 gives a screen`, w.lines({ deltaY: 3, deltaX: 0, deltaMode: DOM_DELTA_LINE, shiftKey: false }, h, 30) === 3 && w.lines({ deltaY: 1, deltaX: 0, deltaMode: DOM_DELTA_PAGE, shiftKey: false }, h, 30) === 30);
    w = new WheelCounter();
    const down = sum(w, Array.from({ length: 10 }, () => px(4)));
    const up = sum(w, Array.from({ length: 10 }, () => px(-4)));
    check(`wheel h=${h}: 10 of +4 then 10 of -4 give floor(40/h) each way`, down === Math.floor(40 / h) && up === -Math.floor(40 / h), `${down}, ${up}`);
    w = new WheelCounter();
    check(`wheel h=${h}: Shift with 3h px gives 3; macOS's sideways Shift travel counts`, w.lines(px(3 * h, true), h, 30) === 3 && w.lines({ deltaY: 0, deltaX: 3 * h, deltaMode: DOM_DELTA_PIXEL, shiftKey: true }, h, 30) === 3);
  }
  {
    // The scroll speed setting: lines per line of travel.
    const ev = (deltaY: number) => ({ deltaY, deltaX: 0, deltaMode: DOM_DELTA_PIXEL, shiftKey: false });
    const notch = new WheelCounter().lines(ev(51), 17, 30, scrollSpeed(1));
    check("wheel, speed: a 51 px notch over 17 px rows gives 3 lines at 1", notch === 3, String(notch));
    const twice = new WheelCounter().lines(ev(51), 17, 30, scrollSpeed(2));
    check("wheel, speed: 2 doubles it", twice === 6, String(twice));
    const w = new WheelCounter();
    const slow = Array.from({ length: 40 }, () => w.lines(ev(4), 17, 30, scrollSpeed(0.5))).reduce((x, y) => x + y, 0);
    check("wheel, speed: at 0.5, 160 px of trackpad travel gives floor(80/17), carried between events", slow === Math.floor(80 / 17), String(slow));
    check("wheel, speed: clamped to 0.25 to 4, and 1 when unset", scrollSpeed(10) === 4 && scrollSpeed(0.1) === 0.25 && scrollSpeed(undefined) === 1 && scrollSpeed("x") === 1);
  }
  {
    // Scroll reports a frame apart (ReportQueue): a notch's lines go out one a frame; a long queue drains faster.
    check("reports: drainCount is 1 up to 3 lines, 2 up to 8, then a quarter", [0, 1, 3, 4, 8, 9, 30, -3, -12].map(drainCount).join() === "0,1,1,2,2,3,8,1,3");
    const q = new ReportQueue();
    q.add(3, 30);
    const sent: number[] = [];
    for (let t = 0; t <= 100; t += 5) { const n = q.take(1000 + t); if (n) sent.push(n); }
    check("reports: a 3-line notch goes out as 1, 1, 1, at least the gap apart", sent.join() === "1,1,1" && !q.waiting, sent.join());
    const g = new ReportQueue();
    g.add(-2, 30);
    check("reports: never sooner than the gap", g.take(0) === -1 && g.take(REPORT_GAP_MS - 1) === 0 && g.take(REPORT_GAP_MS) === -1);
    const r = new ReportQueue();
    r.add(5, 30);
    r.add(-1, 30);
    check("reports: a change of direction drops what was waiting", r.take(0) === -1 && !r.waiting);
    const c = new ReportQueue();
    c.add(100, 30);
    let total = 0;
    for (let t = 0; c.waiting; t += REPORT_GAP_MS) total += c.take(t);
    check("reports: the queue holds at most a screen", total === 30, String(total));
  }
  check("wheel: sideways travel without Shift is ignored", new WheelCounter().lines({ deltaY: 0, deltaX: 100, deltaMode: DOM_DELTA_PIXEL, shiftKey: false }, 15, 30) === 0);

  // The status tracker, fed what claude sent in a test vault.
  {
    check("title glyph split", JSON.stringify(splitTitle("◐ Tl-status-check echo test")) === JSON.stringify({ glyph: "◐", text: "Tl-status-check echo test" }));
    check("title without glyph", splitTitle("~/vault — zsh").glyph === "" && splitTitle("A title").text === "A title");
    const seen: string[] = [];
    const asked: Attention[] = [];
    // Title changes also call back; keep only changes of state.
    const t = new StatusTracker("unknown", true, () => seen[seen.length - 1] !== t.state && seen.push(t.state), (a) => asked.push(a));
    t.start();
    t.setTitle("◐ Claude Code");
    check("a spinner without the status query isn't read as working", t.state === "unknown", t.state);
    t.statusQuery();
    t.setTitle("✳ Claude Code");
    check("✳ at start: idle", t.state === "idle" && t.title === "Claude Code", `${t.state} ${t.title}`);
    t.setTitle("◐ Claude Code");
    t.setTitle("◑ Write vault-terminal-status-check.txt file");
    check("spinner: working, with claude's session name", t.state === "working" && t.title === "Write vault-terminal-status-check.txt file", `${t.state} ${t.title}`);
    t.setTitle("✳ Write vault-terminal-status-check.txt file");
    check("✳ after working: idle, not guessed further", t.state === "idle", t.state);
    t.kittyNotification("i=7203:d=0:p=title;Claude Code");
    check("a notification's first part waits for the rest", t.state === "idle" && asked.length === 0);
    t.kittyNotification("i=7203:p=body;Claude needs your permission");
    t.kittyNotification("i=7203:d=1:a=focus;");
    check("permission notification: waiting", t.state === "waiting" && asked.length === 1 && asked[0].title === "Claude Code" && asked[0].body === "Claude needs your permission", `${t.state} ${JSON.stringify(asked)}`);
    t.setTitle("✳ Write vault-terminal-status-check.txt file");
    check("✳ again doesn't clear waiting", t.state === "waiting", t.state);
    t.setTitle("◐ Write vault-terminal-status-check.txt file");
    t.setTitle("✳ Write vault-terminal-status-check.txt file");
    t.kittyNotification("i=26:d=0:p=title;Claude Code");
    t.kittyNotification("i=26:p=body;Claude is waiting for your input");
    t.kittyNotification("i=26:d=1:a=focus;");
    check("idle notification: finished", t.state === "finished", t.state);
    t.otherNotification(9, "4;3;");
    check("OSC 9;4 progress isn't a notification", asked.length === 2, String(asked.length));
    t.exit();
    t.kittyNotification("i=1;late");
    check("exited stays exited", t.state === "exited", t.state);
    check("states passed through", seen.join(" ") === "unknown idle working idle waiting working idle finished exited", seen.join(" "));
    {
      let calls = 0;
      const u = new StatusTracker("unknown", true, () => calls++, () => {});
      u.start();
      u.statusQuery();
      u.setTitle("◐ Claude Code");
      calls = 0;
      u.setTitle("◑ Fix the build");
      check("a new name while working refreshes the tab", calls === 1 && u.title === "Fix the build", `${calls} ${u.title}`);
      u.setTitle("✓ Done");
      check("an unknown glyph changes no state", u.state === "working", u.state);
      u.setTitle("✳ Done");
      u.otherNotification(777, "notify;Build;Build completed");
      check("an unknown notification changes no state", u.state === "idle", u.state);
      u.kittyNotification("i=3;Claude needs your permission");
      u.answered();
      check("answering makes waiting stale", u.state === "idle", u.state);
      // The hooks' reports.
      const h: string[] = [];
      const told: Attention[] = [];
      const w = new StatusTracker("unknown", true, () => h[h.length - 1] !== w.state && h.push(w.state), (a) => told.push(a));
      w.start();
      w.statusQuery();
      w.setTitle("✳ Claude Code");
      const hook = (state: string) => w.kittyNotification(`i=vault-terminal-state;${state}`);
      hook("working");
      w.setTitle("◐ Write a file");
      hook("waiting");
      w.setTitle("✳ Write a file");
      check("hooks: waiting at once, and ✳ doesn't clear it", w.state === "waiting", w.state);
      w.escaped();
      check("hooks: Escape at a permission prompt is idle", w.state === "idle", w.state);
      hook("working");
      hook("finished");
      w.setTitle("✳ Write a file");
      check("hooks: finished at once, and ✳ after it changes nothing", w.state === "finished", w.state);
      w.escaped();
      check("hooks: Escape changes nothing but waiting", w.state === "finished", w.state);
      hook("working");
      w.setTitle("◐ Write a file");
      w.setTitle("✳ Write a file");
      check("hooks: an interrupt (no hook), ✳ after working is idle", w.state === "idle", w.state);
      hook("error");
      check("hooks: a failed turn is error", w.shown === "error", w.shown);
      w.answered();
      check("hooks: Return after an error is idle", w.state === "idle", w.state);
      hook("bogus");
      // Only a turn's end notifies, once per turn: the finished and the failed turn above.
      check("hooks: an unknown report changes nothing; only a turn's end notified", w.state === "idle" && JSON.stringify(told.map((x) => x.body)) === JSON.stringify(["Claude finished", "Claude stopped with an error"]), `${w.state} ${JSON.stringify(told)}`);
      check("hooks: states passed through", h.join(" ") === "idle working waiting idle working finished working idle error idle", h.join(" "));
      const plain = new StatusTracker("running", false, () => {}, () => {});
      plain.start();
      plain.kittyNotification("i=vault-terminal-state;working");
      check("hooks: a program that isn't claude can't set state this way", plain.state === "running", plain.state);
      const v = new StatusTracker("unknown", true, () => {}, () => {});
      v.start();
      v.kittyNotification("i=4:p=body;Claude is waiting for your input");
      v.answered();
      check("without titles, answering goes back to unknown", v.state === "unknown", v.state);
    }
    {
      const sh = new StatusTracker("running", false, () => {}, () => {});
      sh.start();
      sh.statusQuery();
      sh.kittyNotification("i=5:p=body;Claude needs your permission");
      sh.programReturned();
      sh.setTitle("◐ busy");
      check("claude run from a shell, then gone: back to running, its glyphs no longer read", sh.state === "running", sh.state);
    }
    {
      let asked = 0;
      const other = new StatusTracker("running", false, () => {}, () => asked++);
      other.start();
      other.otherNotification(9, "Installer waiting for your input");
      check("another program's notification notifies but sets no state", other.state === "running" && asked === 1, `${other.state} ${asked}`);
    }
    const shell = new StatusTracker("running", false, () => {}, () => {});
    shell.start();
    shell.setTitle("◐ busy");
    check("a shell's title glyph means nothing", shell.state === "running");
  }

  const path = await fallbackPath();
  check("fallback PATH from path_helper", path.includes("/usr/bin"), path);
  const python = await findPython("", path.split(":"));
  check("found a Python 3 that isn't the /usr/bin stub", python.path !== "/usr/bin/python3", python.path);
  console.log(`     using ${python.path} (${python.version}); login shell ${loginShell("")}`);
  const env = programEnv(path);
  check("program env drops Electron's variables", !Object.keys(env).some((k) => k.startsWith("ELECTRON_")));
  {
    const saved = [process.env.LINES, process.env.COLUMNS];
    process.env.LINES = "24";
    process.env.COLUMNS = "80";
    const e = programEnv(path);
    [process.env.LINES, process.env.COLUMNS] = saved;
    if (saved[0] === undefined) delete process.env.LINES;
    if (saved[1] === undefined) delete process.env.COLUMNS;
    check("program env drops LINES and COLUMNS, which would override the pty's size", !("LINES" in e) && !("COLUMNS" in e));
  }
  const cwd = mkdtempSync(join(tmpdir(), "vault terminal "));

  // The login shell's PATH, with startup files that print text, and one that hangs.
  {
    const zdot = (name: string, zshrc: string) => {
      const dir = join(cwd, name);
      mkdirSync(dir);
      writeFileSync(join(dir, ".zshrc"), zshrc);
      return { ...env, ZDOTDIR: dir };
    };
    const noisy = zdot("noisy", 'echo "welcome, junk on stdout"\necho "junk on stderr" >&2\nprintf "\\033[31mcolor\\033[0m"\nexport PATH="/opt/vault-terminal-extra:$PATH"\n');
    const got = await probeLoginPath("/bin/zsh", noisy).catch((e) => `error: ${e.message}`);
    check("a startup file that prints still gives a clean PATH", got.startsWith("/opt/vault-terminal-extra:") && !/junk|color|\x1b/.test(got), got.slice(0, 120));
    const hanging = zdot("hanging", "sleep 60\n");
    const t0 = Date.now();
    const hung = await probeLoginPath("/bin/zsh", hanging).then(() => "resolved", (e) => `rejected: ${e.message}`);
    const took = Date.now() - t0;
    check("a startup file that hangs is given up on in about 10 s", hung.startsWith("rejected") && took < 12000, `${hung} after ${took} ms`);
    const stop = new AbortController();
    const t1 = Date.now();
    const aborted = probeLoginPath("/bin/zsh", hanging, stop.signal).then(() => "resolved", (e) => `rejected: ${e.message}`);
    setTimeout(() => stop.abort(), 300);
    const result = await aborted;
    check("unloading stops the probe at once", result === "rejected: stopped" && Date.now() - t1 < 2000, `${result} after ${Date.now() - t1} ms`);
    const early = new AbortController();
    early.abort();
    const t2 = Date.now();
    const notStarted = await probeLoginPath("/bin/zsh", hanging, early.signal).then(() => "resolved", (e) => `rejected: ${e.message}`);
    check("a probe asked for after unloading doesn't start", notStarted === "rejected: stopped" && Date.now() - t2 < 200, notStarted);

    // Obsidian dying mid-probe: the probe's watchdog ends it and what its startup file started.
    const orphan = zdot("orphan", 'sleep 600 &\necho $! > "$ZDOTDIR/sleep.pid"\nwait\n');
    const dir = join(cwd, "orphan");
    const t3 = Date.now();
    execFileSync(process.execPath, [process.argv[1], "probe-then-die", dir], { env: orphan });
    const job = existsSync(join(dir, "sleep.pid")) ? Number(readFileSync(join(dir, "sleep.pid"), "utf8").trim()) : 0;
    const ended = job > 1 && (await waitFor(() => !alive(job), 20000));
    check("a probe whose Obsidian died is ended by its watchdog", ended, `job ${job}, ${ended ? "gone" : "still running"} after ${Date.now() - t3} ms`);
  }

  // zsh integration: the same startup files, in the same order, the same
  // ZDOTDIR and HISTFILE afterward (macOS's /etc/zshrc sets HISTFILE from
  // ZDOTDIR), as without it; plus the hooks where zsh reaches them. Each case
  // is a home folder of startup files that log their names.
  {
    const zsh = (home: string, extra: NodeJS.ProcessEnv, wrapped: boolean, interactive: boolean): string => {
      const base: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: home, TERM: "xterm-256color", ...extra };
      const env = wrapped ? zshIntegrationEnv(base) : base;
      const script = 'print -r -- "Z=${ZDOTDIR-unset} T=${VAULT_TERMINAL_ZDOTDIR-unset} S=${VAULT_TERMINAL_USER_ZDOTDIR_SET-unset} H=${HISTFILE-unset}"; (( $+functions[__vault_terminal_precmd] )) && print hooks; true';
      try {
        return execFileSync("/bin/zsh", interactive ? ["-l", "-i", "-c", script] : ["-l", "-c", script], { env, cwd: home, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch (e) {
        return `failed: ${(e as Error).message}`;
      }
    };
    const logLine = (name: string) => `print -r -- "${name} from \${ZDOTDIR-HOME}" >> "$HOME/order"\n`;
    const home = (name: string, files: Record<string, string>) => {
      const dir = join(cwd, `zsh-${name}`);
      mkdirSync(dir, { recursive: true });
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(join(dir, f, ".."), { recursive: true });
        writeFileSync(join(dir, f), text);
      }
      return dir;
    };
    const four = (prefix = "") => Object.fromEntries([".zshenv", ".zprofile", ".zshrc", ".zlogin"].map((f) => [`${prefix}${f}`, logLine(f)]));
    const execLine = `exec /bin/zsh -f -c 'print -r -- "exec Z=\${ZDOTDIR-unset} T=\${VAULT_TERMINAL_ZDOTDIR-unset}"'\n`;
    // name, files, environment, interactive, hooks expected
    const cases: [string, Record<string, string>, (dir: string) => NodeJS.ProcessEnv, boolean, boolean][] = [
      ["ZDOTDIR unset", four(), () => ({}), true, true],
      ["ZDOTDIR set", four("conf/"), (dir) => ({ ZDOTDIR: join(dir, "conf") }), true, true],
      ["ZDOTDIR empty", four(), () => ({ ZDOTDIR: "" }), true, true],
      ["a .zshenv that sets ZDOTDIR only when unset", { ...four("conf/"), ".zshenv": `[[ -z \${ZDOTDIR+x} ]] && ZDOTDIR="$HOME/conf"\n${logLine(".zshenv")}` }, () => ({}), true, true],
      ["a .zshenv that turns off later files", { ...four(), ".zshenv": `${logLine(".zshenv")}unsetopt RCS\n` }, () => ({}), true, false],
      ["a .zprofile that turns off later files", { ...four(), ".zprofile": `${logLine(".zprofile")}unsetopt RCS\n` }, () => ({}), true, false],
      ["a .zshrc that turns off later files", { ...four(), ".zshrc": `${logLine(".zshrc")}unsetopt RCS\n` }, () => ({}), true, true],
      ["a .zshrc that execs another program", { ...four(), ".zshrc": `${logLine(".zshrc")}${execLine}` }, () => ({}), true, false],
      ["a login shell that isn't interactive", four(), () => ({}), false, false],
    ];
    for (const [i, [name, files, extra, interactive, hooks]] of cases.entries()) {
      const plainDir = home(`${i}-plain`, files);
      const wrapDir = home(`${i}-wrapped`, files);
      const plain = zsh(plainDir, extra(plainDir), false, interactive).replaceAll(plainDir, "HOME");
      const wrapped = zsh(wrapDir, extra(wrapDir), true, interactive).replaceAll(wrapDir, "HOME");
      const order = (dir: string) => (existsSync(join(dir, "order")) ? readFileSync(join(dir, "order"), "utf8").replaceAll(dir, "HOME").trim().split("\n").join(", ") : "none");
      const withoutHooks = wrapped.split("\n").filter((l) => l !== "hooks").join("\n");
      const same = order(plainDir) === order(wrapDir) && withoutHooks === plain && wrapped.includes("hooks") === hooks;
      check(`zsh integration, ${name}: same files, order, ZDOTDIR and HISTFILE${hooks ? ", plus hooks" : ""}`, same, `\n       without: ${order(plainDir)} | ${plain}\n       with:    ${order(wrapDir)} | ${wrapped}`);
    }
  }

  // First size, output, and exit, through fd 3 as a single two-way channel.
  {
    const r = run(python.path, ["/bin/stty", "size"], 31, 97, cwd, env);
    const ready = await Promise.race([r.ready, sleep(5000).then(() => null)]);
    check("ready arrives on fd 3", !!ready);
    const exit = (await Promise.race([r.exited, sleep(5000).then(() => null)])) as ExitInfo | null;
    check("exit arrives on fd 3 with the code", exit?.code === 0, JSON.stringify(exit));
    check("first size reaches the program", r.output().includes("31 97"), JSON.stringify(r.output()));
  }

  // The window size's pixel fields: at the start, and after a resize.
  {
    const prog = "import fcntl, termios, struct, signal, time\ndef show(*a):\n    r, c, x, y = struct.unpack('HHHH', fcntl.ioctl(1, termios.TIOCGWINSZ, b'\\0' * 8))\n    print('WS', r, c, x, y, flush=True)\nsignal.signal(signal.SIGWINCH, show)\nshow()\ntime.sleep(3)";
    const r = run(python.path, [python.path, "-c", prog], 20, 70, cwd, env, { width: 546.2, height: 340 });
    await waitFor(() => r.output().includes("WS"), 5000);
    r.session.resize(20, 70, 600, 340);
    const after = await waitFor(() => r.output().includes("WS 20 70 600 340"), 5000);
    check("the window size carries the text area in pixels, rounded, and a pixel-only change is sent", r.output().includes("WS 20 70 546 340") && after, JSON.stringify(r.output()));
    r.session.close();
    await Promise.race([r.exited, sleep(5000)]);
  }

  // A terminal closed and another opened at once: the first's cleanup, which
  // ends everything on its tty, mustn't reach the second, which macOS may give
  // the same pty (found in testing).
  {
    const tags: string[] = [];
    let survived = true;
    for (let k = 0; k < 5; k++) {
      const a = run(python.path, ["/bin/sleep", "30"], 10, 40, cwd, env);
      const ra = await Promise.race([a.ready, sleep(5000).then(() => null)]);
      a.session.close();
      const b = run(python.path, ["/bin/sleep", "30"], 10, 40, cwd, env);
      const rb = await Promise.race([b.ready, sleep(5000).then(() => null)]);
      tags.push(`${ra?.tty ?? "?"}->${rb?.tty ?? "?"}`);
      await sleep(2500);
      if (!b.session.running || !rb || !alive(rb.pid)) survived = false;
      b.session.close();
      await Promise.race([b.exited, sleep(5000)]);
    }
    check("a terminal opened as another closes survives the first's cleanup, even on the same pty", survived, tags.join(" "));
  }

  // The exit message waits for the last output, even with output paused.
  {
    const prog = "import os\nfor i in range(40000): os.write(1, b'x' * 70 + b'\\n')\nos.write(1, b'LAST-LINE\\n')";
    let atExit = "";
    const chunks: Buffer[] = [];
    const exited = new Promise<void>((resolve) => {
      const session = new HelperSession(
        { id: "harness", python: python.path, program: [python.path, "-c", prog], cwd, env, rows: 24, cols: 80 },
        {
          data: (c) => chunks.push(Buffer.from(c)),
          exit: () => {
            atExit = Buffer.concat(chunks).toString("utf8");
            resolve();
          },
          error: () => resolve(),
        },
      );
      session.pause();
      setTimeout(() => session.resume(), 2000);
    });
    await Promise.race([exited, sleep(15000)]);
    check("exit comes after the last output, even when output was paused", atExit.trimEnd().endsWith("LAST-LINE"), `${atExit.length} bytes, ends ${JSON.stringify(atExit.slice(-20))}`);
  }

  // Resizes from Node reach the program. The program reports its size from
  // its main loop after each SIGWINCH, not from a signal handler: CPython
  // runs handlers reentrantly, so a handler interrupted between reading the
  // size and writing it could report an older size after the final one,
  // which is what failed about one run in ten.
  const sizeReporter = (fromHandler: boolean, delay = 0) =>
    fromHandler
      ? "import fcntl,os,signal,struct,termios,time\n" +
        `def h(*a):\n r,c=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8))[:2]; time.sleep(${delay}); os.write(1,('S %d %d\\n'%(r,c)).encode())\n` +
        "signal.signal(signal.SIGWINCH,h); os.write(1,b'R\\n')\nwhile True: time.sleep(1)"
      : // A handler first: on macOS a signal whose default is to be ignored is
        // dropped even while blocked, so sigwait would never see it.
        "import fcntl,os,signal,struct,termios\n" +
        "signal.signal(signal.SIGWINCH,lambda *a: None); signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGWINCH}); os.write(1,b'R\\n')\n" +
        "while True:\n signal.sigwait({signal.SIGWINCH})\n r,c=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8))[:2]; os.write(1,('S %d %d\\n'%(r,c)).encode())";
  // The cause, shown once: with the read and the write 2 ms apart in a
  // handler, storms end on a stale size; reporting from the loop, none do.
  // Logged, not checked: it's a property of the test program, not the code.
  {
    const storms = async (prog: string, n: number) => {
      let stale = 0;
      for (let k = 0; k < n; k++) {
        const r = run(python.path, [python.path, "-c", prog], 24, 80, cwd, env);
        await waitFor(() => r.output().includes("R\r\n"), 5000);
        for (let i = 0; i < 100; i++) r.session.resize(20 + i, 60 + i);
        await waitFor(() => r.output().includes("S 119 159"), 5000);
        await sleep(300);
        if (!r.output().trimEnd().endsWith("S 119 159")) stale++;
        r.session.close();
        await Promise.race([r.exited, sleep(6000)]);
      }
      return stale;
    };
    const handler = await storms(sizeReporter(true, 0.002), 10);
    const loop = await storms(sizeReporter(false), 10);
    console.log(`note a resize storm's last report, 10 storms each: from a handler with a 2 ms gap, ${handler} stale; from the main loop, ${loop} stale`);
  }
  {
    const prog = sizeReporter(false);
    const r = run(python.path, [python.path, "-c", prog], 24, 80, cwd, env);
    await waitFor(() => r.output().includes("R\r\n"), 5000);
    for (let i = 0; i < 100; i++) r.session.resize(20 + i, 60 + i);
    check("a resize storm ends at the last size", await waitFor(() => r.output().trimEnd().endsWith("S 119 159"), 5000), r.output().slice(-80));
    r.session.resize(0, 80);
    r.session.close();
    const exit = (await Promise.race([r.exited, sleep(6000).then(() => null)])) as ExitInfo | null;
    check("close ends the program", !!exit?.closed, JSON.stringify(exit));
  }

  // Close ends a background job in the shell.
  {
    const pidFile = join(cwd, "job");
    const r = run(python.path, ["/bin/zsh", "-f", "-i"], 24, 80, cwd, env);
    await sleep(500);
    r.session.write(`sleep 987654 & echo $! > '${pidFile}'\r`);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0, 5000);
    const job = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
    check("background job started", job > 1 && alive(job), String(job));
    r.session.close();
    await Promise.race([r.exited, sleep(6000)]);
    check("closing ends the background job", job > 1 && (await waitFor(() => !alive(job), 3000)), String(job));
    check("the helper itself is gone", await waitFor(() => r.session.child.exitCode !== null || r.session.child.signalCode !== null, 3000));
  }

  // A missing program is reported, not hung on.
  {
    const r = run(python.path, ["/nonexistent/vault-terminal"], 24, 80, cwd, env);
    const err = (await Promise.race([r.exited, sleep(5000).then(() => null)])) as StartError | null;
    check("a missing program is reported", err?.kind === "spawn", JSON.stringify(err));
  }

  // A missing Python is reported, not hung on.
  {
    const r = run("/nonexistent/python3", ["/bin/echo"], 24, 80, cwd, env);
    const err = (await Promise.race([r.exited, sleep(5000).then(() => null)])) as StartError | null;
    check("a missing Python is reported", err?.kind === "python", JSON.stringify(err));
  }

  // Agents get the login shell's environment, from a throwaway zsh setup.
  {
    const zdot = mkdtempSync(join(tmpdir(), "tl-zdot-"));
    writeFileSync(join(zdot, ".zshenv"), "export TL_ENV_A=1\n");
    writeFileSync(join(zdot, ".zprofile"), "export TL_ENV_B=1\npath=(/tl/login/bin $path)\n");
    writeFileSync(join(zdot, ".zlogin"), "unset TL_ENV_GONE\n");
    process.env.TL_ENV_GONE = "1";
    const base: NodeJS.ProcessEnv = { ...process.env, ZDOTDIR: zdot };
    delete base.TL_ENV_A;
    delete base.TL_ENV_B;
    const login = await probeLoginEnv("/bin/zsh", base);
    const shellPath = execFileSync("/bin/zsh", ["-l", "-i", "-c", "echo $PATH"], { env: base, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const env = agentEnv(login.PATH, login, "", "/tmp/somewhere");
    check("agent env: variables from .zshenv and .zprofile", env.TL_ENV_A === "1" && env.TL_ENV_B === "1", JSON.stringify([env.TL_ENV_A, env.TL_ENV_B]));
    check("agent env: PATH as an interactive login shell prints it", env.PATH === shellPath, `${env.PATH} vs ${shellPath}`);
    check("agent env: a variable the startup files unset isn't passed, though the app has it", env.TL_ENV_GONE === undefined && agentEnv(login.PATH, null, "", "/tmp").TL_ENV_GONE === "1");
    delete process.env.TL_ENV_GONE;
    check("agent env: PWD is the folder it starts in, and the probe's own variables aren't passed", env.PWD === "/tmp/somewhere" && env.VAULT_TERMINAL_ENV_PROBE === undefined && env.SHLVL === process.env.SHLVL);
    const own = agentEnv(login.PATH, login, "TL_ENV_A=mine\n# a comment\n\nNOT VALID=x\nTL_EMPTY=\nPATH=/only/mine", "/tmp");
    check("agent env: the setting's variables win over the login shell's", own.TL_ENV_A === "mine" && own.TL_EMPTY === "" && own.PATH === "/only/mine" && !("NOT VALID" in own));
    check("agent env: variables parsed as NAME=value lines", JSON.stringify(parseVariables("A=1\n B = two=2 \n#C=3\n=4\n9X=5")) === JSON.stringify([["A", "1"], ["B", " two=2"]]), JSON.stringify(parseVariables("A=1\n B = two=2 \n#C=3\n=4\n9X=5")));
    {
      // A startup file that leaves a job in the background, holding fd 3:
      // the answer is used when it's complete, not when the job ends.
      const zdot2 = mkdtempSync(join(tmpdir(), "tl-zdot-job-"));
      writeFileSync(join(zdot2, ".zshrc"), "export TL_ENV_JOB=1\nsleep 20 &\n");
      const t0 = Date.now();
      let got: Record<string, string> | null = null;
      try {
        got = await probeLoginEnv("/bin/zsh", { ...base, ZDOTDIR: zdot2 });
      } catch {
        // reported below
      }
      const ms = Date.now() - t0;
      check("agent env: a startup file's background job doesn't hold up the answer", got?.TL_ENV_JOB === "1" && ms < 5000, `${got ? "answered" : "failed"} after ${ms} ms`);
    }
    check("agent env: a value with a newline comes back whole", (await probeLoginEnv("/bin/zsh", { ...base, TL_MULTI: "a\nb" })).TL_MULTI === "a\nb");
  }

  // The helper tests leave nothing behind when a check fails or the run is
  // stopped: every process a run starts carries its tag,
  // and here ps, not the tests' own cleanup code, looks for it afterward.
  {
    const leftovers = (tag: string) =>
      execFileSync("/bin/ps", ["-axE", "-ww", "-o", "pid=,command="], { encoding: "utf8" })
        .split("\n")
        .filter((l) => l.includes(`VAULT_TERMINAL_TEST_RUN=${tag}`) && !l.includes("/bin/ps"))
        .map((l) => l.trim().split(/\s+/)[0]);
    const helperTest = join(process.cwd(), "test", "helper_test.py");
    const one = "HelperTest.test_close_ends_everything_the_program_started";
    const failTag = `tl-harness-fail-${process.pid}`;
    let failed = false;
    try {
      execFileSync("python3", ["-I", helperTest, one], { env: { ...process.env, TL_FAIL_ON_PURPOSE: "1", TL_RUN_TAG: failTag }, stdio: "pipe" });
    } catch {
      failed = true;
    }
    await new Promise((r) => setTimeout(r, 1500));
    const afterFail = leftovers(failTag);
    check("helper tests: a check that fails leaves nothing running", failed && afterFail.length === 0, `failed=${failed}, left ${afterFail.join(" ")}`);
    const intTag = `tl-harness-int-${process.pid}`;
    const child = spawn("python3", ["-I", helperTest, one], { env: { ...process.env, TL_FAIL_ON_PURPOSE: "wait", TL_RUN_TAG: intTag }, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    child.stdout!.on("data", (d: Buffer) => (said += d.toString()));
    const running = await waitFor(() => said.includes("FAMILY-RUNNING"), 15000);
    const before = leftovers(intTag).length;
    child.kill("SIGINT");
    await new Promise((r) => child.once("exit", r));
    await new Promise((r) => setTimeout(r, 1500));
    const afterInt = leftovers(intTag);
    check("helper tests: Ctrl+C partway leaves nothing running", running && before >= 5 && afterInt.length === 0, `running=${running}, ${before} tagged before, left ${afterInt.join(" ")}`);
  }

  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

// --- the seams a host uses (Agent Manager's controller, host.ts), no pty needed ---

function seamChecks(): void {
  // The stripped variables: out after the setting's own are merged, whoever set them.
  {
    const login = { ANTHROPIC_API_KEY: "sk-login", KEEP_ME: "1", OPENAI_BASE_URL: "http://x" };
    const strip = parseNames(DEFAULT_STRIPPED_VARIABLES);
    const env = agentEnv("/usr/bin:/bin", login, "GEMINI_API_KEY=mine\nCLAUDE_CODE_USE_BEDROCK=1\nMY_OWN=2", "/tmp", strip);
    check("seams: the default list strips the API keys and provider switches, the login shell's and the setting's alike", env.ANTHROPIC_API_KEY === undefined && env.OPENAI_BASE_URL === undefined && env.GEMINI_API_KEY === undefined && env.CLAUDE_CODE_USE_BEDROCK === undefined, JSON.stringify(env));
    check("seams: everything else stays", env.KEEP_ME === "1" && env.MY_OWN === "2" && env.PATH === "/usr/bin:/bin" && env.PWD === "/tmp");
    const keep = agentEnv("/usr/bin", null, "", "/tmp", ["PATH", "PWD"]);
    check("seams: PATH and PWD are never stripped", keep.PATH === "/usr/bin" && keep.PWD === "/tmp");
    check("seams: the default list has its ten names", strip.length === 10 && strip.includes("CODEX_API_KEY") && strip.includes("CLAUDE_CODE_USE_VERTEX"), strip.join(" "));
    check("seams: names parse one per line, or by spaces and commas, comments skipped", JSON.stringify(parseNames("A_1\n B, C  # D\n#E\n9X bad-name A_1")) === JSON.stringify(["A_1", "B", "C"]), JSON.stringify(parseNames("A_1\n B, C  # D\n#E\n9X bad-name A_1")));
  }
  // A host's arguments are part of the command, never additions the retry drops.
  {
    const home = mkdtempSync(join(tmpdir(), "am-seam-"));
    const id = "0b9e7c52-1111-4222-8333-444455556666";
    const words = ["claude", "-n", "Weekly plan", "--session-id", id, "--add-dir", "/x", "--agent", "helper"];
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: home };
    const added = prepareAgent("claude", "/usr/local/bin/claude", words, { env, cwd: home, pictures: true }, false);
    check("seams: the terminal's additions are named, the host's never", added.includes("--settings") && !added.some((a) => ["-n", "--session-id", "--add-dir", "--agent"].includes(a)), added.join(" "));
    check("seams: the host's arguments stay in order, the terminal's settings after them", words.slice(1, 9).join(" ") === `-n Weekly plan --session-id ${id} --add-dir /x --agent helper` && words[9] === "--settings", words.slice(0, 10).join(" "));
    const plainWords = ["claude", "-r", id];
    const plainEnv: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: home };
    const none = prepareAgent("claude", "/usr/local/bin/claude", plainWords, { env: plainEnv, cwd: home, pictures: true }, true);
    check("seams: plain adds nothing, and the resume stays", none.length === 0 && plainWords.join(" ") === `claude -r ${id}` && Object.keys(plainEnv).length === 1, JSON.stringify({ none, plainWords, plainEnv }));
    const codex = ["codex", "resume", id];
    check("seams: Codex gets no additions", prepareAgent("codex", "/x/codex", codex, { env: {}, cwd: home, pictures: true }, false).length === 0 && codex.join(" ") === `codex resume ${id}`);
    rmSync(home, { recursive: true, force: true });
  }
  // Ctrl+C: copies a selection unless the setting says always interrupt; never with nothing selected.
  {
    const k = (over: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key: "c", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...over });
    check("seams: Ctrl+C with a selection copies, by default", ctrlCCopies(k(), true, false));
    check("seams: Ctrl+C with nothing selected interrupts", !ctrlCCopies(k(), false, false));
    check("seams: Ctrl+C always interrupts with the setting on", !ctrlCCopies(k(), true, true));
    check("seams: Ctrl+Shift+C, Cmd+C and Ctrl+Option+C aren't this", !ctrlCCopies(k({ shiftKey: true, key: "C" }), true, false) && !ctrlCCopies(k({ metaKey: true }), true, false) && !ctrlCCopies(k({ altKey: true }), true, false));
    check("seams: Ctrl+C with Caps Lock on still copies", ctrlCCopies(k({ key: "C" }), true, false));
  }
  // After the program ends: S never starts a shell in a host's terminal.
  check("seams: after exit, Enter restarts and S starts a shell in a plain terminal", afterExitKey("\r", false) === "restart" && afterExitKey("s", false) === "shell" && afterExitKey("S", false) === "shell" && afterExitKey("x", false) === "nothing");
  check("seams: after exit in a host's terminal, S does nothing and Enter is the host's", afterExitKey("s", true) === "nothing" && afterExitKey("S", true) === "nothing" && afterExitKey("\r", true) === "restart");
  // The close confirm says why: unsent text is a reason of its own.
  {
    const one = closeText([{ agent: true, name: "Notes", draft: true }]);
    check("seams: one tab with unsent text says so, not that its agent is working", /text you haven't sent/.test(one.text) && !/working/.test(one.text) && one.title === "Close this terminal?", one.text);
    const busy = closeText([{ agent: true, name: "Claude" }]);
    check("seams: one working agent reads as before", busy.text === "Its agent is working or waiting for you. Closing ends it.", busy.text);
    const mixed = closeText([{ agent: true, name: "A" }, { agent: true, name: "B", draft: true }, { agent: false, name: "vim" }]);
    check("seams: several name the running and the unsent apart", mixed.title === "Close 3 terminals?" && mixed.text === "Still running: A, vim. Text you haven't sent: B. Closing ends them.", mixed.text);
    const agents = closeText([{ agent: true, name: "A" }, { agent: true, name: "B" }]);
    check("seams: several agents alone read as before", agents.text === "Still running: A, B. Closing ends these agents.", agents.text);
  }
  // A note's vault path a dozen words long is one link (it once stopped at nine).
  {
    const note = "Home/Garden and Yard Work/Spring Planting Plans/Notes/Order the seeds from the big spring catalog.md";
    const found = findPaths(`Note: ${note} (open)`, (p) => p === note);
    check("seams: a note path of thirteen words links whole", found.length === 1 && found[0].path === note, JSON.stringify(found));
  }
}

// --- pictures: kitty.ts, no pty needed ---

function makePng(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function kittyChecks(): void {
  const enc = (s: string) => Buffer.from(s, "latin1");
  const apc = (body: string) => `\x1b_G${body}\x1b\\`;
  const texts = (ps: Piece[]) => ps.map((p) => (p.kind === "text" ? Buffer.from(p.bytes).toString("latin1") : p.kind === "graphics" ? `[G${p.body}]` : `[x:${p.why}]`)).join("");
  {
    const stream = `a${apc("a=q,i=1;AAAA")}b\x1b[31mc`;
    const whole = texts(new GraphicsFilter(1000, false).push(enc(stream)));
    const f = new GraphicsFilter(1000, false);
    const bytes = enc(stream);
    const parts: Piece[] = [];
    for (let k = 0; k < bytes.length; k++) parts.push(...f.push(bytes.subarray(k, k + 1)));
    check("pictures: a command split byte by byte is found whole, the text around it kept", whole === `a[Ga=q,i=1;AAAA]b\x1b[31mc` && texts(parts) === whole, JSON.stringify([whole, texts(parts)]));
  }
  for (const [name, cut] of [["CAN", "\x18"], ["SUB", "\x1a"], ["another escape", "\x1b[0m"]] as const) {
    const out = texts(new GraphicsFilter(1000, false).push(enc(`${"\x1b_Ga=T,f=24,s=1,v=1;AAA"}${cut}after`)));
    check(`pictures: a command cut short by ${name} is dropped, and the text after it shows`, !out.includes("[G") && out.endsWith("after") && !out.includes("AAA"), JSON.stringify(out));
  }
  {
    const out = texts(new GraphicsFilter(100, false).push(enc(`x\x1b_Ga=T;${"A".repeat(500)}\x1b\\after`)));
    check("pictures: a command past the size limit is dropped whole, and text after it shows", out === "x[x:size]after", JSON.stringify(out.slice(0, 80)));
  }
  {
    const out = texts(new GraphicsFilter(1000, true).push(enc(`\x1b[38;5;42m${Buffer.from("\u{10EEEE}̅̅\u{10EEEE}̅̍", "utf8").toString("latin1")} x`)));
    check("pictures: a placeholder run is wrapped in the terminal's link, so xterm keeps its underline color", out.includes(`\x1b]8;id=vault-terminal-picture;${PICTURE_LINK}\x1b\\`) && /\x1b\]8;;\x1b\\ x$/.test(out), JSON.stringify(out));
    const own = texts(new GraphicsFilter(1000, true).push(enc(`\x1b]8;;https://e.x\x1b\\${Buffer.from("\u{10EEEE}", "utf8").toString("latin1")}`)));
    check("pictures: inside the program's own link, nothing is added", !own.includes("vault-terminal-picture"), JSON.stringify(own));
    // Switched off right after a placeholder run: the link is closed, and a draining filter adds none.
    const f = new GraphicsFilter(1000, true);
    f.push(enc(Buffer.from("\u{10EEEE}", "utf8").toString("latin1")));
    const closed = f.closeLink();
    f.draining = true;
    const after = texts(f.push(enc(`${Buffer.from("\u{10EEEE}", "utf8").toString("latin1")}x`)));
    check("pictures: switching off closes an open picture link, and a draining filter opens none", !!closed && f.closeLink() === null && !after.includes("vault-terminal-picture"), JSON.stringify(after));
  }

  const replies: string[] = [];
  const logs: string[] = [];
  const opened: string[] = [];
  let inUse = new Set<number>();
  const g = (limit?: number, cap?: number) => new KittyGraphics({ reply: (s) => replies.push(s), log: (e) => logs.push(e), opened: (p) => opened.push(p), inUse: (ids) => new Set(ids.filter((id) => inUse.has(id))) }, limit, cap);
  const last = () => replies[replies.length - 1] ?? "";
  {
    const k = g();
    k.handle("i=31,s=1,v=1,a=q,t=d,f=24;AAAA");
    check("pictures: kitty's query probe gets OK under its id, and nothing is stored (75)", last() === "\x1b_Gi=31;OK\x1b\\" && k.images.size === 0, JSON.stringify(replies));
    k.handle("a=T,U=1,i=31,f=24,s=1,v=1,c=1,r=1,q=2;AAAA");
    k.handle("i=31,s=2,v=1,a=q,t=d,f=24;AAAAAAAA");
    check("pictures: a query never replaces an existing image with its id", k.images.get(31)?.width === 1 && k.placements.get(31)?.size === 1);
    replies.length = 0;
    k.handle("i=32,s=1,v=1,a=q,t=d,f=24;!!!!");
    check("pictures: invalid data gets an error reply", /^\x1b_Gi=32;E/.test(last()), JSON.stringify(replies));
    replies.length = 0;
    k.handle("i=33,s=1,v=1,a=q,f=24,q=1;AAAA");
    k.handle("i=34,s=1,v=1,a=q,f=24,q=1;!!!!");
    k.handle("i=35,s=1,v=1,a=q,f=24,q=2;!!!!");
    k.handle("i=36,s=1,v=1,a=q,f=24,q=2;AAAA");
    check("pictures: q=1 keeps errors only, q=2 keeps nothing", replies.length === 1 && replies[0].startsWith("\x1b_Gi=34;E"), JSON.stringify(replies));
  }
  {
    const dir = mkdtempSync(join(tmpdir(), "tl-kitty-"));
    const good = join(dir, "good.png");
    writeFileSync(good, makePng(4, 2));
    const link = join(dir, "link.png");
    symlinkSync(good, link);
    const loopA = join(dir, "loopA");
    symlinkSync(join(dir, "loopB"), loopA);
    symlinkSync(loopA, join(dir, "loopB"));
    const fifo = join(dir, "pipe");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const noRead = join(dir, "noread.png");
    writeFileSync(noRead, makePng(1, 1));
    chmodSync(noRead, 0);
    const short = join(dir, "short.rgb");
    writeFileSync(short, Buffer.alloc(5));
    const b64 = (p: string) => Buffer.from(p, "utf8").toString("base64");
    const k = g();
    const answer = (keys: string, path: string) => {
      replies.length = 0;
      k.handle(`${keys};${b64(path)}`);
      return replies[0] ?? "";
    };
    const okGood = answer("a=q,i=1,t=f,f=100", good);
    const okLink = answer("a=q,i=1,t=f,f=100", link);
    opened.length = 0;
    const errors = [
      answer("a=q,i=1,t=f,f=100", join(dir, "missing.png")),
      answer("a=q,i=1,t=f,f=100", dir),
      answer("a=q,i=1,t=f,f=100", "/dev/zero"),
      answer("a=q,i=1,t=f,f=100", fifo),
      answer("a=q,i=1,t=f,f=100", loopA),
      answer("a=q,i=1,t=f,f=100", noRead),
      answer("a=q,i=1,t=f,f=24,s=2,v=1,S=6", short),
    ];
    check("pictures: a readable file and a symlink to one draw (76)", okGood === "\x1b_Gi=1;OK\x1b\\" && okLink === okGood, JSON.stringify([okGood, okLink]));
    check("pictures: missing, folder, /dev/zero, pipe, loop, unreadable and short files all get one identical error", errors.every((e) => e === `\x1b_Gi=1;${READ_ERROR}\x1b\\`), JSON.stringify(errors));
    check("pictures: /dev/zero and the pipe were never opened", !opened.includes("/dev/zero") && !opened.includes(fifo), JSON.stringify(opened));
    {
      // A symlink into a refused folder is refused by where it leads, before anything opens it.
      const toRun = join(dir, "run.png");
      symlinkSync("/private/var/run/utmpx", toRun);
      opened.length = 0;
      const r = answer("a=q,i=1,t=f,f=100", toRun);
      check("pictures: a symlink into /private/var/run is refused, and never opened", r === `\x1b_Gi=1;${READ_ERROR}\x1b\\` && !opened.length, JSON.stringify([r, opened]));
      const marked = join(dir, "tty-graphics-protocol-z.png");
      const target = tempToDelete(marked);
      check("pictures: a temporary file is deleted by its folder's real path", target === join(realpathSync(dir), "tty-graphics-protocol-z.png"), String(target));
    }
    // Temporary files: deleted only in a temporary folder and with the marker in the path.
    const tmpBoth = join(dir, "tty-graphics-protocol-a.png");
    const tmpNoMark = join(dir, "plain.png");
    const home = mkdtempSync(join(process.cwd(), ".build", "tl-kitty-"));
    const notTmp = join(home, "tty-graphics-protocol-b.png");
    const plainNotTmp = join(home, "plain.png");
    for (const p of [tmpBoth, tmpNoMark, notTmp, plainNotTmp]) writeFileSync(p, makePng(1, 1));
    for (const p of [tmpBoth, tmpNoMark, notTmp, plainNotTmp]) answer("a=q,i=1,t=t,f=100", p);
    check("pictures: a temporary file is deleted only in a temporary folder with the marker in its path", !existsSync(tmpBoth) && existsSync(tmpNoMark) && existsSync(notTmp) && existsSync(plainNotTmp), JSON.stringify([tmpBoth, tmpNoMark, notTmp, plainNotTmp].map(existsSync)));
    chmodSync(noRead, 0o600);
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
  {
    const k = g();
    replies.length = 0;
    const data = Buffer.alloc(3 * 4 * 4, 7).toString("base64");
    const [a, b, c] = [data.slice(0, 20), data.slice(20, 40), data.slice(40)];
    k.handle(`a=T,U=1,i=5,f=24,s=4,v=4,c=2,r=2,m=1;${a}`);
    k.handle(`m=1;${b}`);
    const before = k.images.size;
    k.handle(`m=0;${c}`);
    check("pictures: a picture in three chunks is stored only after the last (76)", before === 0 && k.images.get(5)?.width === 4 && last() === "\x1b_Gi=5;OK\x1b\\", JSON.stringify(replies));
    replies.length = 0;
    k.handle(`a=T,U=1,i=6,f=24,s=4,v=4,m=1;${a}`);
    k.handle(`m=0;!!!!`);
    check("pictures: a malformed chunk gets an error and stores nothing", !k.images.has(6) && /^\x1b_Gi=6;E/.test(last()), JSON.stringify(replies));
    k.handle(`a=T,U=1,i=7,f=24,s=4,v=4,m=1;${a}`);
    k.handle("a=d,d=i,i=99");
    k.handle(`m=0;${c}`);
    check("pictures: a delete mid-upload aborts it", !k.images.has(7), JSON.stringify(logs.slice(-3)));
    replies.length = 0;
    // "A" then "AAA" is base64 only when joined: each chunk is checked alone.
    k.handle(`a=T,U=1,i=8,f=24,s=1,v=1,m=1;A`);
    k.handle(`m=0;AAA`);
    check("pictures: a chunk that isn't whole base64 by itself gets an error", !k.images.has(8) && /^\x1b_Gi=8;E/.test(last()), JSON.stringify(replies));
    replies.length = 0;
    const small = new KittyGraphics({ reply: (s) => replies.push(s), log: (e) => logs.push(e) }, 4 * 4 * 4);
    small.handle(`a=T,U=1,i=11,f=24,s=4,v=4,m=1;${a}`);
    for (let n = 0; n < 2000; n++) small.handle("m=1;");
    small.handle(`m=0;${c}`);
    check("pictures: empty chunks count against the limit, so they can't pile up", !small.images.has(11) && /^\x1b_Gi=11;EBADF/.test(replies[0] ?? ""), JSON.stringify(replies.slice(0, 2)));
    k.handle(`a=T,U=1,i=12,f=24,s=4,v=4,m=1;${a}`);
    k.cancelled("CAN");
    k.handle(`m=0;${c}`);
    check("pictures: a cancelled chunk cancels its upload", !k.images.has(12), JSON.stringify(logs.slice(-2)));
  }
  {
    // A PNG that doesn't load gets an error, the query included (75, 76).
    const k = g();
    replies.length = 0;
    const png = makePng(4, 4);
    k.handle(`a=q,i=41,f=100;${png.toString("base64")}`);
    k.handle(`a=q,i=42,f=100;${png.subarray(0, 40).toString("base64")}`);
    k.handle(`a=T,U=1,i=43,f=100,q=1;${png.subarray(0, png.length - 14).toString("base64")}`);
    const kept = k.images.get(43);
    const quiet = replies.length;
    // Sent, it's loaded when decoded, off the main thread: a failure then drops it, with the error.
    if (kept) k.failedToLoad(kept);
    check(
      "pictures: a truncated PNG is refused by the query at once, and when sent, once its decode fails; a whole one loads",
      replies[0] === "\x1b_Gi=41;OK\x1b\\" && /^\x1b_Gi=42;EBADPNG/.test(replies[1] ?? "") && !!kept && quiet === 2 && /^\x1b_Gi=43;EBADPNG/.test(replies[2] ?? "") && !k.images.has(43) && !k.placements.has(43),
      JSON.stringify(replies),
    );
  }
  {
    // Raw pixels: only the pixels are kept, and both copies count.
    const k = g();
    k.handle(`a=t,i=44,f=32,s=1,v=1,q=2;${Buffer.alloc(4096).toString("base64")}`);
    const img = k.images.get(44);
    check("pictures: raw pixels keep exactly their bytes, counted twice with the picture's own cost", img?.rgba?.buffer.byteLength === 4 && k.stored === IMAGE_COST + 8, JSON.stringify({ kept: img?.rgba?.buffer.byteLength, stored: k.stored }));
    for (let n = 1; n <= PLACEMENTS_KEPT + 500; n++) k.handle(`a=p,U=1,i=44,p=${n},c=1,r=1,q=2`);
    check("pictures: a picture's placements are capped, the oldest going first, and each counts", k.placements.get(44)?.size === PLACEMENTS_KEPT && !k.placements.get(44)?.has(1) && k.stored === IMAGE_COST + 8 + PLACEMENTS_KEPT * PLACEMENT_COST, JSON.stringify({ n: k.placements.get(44)?.size, stored: k.stored }));
    k.handle("a=d,d=i,i=44");
    check("pictures: deleting them gives their cost back", k.stored === IMAGE_COST + 8, String(k.stored));
  }
  {
    // The size limit, with a small fixed value: checked before anything is decoded.
    const limit = 4 * 10 * 10;
    const k = g(limit);
    replies.length = 0;
    const big = makePng(11, 10).toString("base64");
    const fits = makePng(10, 10).toString("base64");
    k.handle(`a=T,U=1,i=1,f=100;${big}`);
    k.handle(`a=T,U=1,i=2,f=24,s=11,v=10;${Buffer.alloc(3 * 110).toString("base64")}`);
    const refused = replies.slice();
    const decodedBefore = k.counts.decodedChecks;
    k.handle(`a=T,U=1,i=3,f=100;${fits}`);
    k.handle(`a=T,U=1,i=4,f=24,s=10,v=10;${Buffer.alloc(3 * 100).toString("base64")}`);
    check(
      "pictures: a PNG and an RGB picture just over the limit are refused from the size check, before decoding; just under, stored (76)",
      refused.length === 2 && refused.every((r) => r.endsWith(`;${READ_ERROR}\x1b\\`)) && k.counts.refusedForSize === 2 && decodedBefore === 0 && k.images.has(3) && k.images.has(4),
      JSON.stringify({ refused, n: k.counts.refusedForSize, decodedBefore }),
    );
  }
  {
    const k = g();
    const px = Buffer.alloc(3).toString("base64");
    k.handle(`a=T,U=1,i=9,f=24,s=1,v=1,c=2,r=1,q=2;${px}`);
    k.handle(`a=p,U=1,i=9,p=2,c=4,r=2,q=2`);
    k.handle(`a=t,i=9,f=24,s=1,v=1,q=2;${px}`);
    check("pictures: re-sent data under an id drops the old image's placements (79)", k.images.has(9) && !k.placements.has(9));
    k.handle(`a=T,U=1,i=9,f=24,s=1,v=1,c=3,r=1,q=2;${px}`);
    check("pictures: a combined a=T,U=1 recreates the placement", k.placements.get(9)?.get(0)?.cols === 3);
    replies.length = 0;
    k.handle("a=d,d=i,i=9");
    k.handle("a=p,U=1,i=9,c=1,r=1");
    check("pictures: a lowercase delete keeps the data, and a new placement draws without re-sending", k.images.has(9) && last() === "\x1b_Gi=9;OK\x1b\\", JSON.stringify(replies));
    k.handle("a=d,d=I,i=9");
    replies.length = 0;
    k.handle("a=p,U=1,i=9,c=1,r=1");
    check("pictures: an uppercase delete of an image no longer in use frees it: a new placement gets ENOENT", !k.images.has(9) && /^\x1b_Gi=9;ENOENT/.test(last()), JSON.stringify(replies));
    k.handle(`a=T,U=1,i=10,p=1,f=24,s=1,v=1,c=1,r=1,q=2;${px}`);
    k.handle("a=p,U=1,i=10,p=2,c=2,r=2,q=2");
    k.handle("a=d,d=i,i=10,p=1");
    check("pictures: a placement-specific delete leaves the other placement", k.placements.get(10)?.size === 1 && k.placements.get(10)?.has(2) === true);
    k.handle("a=d");
    k.handle("a=d,d=A");
    k.handle("a=d,d=c");
    check("pictures: position-based deletes leave virtual placements working", k.placements.get(10)?.has(2) === true && k.images.has(10));
    inUse = new Set([10]);
    k.handle("a=d,d=I,i=10");
    check("pictures: an uppercase delete keeps the data while cells still show the image", k.images.has(10) && !k.placements.has(10));
    inUse = new Set();
    k.sweep();
    check("pictures: and frees it once no cells show it", !k.images.has(10) && k.pendingFree.size === 0);
    k.handle(`a=T,U=1,i=10,f=24,s=1,v=1,c=1,r=1,q=2;${px}`);
    k.handle("a=d,d=R,x=1,y=100");
    check("pictures: d=R frees a range of ids", !k.images.has(10));
  }
  {
    // The cap, small: unplaced pictures go first, then the least recently drawn.
    // Each 4x4 RGB picture: 128 bytes of pixels, its own cost, and a placement's.
    const k = g(undefined, 3 * (128 + IMAGE_COST + PLACEMENT_COST));
    const px = Buffer.alloc(16 * 3).toString("base64");
    k.handle(`a=t,i=1,f=24,s=4,v=4,q=2;${px}`);
    k.handle(`a=T,U=1,i=2,f=24,s=4,v=4,c=1,r=1,q=2;${px}`);
    k.handle(`a=T,U=1,i=3,f=24,s=4,v=4,c=1,r=1,q=2;${px}`);
    k.handle(`a=T,U=1,i=4,f=24,s=4,v=4,c=1,r=1,q=2;${px}`);
    check("pictures: past the cap, an image with no placement goes first (81)", !k.images.has(1) && k.images.has(2) && k.stored <= k.cap, JSON.stringify([...k.images.keys()]));
    k.handle(`a=T,U=1,i=5,f=24,s=4,v=4,c=1,r=1,q=2;${px}`);
    check("pictures: then the oldest, never the newest", !k.images.has(2) && k.images.has(5) && k.stored <= k.cap, JSON.stringify([...k.images.keys()]));
  }
  {
    const c = (fg: number, ul = -1) => ({ fg, underline: ul });
    const a = readPlaceholder([0, 0], c(42), null);
    const b = readPlaceholder([], c(42), a);
    const r1 = readPlaceholder([1], c(42), null);
    const r2 = readPlaceholder([1], c(42), r1);
    const top = readPlaceholder([0, 0, 2], c(42), null);
    const top2 = readPlaceholder([0, 1], c(42), top);
    const changed = readPlaceholder([], c(43), a);
    const otherUl = readPlaceholder([], c(42, 7), a);
    const otherRow = readPlaceholder([1], c(42), a);
    const gap = readPlaceholder([0, 5], c(42), top);
    check(
      "pictures: placeholder marks and kitty's three inheritance rules (77)",
      b.row === 0 && b.col === 1 && r2.row === 1 && r2.col === 1 && top.id === 42 + 2 * 0x1000000 && top2.id === top.id && changed.col === 0 && changed.id === 43 && otherUl.col === 0 && otherUl.placement === 7 && otherRow.col === 0 && gap.id === 42,
      JSON.stringify({ b, r2, top: top.id, top2: top2.id, changed: changed.col, otherUl: otherUl.col, otherRow: otherRow.col, gap: gap.id }),
    );
    check("pictures: diacritics table has kitty's 297 marks, U+0305 first", DIACRITICS.length === 297 && diacriticValue(0x305) === 0 && diacriticValue(0x30d) === 1 && diacriticValue(0x41) === undefined);
    const text = `ab\u{10EEEE}̅̅\u{10EEEE}̅̍cd e̅ f`;
    const line = `x\u{10EEEE}\u0305\u030D y e\u030D`;
    const hits = [...line.matchAll(new RegExp(findPattern("\u030D")!, "gi"))].map((m) => m.index);
    check("pictures: find never matches a mark inside a picture's cells, and finds it after a letter (82)", JSON.stringify(hits) === JSON.stringify([line.lastIndexOf("\u030D")]) && findPattern("word") === null, JSON.stringify(hits));
    check("pictures: copied text drops placeholders and their marks, and keeps a letter's own mark (82)", withoutPlaceholders(text) === "abcd e̅ f", JSON.stringify(withoutPlaceholders(text)));
  }
}

void main();
