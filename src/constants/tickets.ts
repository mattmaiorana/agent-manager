
export const TICKETS_BASE_NAME = "Tickets.base";

export const TICKET_TEMPLATE = `---
type: ticket
done: false
cli:
---

## Outputs

---
## Notes

---
## AI Notes

---
## Wrap

---
## Session Links

---
![[${TICKETS_BASE_NAME}#This ticket]]
`;

export const OVERVIEW_TEMPLATE = `---
repo:
---

# {{name}}

What this is, who it's for, and what done looks like. Sessions started from anything in this folder read this first, while project overviews are on. If the work has a code repository, put its path in the repo property.
`;

const yamlQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export function ticketsBase(vaultName: string, templatePath: string): string {
  const encodedPath = 'file.path.replace(/%/g, "%25").replace(/ /g, "%20").replace(/&/g, "%26").replace(/#/g, "%23").replace(/\\+/g, "%2B").replace(/\\?/g, "%3F")';
  const launch = `"obsidian://agent-manager?vault=${encodeURIComponent(vaultName)}&op=new&note=" + ${encodedPath}`;
  const chat = `if(note["main-session"], link(note["main-session"], "Resume"), link(${launch}, "Launch"))`;
  const folder = 'file.folder.replace(/\\/?Tickets$/, "")';
  const project = `if(("/" + ${folder}).contains("/Projects/"), ("/" + ${folder}).split("/Projects/").slice(-1).join("").split("/").filter(value != "Archive").join(" / "), ${folder}.split("/").slice(-1).join(""))`;
  const columns = ["done", "formula.chat", "file.name", "formula.project", "cli", "file.ctime", "file.mtime"];
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
    "  note.cli:",
    "    displayName: CLI",
    "  file.ctime:",
    "    displayName: Created",
    "  file.mtime:",
    "    displayName: Updated",
    "views:",
    ...view("Open", ["done != true"], true),
    ...view("Done", ["done == true"]),
    ...view("This folder", ["done != true", "file.inFolder(this.file.folder)"]),
    ...view("This ticket", ["file.path == this.file.path"]),
    "",
  ].join("\n");
}
