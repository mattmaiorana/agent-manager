
import type { ResolvedReach, ScheduledTask } from "./task-model.js";

export type ReachFact = [string, string[]];

export function reachFacts(t: ScheduledTask, r: ResolvedReach, backendLabel: string): ReachFact[] {
  const outside = new Set(t.places.map((p) => p.path));
  const reads = r.read.includes("/") ? ["The whole disk, apart from what's never read"] : [
    r.cwd, ...r.read.filter((p) => !outside.has(p)),
    ...r.writesTo.map((p) => `${p} (it can change this one)`),
    ...r.read.filter((p) => outside.has(p)).map((p) => `${p} (outside the vault)`),
  ];
  if (r.mode === "full") {
    const web = r.web.search ? ["Web search, and any page"] : r.web.sites.length ? [...r.web.sites.map((s) => `${s}, and its subdomains`), ...(r.listNote ? [`Read from ${r.listNote}: an edit asks for approval again`] : []), "No web search; its shell reaches only these"] : ["None, its shell included"];
    const rows: ReachFact[] = [
      ["Mode", ["Full session: a Claude Code session in a tab, in auto mode, with your own settings, hooks, skills, and MCP servers. It reads and changes what any session of yours can."]],
      ["Runs on", [r.model ? `${backendLabel}, ${r.model}` : backendLabel]],
      ["Agent profile", [r.agent || "None"]],
      ["Starts in", [r.cwd]],
      ...(r.reads.length ? [["Reads first", r.reads]] as ReachFact[] : []),
      ["Schedule", [r.schedule || "None"]],
      ["Web", web],
      ["Connectors", [r.connectors === "none" ? "None: no MCP servers or connectors at all" : "On, for reading and drafts: sending, replying, forwarding, sharing, scheduling, deleting, and Claude in Chrome are refused"]],
      ["Refused", ["The Keychain's password commands", ...(r.deny.length ? [`And the tools it denies: ${r.deny.join(", ")}`] : [])]],
      ...(r.neverRead.length ? [["Never reads", [neverWords(r)]] as ReachFact] : []),
      ["Results go in", [r.output]],
      ...(t.followUp === "ticket" ? [["Follow-up", ["Each result is added to the task's open follow-up ticket, or a new one"]] as ReachFact] : []),
      ["Each run", [r.eachRun === "continue" ? "Continues the last run's session, which carries what earlier runs read (web pages included) into later ones" : "A new session"]],
    ];
    if (r.prompt != null) rows.push(["Prompt", [r.prompt]]);
    if (r.humanNotes) rows.push(["Human Notes", [r.humanNotes]]);
    return rows.filter(([, v]) => v.length);
  }
  const rows: ReachFact[] = [
    ["Runs on", [r.model ? `${backendLabel}, ${r.model}` : backendLabel]],
    ["Agent profile", [r.agent || "None"]],
    ["Web", r.web.search ? ["Web search, and any page"] : r.web.sites.length ? r.web.sites.map((s) => `${s}, and its subdomains`) : ["None"]],
    ["Reads", t.files === "none" && !r.read.length ? [`Its own folder only: ${r.cwd}`, ...(r.shell ? ["Its shell reads this computer (below)"] : [])] : reads],
    ["Never reads", [`${r.neverRead.length} places: credentials, other apps' and plugins' settings, other sessions, and the setting's own`]],
    ["Tools", [r.tools.join(", ")]],
    ...(r.writesTo.length ? [["Changes", r.writesTo.map((p) => `${p} (its shell can move, rename, or delete what's here)`)] as ReachFact] : []),
    ...(r.shell ? [["Shell", ["Sandboxed by macOS: no network, no writes outside the folders it changes, and nothing on the never-read list; the Keychain's command refused by name. It reads the rest of this computer."]] as ReachFact] : []),
    ["Writes", [r.writes]],
    ["Results go in", [r.output]],
    ...(t.followUp === "ticket" ? [["Follow-up", ["Each result is added to the task's open follow-up ticket, or a new one"]] as ReachFact] : []),
    ["Pasted in", r.pasted.length ? r.pasted : ["Nothing"]],
    ["Gather first", r.gather],
    ...(r.gatherFiles.length ? [["Runs these vault files", r.gatherFiles.map((x) => `${x.replace(/ [0-9a-f]{16}$| missing$/, "")} (as it is now: an edit asks for approval again)`)] as ReachFact] : []),
    ["Each run", [r.eachRun === "continue" ? "Continues the last run's session, while what it can reach stays the same" : "A new session"]],
  ];
  if (r.prompt != null) rows.push(["Prompt", [r.prompt]]);
  if (r.humanNotes) rows.push(["Human Notes", [r.humanNotes]]);
  return rows.filter(([, v]) => v.length);
}

function neverWords(r: ResolvedReach): string {
  const places = r.neverRead.filter((p) => !p.endsWith("/**")).join(", ");
  const shell = r.deny.includes("Bash") ? "" : r.web.search ? "; with the web open, its shell isn't sandboxed and can still reach them" : " and its sandboxed shell";
  return `${places}: refused to its file tools${shell}`;
}
