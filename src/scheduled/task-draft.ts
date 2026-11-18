
import { newTaskDraft } from "../constants/scheduled.js";
import type { NewTaskDraft } from "../constants/scheduled.js";
import type { ScheduledTask } from "./task-model.js";

export function taskDenyList(text: string): string[] {
  return text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

export function mixedSiteList(text: string): boolean {
  const t = text.trim();
  return /\[\[/.test(t) && !/^\[\[[^\]]+\]\]$/.test(t);
}

export function draftFromTask(t: ScheduledTask): NewTaskDraft {
  const d = newTaskDraft();
  d.name = t.name;
  d.web = t.web.mode;
  d.sites = t.web.listNote ? `[[${t.web.listNote.replace(/\.md$/i, "")}]]` : t.web.sites.join(", ");
  d.connectors = t.connectors === "on";
  d.closeTab = t.tab === "close";
  d.shell = t.shell;
  d.chrome = t.chrome;
  d.obsidianCli = [...t.obsidianCli];
  d.ownFolder = t.ownFolder;
  d.deny = t.deny.join(", ");
  d.reads = [...t.readsResolved];
  d.readsKept = [...t.readsMissing];
  d.toFull = t.headlessNote;
  d.eachRun = t.eachRun;
  d.followUp = t.followUp === "ticket";
  d.onlyWhenNew = t.onlyWhenNew;
  d.model = t.model;
  d.schedule = t.scheduleText;
  d.prompt = t.prompt;
  return d;
}

export function draftFields(d: NewTaskDraft): { set: Record<string, unknown>; drop: string[] } {
  const sites = d.sites.trim();
  const webOf = (): unknown => {
    if (d.web === "off") return "off";
    if (d.web === "search") return "search";
    if (/^\[\[[^\]]+\]\]$/.test(sites)) return sites;
    return sites.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  };
  const deny = taskDenyList(d.deny);
  return {
    set: {
      schedule: d.schedule || null,
      "each-run": d.eachRun,
      "follow-up": d.followUp ? "ticket" : null,
      "only-when-new": d.onlyWhenNew,
      model: d.model || null,
      reads: d.reads.length || d.readsKept.length ? [...d.reads.map((p) => (p.endsWith("/") ? `[[${p}]]` : `[[${p.replace(/\.md$/, "")}]]`)), ...d.readsKept] : null,
      mode: "full", web: webOf(), connectors: d.connectors ? "on" : "none", shell: d.shell,
      chrome: d.web === "search" && d.chrome ? "on" : "off",
      "obsidian-cli": d.obsidianCli.length ? [...d.obsidianCli] : null,
      "own-folder-only": d.ownFolder, deny: deny.length ? deny : null, tab: d.closeTab ? "close" : "keep",
    },
    drop: ["file-access", "tools", "writes"],
  };
}

export function draftChanges(before: NewTaskDraft, after: NewTaskDraft): { set: Record<string, unknown>; drop: string[] } {
  const a = draftFields(before), b = draftFields(after);
  if (after.toFull) return { set: { ...b.set }, drop: b.drop };
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b.set)) if (JSON.stringify(v) !== JSON.stringify(a.set[k])) set[k] = v;
  return { set, drop: [] };
}

export function withPrompt(text: string, prompt: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^##[ \t]+Prompt[ \t]*$/.test(l));
  const body = prompt.replace(/\r\n?/g, "\n").trim();
  if (at < 0) return `${text.replace(/\s*$/, "")}\n\n## Prompt\n\n${body}\n`;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (/^#{1,2}[ \t]/.test(lines[i]) || /^---[ \t]*$/.test(lines[i])) { end = i; break; }
  const after = lines.slice(end);
  return [...lines.slice(0, at + 1), "", body, ...(after.length ? ["", ...after] : [""])].join("\n");
}
