// What turning tickets on writes where it's missing: the tickets base and the ticket
// template. Property names are the fixed ones (constants/names.ts), so the base works
// in every vault.

// The base's file name, in the AGENTS.md folder.
export const TICKETS_BASE_NAME = "Tickets.base";

// A new ticket's note, when the template is missing too.
export const TICKET_TEMPLATE = `---
type: ticket
done: false
backend:
---

## Outputs

## Notes

## AI Notes

## Wrap
`;

// A new overview, when no overview template is set: {{name}} is the folder's name.
export const OVERVIEW_TEMPLATE = `---
repo:
---

# {{name}}

What this is, who it's for, and what done looks like. Sessions started from anything in this folder read this first, while overviews are on. If the work has a code repository, put its path in the repo property.
`;

// A YAML single-quoted scalar: '' is the only escape.
const yamlQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

// The tickets base: every note with `type: ticket` but the template, in three views: Open
// (grouped by project), Done, and This folder (for a base embedded in a project's note).
// Its columns: Done, Chat (a Resume pill once the ticket has a main session, else Launch,
// which starts one from the ticket by a link to its path), Ticket, Project, CLI, Created,
// and Updated. Project is worked out from the folder (the one holding `Tickets/`), so
// there's no property to keep up. The vault's name is written in, so the links reach this
// vault when several are open.
export function ticketsBase(vaultName: string, templatePath: string): string {
  // The path is encoded in the formula, the way encodeURIComponent would for the
  // characters a path can hold that break a link.
  const encodedPath = 'file.path.replace(/%/g, "%25").replace(/ /g, "%20").replace(/&/g, "%26").replace(/#/g, "%23").replace(/\\+/g, "%2B").replace(/\\?/g, "%3F")';
  const launch = `"obsidian://agent-manager?vault=${encodeURIComponent(vaultName)}&op=new&note=" + ${encodedPath}`;
  const chat = `if(note["main-session"], link(note["main-session"], "Resume"), link(${launch}, "Launch"))`;
  const project = 'file.folder.replace(/\\/?Tickets$/, "").split("/").slice(-1).join("")';
  const columns = ["done", "formula.chat", "file.name", "formula.project", "backend", "file.ctime", "file.mtime"];
  const view = (name: string, filters: string[], group = false) => [
    "  - type: table",
    `    name: ${name}`,
    "    filters:",
    "      and:",
    ...filters.map((f) => `        - ${yamlQuote(f)}`),
    ...(group ? ["    groupBy:", "      property: formula.project", "      direction: ASC"] : []),
    "    order:",
    ...columns.map((c) => `      - ${c}`),
    "    sort:",
    "      - property: file.mtime",
    "        direction: DESC",
  ];
  return [
    "filters:",
    "  and:",
    `    - ${yamlQuote('type == "ticket"')}`,
    `    - ${yamlQuote(`file.path != ${JSON.stringify(templatePath)}`)}`,
    "formulas:",
    `  chat: ${yamlQuote(chat)}`,
    `  project: ${yamlQuote(project)}`,
    "properties:",
    "  note.done:",
    "    displayName: Done",
    "  formula.chat:",
    "    displayName: Chat",
    "  file.name:",
    "    displayName: Ticket",
    "  formula.project:",
    "    displayName: Project",
    "  note.backend:",
    "    displayName: CLI",
    "  file.ctime:",
    "    displayName: Created",
    "  file.mtime:",
    "    displayName: Updated",
    "views:",
    ...view("Open", ["done != true"], true),
    ...view("Done", ["done == true"]),
    ...view("This folder", ["done != true", "file.inFolder(this.file.folder)"]),
    "",
  ].join("\n");
}
