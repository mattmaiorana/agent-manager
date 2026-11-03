// Tests what a session gets from where it starts (src/context/launch-context.ts), on a
// folder tree in memory: node scripts/run-test.mjs scripts/test-launch-context.mjs
import { composeOpening, contextPrompt, launchContext, isTicket } from "../src/context/launch-context.js";

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
};

// Notes by path, each with its frontmatter.
const notes = {
  "Overview.md": {},
  "Projects/Overview.md": {},
  "Projects/Group/Overview.md": { repo: "~/code/group" },
  "Projects/Group/App/Overview.md": {},
  "Projects/Group/App/Tickets/Fix the bug.md": { type: "ticket" },
  "Projects/Group/App/Tickets/Plain.md": { type: "note" },
  "Projects/Group/App/Workspace/Draft.md": {},
  "Projects/Solo/Overview.md": { repo: "/abs/solo" },
  "Projects/Solo/Tickets/Upper.md": { type: " Ticket " },
  "Loose/Ticket.md": { type: "ticket" },
  "Templates/Ticket.md": { type: "ticket" },
  "Agents/Overview.md": {},
};
const vault = {
  isNote: (p) => p in notes,
  frontmatter: (p) => notes[p] ?? null,
};
const opts = (over = {}) => ({
  startFolder: "",
  useOverviews: true,
  useTickets: true,
  overviewName: "Overview.md",
  templatePath: "Templates/Ticket.md",
  resolvePath: (v) => (v.startsWith("~/") ? `/home/me/${v.slice(2)}` : v.startsWith("/") ? v : `/vault/${v}`),
  ...over,
});

// A ticket in a project in a group: every overview from the root down, the group's repo.
check("ticket in a group", launchContext({ notePath: "Projects/Group/App/Tickets/Fix the bug.md" }, vault, opts()), {
  ticket: "Projects/Group/App/Tickets/Fix the bug.md",
  overviews: ["Overview.md", "Projects/Overview.md", "Projects/Group/Overview.md", "Projects/Group/App/Overview.md"],
  repo: "/home/me/code/group",
  agent: null,
  reads: [],
  missingReads: [],
});
// The nearest overview with a repo wins; a nearer one without a repo doesn't hide it.
check("nearest repo", launchContext({ notePath: "Projects/Solo/Tickets/Upper.md" }, vault, opts()).repo, "/abs/solo");
// type is matched without case or spaces.
check("type: Ticket", launchContext({ notePath: "Projects/Solo/Tickets/Upper.md" }, vault, opts()).ticket, "Projects/Solo/Tickets/Upper.md");
// A note that isn't a ticket.
check("plain note", launchContext({ notePath: "Projects/Group/App/Tickets/Plain.md" }, vault, opts()).ticket, null);
// The template is never a ticket.
check("template", isTicket("Templates/Ticket.md", vault, opts()), false);
// Tickets off: no ticket, overviews still read.
check("tickets off", launchContext({ notePath: "Loose/Ticket.md" }, vault, opts({ useTickets: false })), { ticket: null, overviews: ["Overview.md"], repo: null, agent: null, reads: [], missingReads: [] });
// Overviews off: no overviews, no repo, the ticket still known.
check("overviews off", launchContext({ notePath: "Projects/Group/App/Tickets/Fix the bug.md" }, vault, opts({ useOverviews: false })), { ticket: "Projects/Group/App/Tickets/Fix the bug.md", overviews: [], repo: null, agent: null, reads: [], missingReads: [] });
// A folder launch reads down to the folder itself.
check("folder", launchContext({ folderPath: "Projects/Group" }, vault, opts()).overviews, ["Overview.md", "Projects/Overview.md", "Projects/Group/Overview.md"]);
// The AGENTS.md folder is the top: nothing above it is read.
check("start folder", launchContext({ notePath: "Projects/Group/App/Workspace/Draft.md" }, vault, opts({ startFolder: "Projects" })).overviews, ["Projects/Overview.md", "Projects/Group/Overview.md", "Projects/Group/App/Overview.md"]);
// A note outside the AGENTS.md folder gets no overviews.
check("outside start folder", launchContext({ notePath: "Agents/Overview.md" }, vault, opts({ startFolder: "Projects" })).overviews, []);
// "Projects" as the AGENTS.md folder doesn't take in a sibling that only shares its name's start.
check("name prefix", launchContext({ folderPath: "ProjectsX" }, vault, opts({ startFolder: "Projects" })).overviews, []);
// A different overview name.
check("overview name", launchContext({ folderPath: "Projects" }, vault, opts({ overviewName: "README.md" })).overviews, []);
// Nothing to start from: nothing.
check("no source", launchContext({}, vault, opts()), { ticket: null, overviews: [], repo: null, agent: null, reads: [], missingReads: [] });
// A relative repo is resolved by the plugin (relative to the vault).
notes["Projects/Rel/Overview.md"] = { repo: "code/rel" };
check("relative repo", launchContext({ folderPath: "Projects/Rel" }, vault, opts()).repo, "/vault/code/rel");

// The opening: overviews, then repo, then the kind's template, one line each.
const T = { overviews: "Read: {{overviews}}.", repo: "Repo \"{{repo}}\".", ticket: "Ticket {{path}}.\n  Then wait.", note: "Note {{path}}.", plain: "Hi.", daily: "", folder: "" };
const abs = (p) => `/v/${p}`;
check("opening, every part", composeOpening((k) => T[k], { ticket: "T.md", overviews: ["A/Overview.md", "A/B/Overview.md"], repo: "/r", reads: [] }, "ticket", { path: "/v/T.md" }, abs),
  'Read: "/v/A/Overview.md", "/v/A/B/Overview.md". Repo "/r". Ticket /v/T.md. Then wait.');
check("opening, no context", composeOpening((k) => T[k], { ticket: null, overviews: [], repo: null, reads: [] }, "note", { path: "/v/N.md" }, abs), "Note /v/N.md.");
check("opening, empty kind", composeOpening((k) => T[k], { ticket: null, overviews: ["O.md"], repo: null, reads: [] }, "daily", {}, abs), 'Read: "/v/O.md".');
check("opening, empty part", composeOpening((k) => ({ ...T, overviews: "" })[k], { ticket: null, overviews: ["O.md"], repo: "/r", reads: [] }, "plain", {}, abs), 'Repo "/r". Hi.');
check("opening, unknown placeholder kept", composeOpening(() => "{{nope}}", { ticket: null, overviews: [], repo: null, reads: [] }, "plain", {}, abs), "{{nope}}");

// Agents, by home folder: the deepest home wins, and a home of "" (the root) holds everything.
const homes = [{ id: "Personal", home: "Projects" }, { id: "Work", home: "Projects/Group" }, { id: "Root", home: "" }, { id: "Second", home: "Projects/Group" }];
check("agent: nested home", launchContext({ notePath: "Projects/Group/App/Tickets/Fix the bug.md" }, vault, opts({ homes })).agent, "Work");
check("agent: outer home", launchContext({ notePath: "Projects/Solo/Tickets/Upper.md" }, vault, opts({ homes })).agent, "Personal");
check("agent: root home", launchContext({ folderPath: "Loose" }, vault, opts({ homes })).agent, "Root");
check("agent: no home", launchContext({ folderPath: "Loose" }, vault, opts({ homes: homes.slice(0, 2) })).agent, null);
// Two agents with the same home: the first in settings.
check("agent: same home", launchContext({ folderPath: "Projects/Group/App" }, vault, opts({ homes })).agent, "Work");
check("agent: name prefix", launchContext({ folderPath: "ProjectsX" }, vault, opts({ homes: homes.slice(0, 2) })).agent, null);
// Overviews off: the agent still comes from the home.
check("agent: overviews off", launchContext({ folderPath: "Projects/Group" }, vault, opts({ homes, useOverviews: false })).agent, "Work");
check("agent: no source", launchContext({}, vault, opts({ homes })).agent, null);
// The agent part goes first.
const TA = { ...T, agent: "You are {{profile}}; read \"{{instructions}}\"." };
check("opening, agent first", composeOpening((k) => TA[k], { ticket: null, overviews: ["O.md"], repo: null, agent: null, reads: [] }, "plain", {}, abs, { name: "Work", instructions: "/v/W.md" }), 'You are Work; read "/v/W.md". Read: "/v/O.md". Hi.');
check("opening, no agent", composeOpening((k) => TA[k], { ticket: null, overviews: [], repo: null, agent: null, reads: [] }, "plain", {}, abs, null), "Hi.");

// ---- reads (1.4): a ticket's notes and folders to read too ----
const rnotes = {
  "P/Overview.md": { repo: "/r" },
  "P/Tickets/T.md": { type: "ticket", reads: ["[[Spec]]", "[[Spec|the spec]]", "P/Notes/Plan.md", "[[P/Refs/]]", "[[Gone]]", 7, ""] },
  // As YAML reads unquoted links: `- [[Spec]]` in a list, and `reads: [[Plan]]` alone.
  "P/Tickets/Bare.md": { type: "ticket", reads: [[["Spec"]], [["Gone|x"]]] },
  "P/Tickets/Bare1.md": { type: "ticket", reads: [["P/Notes/Plan.md"]] },
  "P/Tickets/One.md": { type: "ticket", reads: "[[Spec#Part]]" },
  "P/Note.md": { reads: ["[[Spec]]"] },
  "P/Spec.md": {},
  "P/Notes/Plan.md": {},
};
const rfolders = new Set(["P/Refs"]);
const rvault = {
  isNote: (p) => p in rnotes,
  frontmatter: (p) => rnotes[p] ?? null,
  resolve: (link) => (rfolders.has(link) ? { path: link, folder: true } : link === "Spec" ? { path: "P/Spec.md", folder: false } : link in rnotes ? { path: link, folder: false } : null),
};
const rc = launchContext({ notePath: "P/Tickets/T.md" }, rvault, opts());
check("reads: resolved, twice once, folder kept apart", rc.reads, [{ path: "P/Spec.md", folder: false }, { path: "P/Notes/Plan.md", folder: false }, { path: "P/Refs", folder: true }]);
check("reads: missing named", rc.missingReads, ["[[Gone]]", "7"]);
const bare = launchContext({ notePath: "P/Tickets/Bare.md" }, rvault, opts());
check("reads: unquoted links in a list", [bare.reads, bare.missingReads], [[{ path: "P/Spec.md", folder: false }], ["[[Gone|x]]"]]);
check("reads: one unquoted link", launchContext({ notePath: "P/Tickets/Bare1.md" }, rvault, opts()).reads, [{ path: "P/Notes/Plan.md", folder: false }]);
check("reads: one entry, a heading link", launchContext({ notePath: "P/Tickets/One.md" }, rvault, opts()).reads, [{ path: "P/Spec.md", folder: false }]);
check("reads: only a ticket's", launchContext({ notePath: "P/Note.md" }, rvault, opts()).reads, []);
check("reads: with overviews off", launchContext({ notePath: "P/Tickets/One.md" }, rvault, opts({ useOverviews: false })).reads.length, 1);
const RT = { ...T, ticket: "Ticket {{path}}." };
check("opening: reads after the overviews", composeOpening((k) => RT[k], rc, "ticket", { path: "/v/P/Tickets/T.md" }, abs),
  'Read: "/v/P/Overview.md". Also read "/v/P/Spec.md", "/v/P/Notes/Plan.md". Also look in the folder "/v/P/Refs". Repo "/r". Ticket /v/P/Tickets/T.md.');
check("opening: reads go with the ticket part", composeOpening((k) => ({ ...RT, ticket: "" })[k], rc, "ticket", {}, abs), 'Read: "/v/P/Overview.md". Repo "/r".');

// ---- contextPrompt (1.4): the paragraph pinned to the system prompt ----
const allOn = () => true;
const from = { kind: "ticket", path: "P/Tickets/T.md" };
check("pinned: every part", contextPrompt(rc, from, allOn, abs),
  'This session was started from the ticket at "/v/P/Tickets/T.md". Its project\'s overview is "/v/P/Overview.md". Also read "/v/P/Spec.md", "/v/P/Notes/Plan.md". Also look in the folder "/v/P/Refs". Its repo is at "/r". Read them again whenever you lose track of them (after a compaction, say).');
const two = launchContext({ notePath: "Projects/Group/App/Tickets/Fix the bug.md" }, vault, opts());
check("pinned: overviews, broadest first", contextPrompt(two, { kind: "ticket", path: "x.md" }, (k) => k === "overviews", abs),
  'Its project\'s overviews, broadest first, are "/v/Overview.md", "/v/Projects/Overview.md", "/v/Projects/Group/Overview.md", "/v/Projects/Group/App/Overview.md". Read them again whenever you lose track of them (after a compaction, say).');
check("pinned: an emptied part is left out", contextPrompt(rc, from, (k) => k !== "repo" && k !== "overviews", abs).includes("repo") || contextPrompt(rc, from, (k) => k !== "repo" && k !== "overviews", abs).includes("Overview"), false);
check("pinned: emptied ticket part drops source and reads", contextPrompt(rc, from, (k) => k !== "ticket", abs).startsWith("Its project's overview"), true);
check("pinned: a folder", contextPrompt(launchContext({ folderPath: "P" }, rvault, opts()), { kind: "folder", path: "P" }, allOn, abs).startsWith('This session was started from the folder at "/v/P".'), true);
check("pinned: nothing on", contextPrompt(rc, from, () => false, abs), "");
check("pinned: no source", contextPrompt(rc, null, allOn, abs), "");

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
