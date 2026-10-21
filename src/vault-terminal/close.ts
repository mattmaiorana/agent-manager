// What the confirm before closing a terminal says (core.ts, confirmClose),
// kept free of Obsidian so test/harness.ts can check it.

/** What keeps a terminal from closing without asking (view.ts, closeReason). */
export interface CloseReason {
  /** An agent working or waiting for the user, rather than a program running in a shell. */
  agent: boolean;
  name: string;
  /** Text typed into the agent's prompt and not yet sent (a host's reason: the terminal can't tell). */
  draft?: boolean;
}

/** The confirm's title and its sentence, for one terminal or several. */
export function closeText(reasons: CloseReason[]): { title: string; text: string } {
  const count = reasons.length;
  const title = count === 1 ? "Close this terminal?" : `Close ${count} terminals?`;
  const list = (names: string[]) => [...new Set(names)].join(", ");
  if (count === 1) {
    const r = reasons[0];
    if (r.draft) return { title, text: `${r.name} has text you haven't sent. Closing ends the session and loses it.` };
    if (r.agent) return { title, text: "Its agent is working or waiting for you. Closing ends it." };
    return { title, text: `${r.name} is still running in it. Closing ends it.` };
  }
  const drafts = reasons.filter((r) => r.draft).map((r) => r.name);
  const busy = reasons.filter((r) => !r.draft);
  const agents = busy.filter((r) => r.agent).map((r) => r.name);
  const programs = busy.filter((r) => !r.agent).map((r) => r.name);
  const parts: string[] = [];
  if (agents.length || programs.length) parts.push(`Still running: ${list([...agents, ...programs])}.`);
  if (drafts.length) parts.push(`Text you haven't sent: ${list(drafts)}.`);
  const ends = agents.length && !programs.length && !drafts.length ? "these agents" : "them";
  return { title, text: `${parts.join(" ")} Closing ends ${ends}.` };
}
