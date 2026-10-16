// Per-repository settings, read from the caller's trusted default-branch
// checkout. Everything that differs between repositories lives here; the
// controls themselves stay in this shared code.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export class ConfigError extends Error {}

const DEFAULT_CAPABILITY =
  "DeepSeek V4.1 Flash class general-purpose reasoning and coding: follow interacting files, authorization/data boundaries, asynchronous control flow and propose causal repairs. Do not substitute a miniature, shallow, generic summarizer merely because it is cheap. The owner accepts this baseline despite incomplete benchmark qualification.";

const positive = (value, name) => {
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} must be positive.`);
  return value;
};
const tokens = (value, name) => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new ConfigError(`${name} must be a positive integer.`);
  return value;
};
const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export function parseConfig(raw) {
  if (!raw || typeof raw !== "object" || raw.schema !== 1)
    throw new ConfigError("PR-review config must be a schema 1 object.");
  if (typeof raw.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(raw.repository))
    throw new ConfigError("repository must be owner/name.");
  const stateBranch = raw.state_branch ?? "pr-review-policy";
  if (typeof stateBranch !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,99}$/.test(stateBranch))
    throw new ConfigError("state_branch is invalid.");
  const b = raw.baseline ?? {};
  const c = raw.challenger ?? {};
  if (typeof b.model !== "string" || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/.test(b.model))
    throw new ConfigError("baseline.model must be an OpenRouter model id.");
  if (!Number.isSafeInteger(b.created) || b.created <= 0)
    throw new ConfigError("baseline.created must be the catalog creation timestamp.");
  const reasoningTokens = c.reasoning_tokens ?? 2048;
  if (!Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0)
    throw new ConfigError("challenger.reasoning_tokens must be a non-negative integer.");
  if (!["off", "default"].includes(b.reasoning ?? "off"))
    throw new ConfigError('baseline.reasoning must be "off" or "default".');
  return deepFreeze({
    repository: raw.repository,
    stateBranch,
    maxCallUsd: positive(raw.max_call_usd ?? 0.2, "max_call_usd"),
    reviewerClass: {
      baseline: b.model,
      created: b.created,
      baselineInputTokens: tokens(b.input_tokens ?? 32000, "baseline.input_tokens"),
      baselineMaxCallUsd: positive(b.max_call_usd ?? 0.05, "baseline.max_call_usd"),
      // Last known estimate, used only to describe a retired baseline in research.
      baselineCallUsd: positive(
        b.estimated_call_usd ?? b.max_call_usd ?? 0.05,
        "baseline.estimated_call_usd",
      ),
      baselineReasoning: b.reasoning ?? "off",
      maxCallUsd: positive(c.max_call_usd ?? 0.010112, "challenger.max_call_usd"),
      minConfidence: 0.7,
      capability: typeof b.capability === "string" ? b.capability : DEFAULT_CAPABILITY,
    },
    reviewProfile: {
      inputTokens: tokens(c.input_tokens ?? 32000, "challenger.input_tokens"),
      outputTokens: tokens(c.output_tokens ?? 8192, "challenger.output_tokens"),
      reasoningTokens,
    },
  });
}

const path = process.env.PR_REVIEW_CONFIG;
if (!path) throw new ConfigError("PR_REVIEW_CONFIG must name the repository's config.json.");
export const CONFIG_PATH = resolve(path);
// Fixtures sit beside the config: <dir>/fixtures/*.json.
export const CONFIG_DIR = dirname(CONFIG_PATH);
export const CONFIG = parseConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
