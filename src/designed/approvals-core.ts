
export const TOKEN_VAR = "AGENT_MANAGER_HOOK_TOKEN";
export const TOKEN_HEADER = "x-agent-manager-token";
export const PERMISSION_TIMEOUT_S = 600;

type HookEntry = { hooks: Record<string, unknown>[] };

export function approvalHooks(base: string, stream = false, approvals = true): Record<string, HookEntry[]> {
  const http = (path: string, timeout: number): HookEntry[] => [{
    hooks: [{ type: "http", url: `${base}/${path}`, timeout, headers: { [TOKEN_HEADER]: `$${TOKEN_VAR}` }, allowedEnvVars: [TOKEN_VAR] }],
  }];
  const prompt = { UserPromptSubmit: http("prompt", 2) };
  if (!approvals) return prompt;
  return {
    ...prompt,
    PermissionRequest: http("permission", PERMISSION_TIMEOUT_S),
    PostToolUse: http("done", 5),
    PostToolUseFailure: http("done", 5),
    ...(stream ? { MessageDisplay: http("stream", 2) } : {}),
  };
}

export function promptContext(text: string): string {
  return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }) : "";
}

export interface StreamBatch {
  messageId: string;
  index: number;
  final: boolean;
  delta: string;
}

export function parseStream(body: string): StreamBatch | null {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return null; }
  if (!isObject(j) || typeof j.message_id !== "string" || typeof j.delta !== "string") return null;
  return { messageId: j.message_id, index: typeof j.index === "number" ? j.index : 0, final: j.final === true, delta: j.delta };
}

export interface PermissionAsk {
  toolName: string;
  toolInput: Record<string, unknown>;
  agentId?: string;
  agentType?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseAsk(body: string): PermissionAsk | null {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return null; }
  if (!isObject(j) || typeof j.tool_name !== "string" || !j.tool_name) return null;
  const ask: PermissionAsk = { toolName: j.tool_name, toolInput: isObject(j.tool_input) ? j.tool_input : {} };
  if (typeof j.agent_id === "string" && j.agent_id) ask.agentId = j.agent_id;
  if (typeof j.agent_type === "string" && j.agent_type) ask.agentType = j.agent_type;
  return ask;
}

export type CardKind = "permission" | "question" | "plan";

export function cardKind(toolName: string): CardKind {
  if (toolName === "AskUserQuestion") return "question";
  if (toolName === "ExitPlanMode") return "plan";
  return "permission";
}

const decision = (d: Record<string, unknown>): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d } });

export function allowBody(updatedInput?: Record<string, unknown>): string {
  return decision(updatedInput ? { behavior: "allow", updatedInput } : { behavior: "allow" });
}

export const PLAN_MODES = [["auto", "Approve, auto mode"], ["default", "Approve, ask before edits"], ["acceptEdits", "Approve, accept edits"]] as const;
export type PlanMode = (typeof PLAN_MODES)[number][0];

export function planAllowBody(input: Record<string, unknown>, mode: PlanMode): string {
  return decision({ behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] });
}

export function planDenyBody(feedback: string): string {
  const f = feedback.trim();
  if (!f) return denyBody("The user isn't ready to approve this plan yet. Stay in plan mode and wait for them.", true);
  return denyBody(`The user reviewed this plan and wants changes before approving it: ${/[.!?]$/.test(f) ? f : `${f}.`} Revise the plan and present it again with ExitPlanMode.`);
}

export function denyBody(message = "The user denied this in Agent Manager's session view.", interrupt = false): string {
  return decision(interrupt ? { behavior: "deny", message, interrupt: true } : { behavior: "deny", message });
}

export interface Question {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export function questionsOf(input: Record<string, unknown>): Question[] {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  const out: Question[] = [];
  for (const q of qs) {
    if (!isObject(q) || typeof q.question !== "string") continue;
    const options = (Array.isArray(q.options) ? q.options : [])
      .filter(isObject)
      .filter((o) => typeof o.label === "string")
      .map((o) => ({ label: o.label as string, description: typeof o.description === "string" ? o.description : "" }));
    out.push({ question: q.question, header: typeof q.header === "string" ? q.header : "", options, multiSelect: q.multiSelect === true });
  }
  return out;
}

export function questionAnswer(input: Record<string, unknown>, picks: string[][]): Record<string, unknown> | null {
  const qs = questionsOf(input);
  if (!qs.length || picks.length !== qs.length) return null;
  const answers: Record<string, string> = {};
  for (let i = 0; i < qs.length; i++) {
    if (!picks[i].length) return null;
    answers[qs[i].question] = picks[i].join(", ");
  }
  return { ...input, answers };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a)) return isObject(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => deepEqual(a[k], b[k]));
  return false;
}

export function doneMatches(card: PermissionAsk, done: PermissionAsk): boolean {
  if (card.toolName !== done.toolName) return false;
  if ((card.agentId || "") !== (done.agentId || "")) return false;
  if (card.toolName === "AskUserQuestion") return deepEqual(card.toolInput.questions, done.toolInput.questions);
  if (card.toolName === "ExitPlanMode") return true;
  return Object.keys(card.toolInput).every((k) => deepEqual(card.toolInput[k], done.toolInput[k]));
}

export interface ToolSummary {
  title: string;
  detail: string;
  extra?: { label: string; text: string };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function describeTool(ask: PermissionAsk): ToolSummary {
  const i = ask.toolInput;
  switch (ask.toolName) {
    case "Bash":
      return { title: "Run a command", detail: str(i.command), ...(str(i.description) ? { extra: { label: "Why", text: str(i.description) } } : {}) };
    case "Edit":
      return { title: `Edit ${str(i.file_path)}`, detail: str(i.old_string), extra: { label: i.replace_all === true ? "With, at every place it appears" : "With", text: str(i.new_string) } };
    case "Write":
      return { title: `Write ${str(i.file_path)}`, detail: str(i.content) };
    case "NotebookEdit":
      return { title: `Edit ${str(i.notebook_path)}`, detail: str(i.new_source) };
    case "WebFetch":
      return { title: "Fetch a page", detail: str(i.url), ...(str(i.prompt) ? { extra: { label: "To", text: str(i.prompt) } } : {}) };
    case "WebSearch":
      return { title: "Search the web", detail: str(i.query) };
    default:
      return { title: `Use ${ask.toolName}`, detail: JSON.stringify(i, null, 2) };
  }
}
