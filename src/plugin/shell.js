// Running claude outside a terminal: its background-agent roster.

import { import_child_process } from "../externals.js";
var ShellMethods = class {
  // The claude the terminal's settings name (Command, Location) with an agent's
  // environment, so a session and the plugin's own calls run the same claude.
  async runClaude(args, timeoutMs = 8000) {
    const found = this.terminal ? await this.terminal.agentProgram("claude") : { error: "the terminal isn't loaded" };
    if (found.error) throw new Error(found.error);
    return new Promise((resolve, reject) => {
      (0, import_child_process.execFile)(found.program, args, { env: found.env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || "").trim() || `claude ${args.join(" ")} failed`));
        resolve(String(stdout || ""));
      });
    });
  }
  // `claude agents --json [--cwd <path>]` as objects: {pid, id (short), kind
  // (background|interactive), cwd, sessionId, name, status, state, startedAt}. `--cwd`
  // limits to sessions started under the path. Shape checked on Claude 2.1.x.
  async listClaudeAgents(cwd) {
    const args = ["agents", "--json"];
    if (cwd) args.push("--cwd", cwd);
    const out = await this.runClaude(args);
    let parsed;
    try { parsed = JSON.parse(out); } catch { return []; }
    return Array.isArray(parsed) ? parsed : [];
  }
  // One `claude agents --json` for every caller within a few seconds: a reload restores
  // all its Claude tabs at once, and each asks before resuming.
  listClaudeAgentsShared() {
    const now = Date.now();
    if (!this._agentsShared || now - this._agentsShared.at > 5000) {
      const promise = this.listClaudeAgents();
      this._agentsShared = { at: now, promise };
      promise.catch(() => { if (this._agentsShared?.promise === promise) this._agentsShared = null; });
    }
    return this._agentsShared.promise;
  }
};
export { ShellMethods };
