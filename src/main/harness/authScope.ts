// ---------------------------------------------------------------------------
// src/main/harness/authScope.ts
//
// resolveAuthEnvForDescriptor — the auth-env gate used by buildMountEnv
// (orpheusSurfaceAdapter.ts) to decide whether a mount's env should receive
// Claude's auth layer. Pulled out into its own zero-dependency module (no
// electron, no native addon, no DB) so it is directly importable from
// scripts/verify-harness-launch.ts without fighting orpheusSurfaceAdapter.ts's
// full mock.module() chain — that file statically imports electron's `app`
// AND packages/ghostty-surface's native addon loader, which is why
// scripts/verify-runtime-main-integration.ts reads it as source text instead
// of importing it (see that script's header).
//
// getClaudeAuthEnv() (src/main/claudeAuth.ts) is Claude-auth-specific:
// Anthropic API keys/tokens, plus — on other cloud_provider branches —
// generic-looking names like AWS_REGION, CLOUD_ML_REGION,
// AWS_BEARER_TOKEN_BEDROCK. Merging those unconditionally into a non-Claude
// harness's shell would leak Anthropic-routing env into tooling that has
// nothing to do with Claude. Gated on `descriptorId` directly rather than a
// capability flag deliberately: this is Claude's OWN auth wiring, not a UI
// feature being gated by capability (the "never gate on harnessId" rule
// targets feature gates, not a harness's private auth plumbing). Codex v1
// relies on the user's own `codex login` / ambient OPENAI_API_KEY and has no
// equivalent here, so non-Claude descriptors get {}.
// ---------------------------------------------------------------------------

export function resolveAuthEnvForDescriptor(
  descriptorId: string,
  getAuthEnv: () => Record<string, string>
): Record<string, string> {
  return descriptorId === 'claude' ? getAuthEnv() : {}
}
