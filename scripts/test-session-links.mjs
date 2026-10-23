// Tests a ticket's session-link and transcript sections (src/tickets/session-links.ts):
// node scripts/run-test.mjs scripts/test-session-links.mjs
import { wrapLine } from "../src/constants/names.js";
import { isLinkFor, keptKind, mainSessionIdIn, listsSession, parseSessionLink, relabelSessionLinks, sessionLinkText, transcriptTarget, upsertSectionLine } from "../src/tickets/session-links.js";

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
};

const A = "019a1111-2222-7333-8444-555566667777";
// Shares A's first eight characters, as two Codex sessions started in the same moment can.
const B = "019a1111-9999-7aaa-8bbb-cccccccccccc";
const url = (id) => `obsidian://agent-manager?vault=V&op=resume&session=${id}`;
const line = (name, cli, kind, id) => `[${sessionLinkText(name, cli, kind)}](${url(id)})`;

check("text", sessionLinkText("Fix it", "Codex", "Main"), "Fix it · Codex · Main");
check("text, no kind", sessionLinkText("", "Claude Code", null), "Untitled · Claude Code");
check("parse", parseSessionLink(line("A · B", "Codex", "Side session", A)), { id: A, url: url(A), name: "A · B", cli: "Codex", kind: "Side session" });
check("parse, a bullet", parseSessionLink(`- ${line("X", "Codex", null, A)}`)?.id, A);
check("parse, not a link", parseSessionLink("[x](https://example.com)"), null);
// A full id is never matched by a longer one that starts with it, or a shorter one.
check("full id only", isLinkFor(A.slice(0, 20))(line("X", "Codex", null, A)), false);
check("other id", isLinkFor(B)(line("X", "Codex", null, A)), false);

const ticket = "---\ntype: ticket\n---\n\n## Outputs\n\n## Wrap\n";
// A missing section is added at the end.
let t = upsertSectionLine(ticket, "Session Links", line("One", "Codex", null, A), isLinkFor(A));
check("adds section", t.endsWith("## Session Links\n" + line("One", "Codex", null, A) + "\n"), true);
// A second session with the same first eight characters gets its own line.
t = upsertSectionLine(t, "Session Links", line("Two", "Codex", null, B), isLinkFor(B));
check("collision kept apart", t.split("\n").filter((l) => l.includes("session=")).length, 2);
// A rename replaces the line in place.
t = upsertSectionLine(t, "Session Links", line("One renamed", "Codex", null, A), isLinkFor(A));
check("rename in place", t.split("\n").filter((l) => l.includes("session=")).map((l) => parseSessionLink(l).name), ["One renamed", "Two"]);
// Unchanged is unchanged.
check("no-op", upsertSectionLine(t, "Session Links", line("One renamed", "Codex", null, A), isLinkFor(A)), t);
// A hand-written duplicate collapses into one.
const dup = t.replace("## Session Links\n", `## Session Links\n- [mine](${url(A)})\n`);
check("duplicate collapses", upsertSectionLine(dup, "Session Links", line("One renamed", "Codex", null, A), isLinkFor(A)).split(url(A)).length - 1, 1);
// A section followed by another: the line goes at its end, before the next heading's blank line.
const mid = "## Session Links\n" + line("X", "Codex", null, A) + "\n\n## Transcripts\n- [[x]]\n";
check("before next section", upsertSectionLine(mid, "Session Links", line("Y", "Codex", null, B), isLinkFor(B)), "## Session Links\n" + line("X", "Codex", null, A) + "\n" + line("Y", "Codex", null, B) + "\n\n## Transcripts\n- [[x]]\n");
// CRLF stays CRLF.
check("CRLF", upsertSectionLine("## Session Links\r\n", "Session Links", "L", () => false), "## Session Links\r\nL\r\n");

// Kinds: Main for the main id, kept kinds kept, the rest Previous main.
const sect = ["## Session Links", line("M", "Codex", "Main", A), line("S", "Claude Code", "Side session", B), line("Old", "Codex", null, "019a0000-0000-7000-8000-000000000000"), ""].join("\n");
check("relabel", relabelSessionLinks(sect, { mainId: B }).split("\n").slice(1, 4).map((l) => parseSessionLink(l).kind), ["Previous main", "Main", "Previous main"]);
check("relabel keeps Side session", relabelSessionLinks(sect, { mainId: null }).split("\n").slice(1, 3).map((l) => parseSessionLink(l).kind), ["Previous main", "Side session"]);
check("relabel, given kind", relabelSessionLinks(sect, { kinds: { [A]: "Linked" } }).split("\n")[1].includes(" · Linked]"), true);
check("kept kind", keptKind(sect, B), "Side session");
check("lists", [listsSession(sect, A), listsSession(sect, A.slice(0, 30))], [true, false]);
check("transcript target", [transcriptTarget("- [[Agent Transcripts/One (019a1111)]]"), transcriptTarget("[[x|y]]"), transcriptTarget("text")], ["Agent Transcripts/One (019a1111)", "x", null]);

// A name with brackets reads back as the same session's line.
const br = line("Fix [UI]", "Codex", null, A);
check("brackets", [parseSessionLink(br)?.id, upsertSectionLine(upsertSectionLine(ticket, "Session Links", br, isLinkFor(A)), "Session Links", br, isLinkFor(A)).split(url(A)).length - 1], [A, 1]);
// The main id from the note's own frontmatter.
check("main id", [mainSessionIdIn(`---\ntype: ticket\nmain-session: ${url(A)}\n---\n## Session Links\n`), mainSessionIdIn(`---\ntype: ticket\n---\nmain-session: ${url(A)}\n`)], [A, null]);

// The Wrap message as each CLI takes it.
check("wrap, Codex skill", wrapLine("/wrap", "codex"), "$wrap ");
check("wrap, Codex skill with words", wrapLine("/wrap now", "codex"), "$wrap now");
check("wrap, Claude skill", wrapLine("/wrap", "claude"), "/wrap");
check("wrap, Antigravity skill", wrapLine("/wrap", "antigravity"), "/wrap");
check("wrap, plain words", wrapLine("Wrap up, please.", "codex"), "Wrap up, please.");
check("wrap, a path isn't a skill", wrapLine("/Users/me/x", "codex"), "/Users/me/x");

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
