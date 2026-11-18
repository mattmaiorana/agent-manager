
import type { BackendKey } from "./backends.js";

export const SCHEDULED_TASKS_LABEL = "Scheduled Tasks";
export const NEW_SCHEDULED_TASK_LABEL = "New Scheduled Task";
export const LATEST_OUTPUTS_LABEL = "Latest Outputs";
export const SCHEDULED_TYPE = "scheduled task";
export const TASK_PROPS = {
  schedule: "schedule",
  paused: "paused",
  backend: "cli",
  model: "model",
  project: "project",
  web: "web",
  files: "file-access",
  reads: "reads",
  tools: "tools",
  eachRun: "each-run",
  onlyWhenNew: "only-when-new",
  catchUp: "catch-up",
  output: "output",
  followUp: "follow-up",
  shell: "shell",
  writes: "writes",
  mode: "mode",
  connectors: "connectors",
  deny: "deny",
  chrome: "chrome",
  obsidianCli: "obsidian-cli",
  ownFolder: "own-folder-only",
  tab: "tab",
} as const;
export const PROMPT_HEADING = "Prompt";
export const HUMAN_NOTES_HEADING = "Human Notes";
export const GATHER_HEADING = "Gather first";
export const RUN_LOG_FILE = "Run log.md";
export const OUTPUTS_FOLDER = "Outputs";
export const TASK_MEMORY_FILE = "Memory.md";
export const DEFAULT_SCHEDULED_FOLDER = "Scheduled Tasks";
export const SHARED_TASK_CHOICE = ":shared";
export const SESSION_RUN_RULES = "This session is an unattended scheduled run. Where the vault's instructions (its AGENTS.md, or an agent's instructions) describe how interactive sessions work, such as committing your work or the user's edits, recording what you learn in other notes, greeting the user, or asking before you act, follow your opening instead: write only your result and your notes where it says, commit nothing, and record nothing anywhere else. Their other rules still hold, such as never opening what they say a run never opens, and asking before you delete anything: a run can't ask, so it deletes nothing, and says in its result what it would delete. If you can't go on safely, stop and ask, as your opening says.";
export const DEFAULT_TASK_TEMPLATE = "Templates/Scheduled Task.md";

export const SCHEDULED_BACKENDS: BackendKey[] = ["claude"];
export type TaskEachRun = "new" | "continue";
export interface NewTaskDraft {
  name: string; project: string; schedule: string; prompt: string;
  web: "off" | "search" | "sites"; sites: string; connectors: boolean; closeTab: boolean;
  shell: boolean; chrome: boolean; obsidianCli: string[]; ownFolder: boolean; deny: string;
  reads: string[];
  readsKept: string[];
  toFull: boolean;
  eachRun: "new" | "continue"; followUp: boolean; onlyWhenNew: boolean; model: string;
  advanced: boolean;
}
export const newTaskDraft = (): NewTaskDraft => ({
  name: "", project: "", schedule: "", prompt: "",
  web: "off", sites: "", connectors: true, closeTab: false, reads: [],
  shell: true, chrome: false, obsidianCli: [], ownFolder: false, deny: "",
  eachRun: "new", followUp: false, onlyWhenNew: false, model: "", advanced: false,
  readsKept: [], toFull: false,
});
export const NEW_TASK_MODELS: [string, string][] = [["", "Default model"], ["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]];
export const SESSION_DENY_NAME = /^[A-Za-z_*][A-Za-z0-9_*.-]*$/;
export const TASK_TEMPLATE = `---
type: scheduled task
schedule:
paused: false
mode: full
cli: claude
model:
web: off
connectors: on
shell: true
chrome: off
obsidian-cli:
own-folder-only: false
deny:
reads:
tab: keep
each-run: new
only-when-new: false
catch-up: true
output:
follow-up:
---
## Human Notes

## Prompt

`;
