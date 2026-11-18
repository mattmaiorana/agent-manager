
export const SCHEDULED_ENV_DROP = /^(ANTHROPIC_\w+|CLAUDE_CONFIG_DIR|CLAUDE_CODE_\w+|CLAUDECODE|CLAUDE_AGENT_\w+|OPENAI_\w+|CODEX_\w+|GEMINI_\w+|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_\w+|AWS_\w+|VERTEX_\w+|CLOUD_ML_REGION|AZURE_\w+|MCP_\w+|MAX_THINKING_TOKENS|DISABLE_\w+|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy|GH_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN|NPM_TOKEN|HOMEBREW_GITHUB_API_TOKEN|\w*_(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY))$/;

export function scheduledEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v != null && !SCHEDULED_ENV_DROP.test(k)) out[k] = v;
  return out;
}

export function denyRule(pattern: string): string {
  const p = pattern.startsWith("/") ? pattern : `/${pattern}`;
  return `Read(/${p})`;
}

export const HUMAN_NOTES_LEAD = "Its owner's notes on this task, from its Human Notes section, go with the prompt:";

export function continueSession(eachRun: string, last: { session: string; key: string } | null, key: string): string | null {
  if (eachRun !== "continue" || !last || !last.session) return null;
  return last.key === key ? last.session : null;
}
