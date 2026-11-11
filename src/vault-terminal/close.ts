
export interface CloseReason {
  agent: boolean;
  name: string;
  draft?: boolean;
  background?: boolean;
}

export function closeText(reasons: CloseReason[]): { title: string; text: string } {
  const count = reasons.length;
  const title = count === 1 ? "Close this terminal?" : `Close ${count} terminals?`;
  const list = (names: string[]) => [...new Set(names)].join(", ");
  if (count === 1) {
    const r = reasons[0];
    if (r.draft) return { title, text: `${r.name} has text you haven't sent. Closing ends the session and loses it.` };
    if (r.background) return { title, text: "Its agent still has work running in the background, such as a shell or a sub-agent. Closing ends it." };
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
