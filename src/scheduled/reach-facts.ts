
import type { ResolvedReach, ScheduledTask } from "./task-model.js";

export type ReachFact = [string, string[]];

export function reachFacts(t: ScheduledTask, r: ResolvedReach, backendLabel: string): ReachFact[] {
  const web = r.web.search ? ["Web search, and any page"] : r.web.sites.length ? [...r.web.sites.map((s) => `${s}, and its subdomains`), ...(r.listNote ? [`Read from ${r.listNote}: an edit asks for approval again`] : []), "No web search; its shell reaches only these"] : ["None, its shell included"];
  const rows: ReachFact[] = [
    ["Mode", ["Full session: a Claude Code session in a tab, in auto mode, with your own settings, hooks, skills, and MCP servers. It reads and changes what any session of yours can."]],
    ["Runs on", [r.model ? `${backendLabel}, ${r.model}` : backendLabel]],
    ["Agent profile", [r.agent || "None"]],
    ["Starts in", [r.cwd]],
    ...(r.reads.length ? [["Reads first", r.reads]] as ReachFact[] : []),
    ["Schedule", [r.schedule || "None"]],
    ["Web", web],
    ["Shell", [!r.shell ? "None" : r.web.search ? "On, not sandboxed: the web is open" : `On, sandboxed: ${r.web.sites.length ? "only the sites above" : "no network"}${r.ownFolder ? "; it writes nowhere" : ""}`]],
    ...(r.obsidianCli.length ? [["Vault queries", [`${r.obsidianCli.join(", ")}: answered from Obsidian's link index before each run, leaving out what it never reads`]] as ReachFact] : []),
    ["Connectors", [r.connectors === "none" ? "None: no MCP servers or connectors at all" : "On, as in any session"]],
    ["Claude in Chrome", [r.chrome ? "On: it can act in your signed-in browser" : "Off"]],
    ...(r.ownFolder ? [["Writes", [`Only in its own folder: ${r.ownFolder}`]] as ReachFact] : []),
    ...(r.deny.length ? [["Refused", [r.deny.join(", ")]] as ReachFact] : []),
    ...(r.neverRead.length ? [["Never reads", [neverWords(r)]] as ReachFact] : []),
    ["Results go in", [r.output]],
    ...(t.followUp === "ticket" ? [["Follow-up", ["Each result is added to the task's open follow-up ticket, or a new one"]] as ReachFact] : []),
    ["Each run", [r.eachRun === "continue" ? "Continues the last run's session, which carries what earlier runs read (web pages included) into later ones" : "A new session"]],
  ];
  if (r.prompt) rows.push(["Prompt", [r.prompt]]);
  if (r.humanNotes) rows.push(["Human Notes", [r.humanNotes]]);
  return rows.filter(([, v]) => v.length);
}

function neverWords(r: ResolvedReach): string {
  const places = r.neverRead.filter((p) => !p.endsWith("/**")).join(", ");
  const shell = !r.shell ? "" : r.web.search ? "; with the web open, its shell isn't sandboxed and can still reach them" : " and its sandboxed shell";
  return `${places}: refused to its file tools${shell}`;
}
