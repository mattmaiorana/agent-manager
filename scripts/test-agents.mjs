// Tests agents' pure parts (src/context/agents.ts): node scripts/run-test.mjs scripts/test-agents.mjs
import { agentArgs, agentNameProblem, agentSlug, listedAgent, parseHome, readAgents, shownUnder } from "../src/context/agents.js";

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
};

// Saved data, checked.
check("read: skips bad entries", readAgents([{ id: "a", name: " Personal " }, { id: "", name: "x" }, { id: "b" }, null, { id: "a", name: "Dup" }]).map((a) => a.name), ["Personal"]);
check("read: fields", readAgents([{ id: "a", name: "W", instructions: " I.md ", home: "", dailyName: "D" }])[0], { id: "a", name: "W", instructions: "I.md", home: "", dailyName: "D", enabled: true });
check("read: turned off", readAgents([{ id: "a", name: "W", enabled: false }])[0].enabled, false);
check("read: not an array", readAgents({}), []);

// Names.
check("name: empty", !!agentNameProblem("  ", []), true);
check("name: slash", !!agentNameProblem("a/b", []), true);
check("name: dot", !!agentNameProblem(".hidden", []), true);
check("name: duplicate ignoring case", !!agentNameProblem("work", ["Work"]), true);
check("name: fine", agentNameProblem("Work", ["Personal"]), null);

// Homes.
check("home: empty", parseHome(" "), null);
check("home: root", parseHome("/"), "");
check("home: path", parseHome("/02 - Personal Projects/"), "02 - Personal Projects");

// Slugs.
check("slug", agentSlug({ id: "x", name: "OCI Work" }), "oci-work");
check("slug: nothing left", agentSlug({ id: "12345678abc", name: "日本" }), "agent-12345678");

// Flags.
const ag = { id: "x", name: "Work", instructionsPath: "/v/W.md" };
const claude = agentArgs("claude", ag, { resume: false });
check("claude: flags", [claude[0], claude[2], claude[3]], ["--agents", "--agent", "work"]);
check("claude: json", Object.keys(JSON.parse(claude[1])), ["work"]);
check("claude: on resume too", agentArgs("claude", ag, { resume: true }).length, 4);
check("codex: launch", agentArgs("codex", ag, { resume: false })[0], "-c");
check("codex: toml string", agentArgs("codex", { ...ag, name: 'A "q"' }, { resume: false })[1].startsWith('developer_instructions="You are the A \\"q\\" agent.'), true);
check("codex: not on resume", agentArgs("codex", ag, { resume: true }), []);
check("antigravity: none", agentArgs("antigravity", ag, { resume: false }), []);
check("no agent", agentArgs("claude", null, { resume: false }), []);

// The switch's filter: a session with no agent is listed under the Default agent.
const known = new Set(["p", "w"]);
check("filter: no agents", shownUnder("w", null, known, null), true);
check("filter: same", shownUnder("p", "p", known, null), true);
check("filter: other", shownUnder("w", "p", known, "p"), false);
check("filter: none, default p, under p", shownUnder("", "p", known, "p"), true);
check("filter: none, default p, under w", shownUnder("", "w", known, "p"), false);
check("filter: unknown session, default p", shownUnder(undefined, "p", known, "p"), true);
check("filter: removed agent, default p", shownUnder("gone", "p", known, "p"), true);
check("filter: none, no default, under No agent", shownUnder(undefined, "", known, null), true);
check("filter: none, no default, under p", shownUnder(undefined, "p", known, null), false);
check("filter: an agent's, under No agent", shownUnder("p", "", known, null), false);
check("listed: default", listedAgent(undefined, known, "w"), "w");
check("listed: own", listedAgent("p", known, "w"), "p");

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
