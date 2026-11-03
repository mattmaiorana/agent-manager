// Tests a new ticket's file name and where the card's notes go (src/tickets/new-ticket.ts):
// node scripts/run-test.mjs scripts/test-new-ticket.mjs
import { TICKET_TEMPLATE } from "../src/constants/tickets.js";
import { ticketFileName, withNotes } from "../src/tickets/new-ticket.js";

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
};

check("name kept", ticketFileName("Fix the sidebar"), "Fix the sidebar");
check("name, unsafe characters", ticketFileName("a/b: c#d [e]?"), "a b c d e");
check("name, spaces collapsed", ticketFileName("  two   spaces  "), "two spaces");
check("name, leading dot", ticketFileName(".hidden"), "hidden");
check("name, nothing left", ticketFileName(" / "), "");

const matt = "---\ntype: ticket\n---\n## Outputs\n\n---\n## Human Notes\n\n\n\n---\n## AI Notes\n";
check("under the heading, blank lines replaced", withNotes(matt, "## Human Notes", "Do the thing.\nAnd this."),
  "---\ntype: ticket\n---\n## Outputs\n\n---\n## Human Notes\n\nDo the thing.\nAnd this.\n\n---\n## AI Notes\n");
check("heading matched trimmed", withNotes(matt, "  ## Human Notes ", "x"), withNotes(matt, "## Human Notes", "x"));
check("the built-in template's heading", withNotes(TICKET_TEMPLATE, "## Notes", "x"), TICKET_TEMPLATE.replace("## Notes\n\n", "## Notes\n\nx\n\n"));
check("heading last in the note", withNotes("## Notes", "## Notes", "x"), "## Notes\n\nx\n");
check("no heading: under the properties", withNotes(matt, "", "Do it.\nNow."), "---\ntype: ticket\n---\nDo it.\nNow.\n\n## Outputs\n\n---\n## Human Notes\n\n\n\n---\n## AI Notes\n");
check("the built-in template, no heading", withNotes(TICKET_TEMPLATE, "", "x"), TICKET_TEMPLATE.replace("---\n\n## Outputs", "---\nx\n\n## Outputs"));
check("heading not in the template: under the properties", withNotes("---\na: 1\n---\n# T\n", "## Notes", "x"), "---\na: 1\n---\nx\n\n# T\n");
check("no properties: at the top", withNotes("# T\n\nbody\n", "", "x"), "x\n\n# T\n\nbody\n");
check("only properties", withNotes("---\na: 1\n---", "", "x"), "---\na: 1\n---\nx\n");
check("no notes: unchanged", withNotes(matt, "## Human Notes", "  \n "), matt);
check("Windows line ends in the notes", withNotes("## Notes\n", "## Notes", "a\r\nb"), "## Notes\n\na\nb\n");

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log("all passed");
