import { CONFIG } from "./config.mjs";
import { REVIEW_PROFILE } from "./evaluate.mjs";
import {
  EVAL_IMAGE,
  EVALUATOR_HASH,
  evidenceKey,
  GRADER_HASH,
  PROFILE_HASH,
  qualifies,
} from "./gate.mjs";
import { eligibleModels, SelectionError, solPriceCeiling } from "./model-catalog.mjs";
import {
  acceptedBaseline,
  BASELINE_PROFILE,
  CLASS_HASH,
  classCeiling,
  REVIEWER_CLASS,
} from "./reviewer-class.mjs";
import { loadSuite } from "./suite.mjs";

export const STATE_BRANCH = CONFIG.stateBranch;
// The repository's per-call ceiling: config value, optionally lowered by the
// PR_REVIEW_MAX_CALL_USD repository variable. A variable can never raise it.
export function repositoryCeiling(env = process.env) {
  const override = env.PR_REVIEW_MAX_CALL_USD;
  if (override === undefined || override === "") return CONFIG.maxCallUsd;
  const value = Number(override);
  if (!Number.isFinite(value) || value <= 0) throw new SelectionError("Invalid cost ceiling.");
  return Math.min(value, CONFIG.maxCallUsd);
}
export const DAY = 24 * 60 * 60 * 1000;
export function renewalDue(attempt, now = Date.now()) {
  if (!attempt) return true;
  const last = Date.parse(attempt.started_at);
  if (!Number.isFinite(last) || last > now)
    throw new SelectionError("Invalid research attempt timestamp.");
  return now - last >= 14 * DAY;
}

export function validateStoredPolicy(policy, catalog, suite, now = Date.now(), maxCallUsd = 0.05) {
  if (
    suite.ready !== true ||
    policy?.schema !== 2 ||
    !policy.calibration_id ||
    policy.profile_hash !== PROFILE_HASH ||
    policy.suite_sha256 !== suite.hash ||
    !policy.evaluation?.model ||
    policy.evaluation?.grader_hash !== GRADER_HASH ||
    policy.evaluation?.evaluator_hash !== EVALUATOR_HASH ||
    !qualifies(policy.evaluation, suite)
  )
    throw new SelectionError(
      "Representative calibration is required; stale or smoke-only policies cannot invoke paid reviews.",
    );
  const selectedAt = Date.parse(policy.selected_at),
    expiresAt = Date.parse(policy.expires_at),
    graceUntil = Date.parse(policy.grace_until);
  if (
    ![selectedAt, expiresAt, graceUntil].every(Number.isFinite) ||
    selectedAt > now ||
    expiresAt !== selectedAt + 14 * DAY ||
    graceUntil !== expiresAt + 7 * DAY ||
    now > graceUntil
  )
    throw new SelectionError("Reviewer policy is invalid or expired.");
  const current = eligibleModels(
    catalog.filter((m) => m.id === policy.model_id),
    Math.min(maxCallUsd, solPriceCeiling(catalog, REVIEW_PROFILE)),
    REVIEW_PROFILE,
  )[0];
  if (
    !current ||
    policy.evaluation.evidence_key !== evidenceKey(current, suite.hash, EVAL_IMAGE) ||
    current.id !== policy.evaluation.model.id ||
    current.created !== policy.evaluation.model.created ||
    current.reasoning_supported !== policy.evaluation.model.reasoning_supported ||
    current.temperature_supported !== policy.evaluation.model.temperature_supported
  )
    throw new SelectionError(
      "Stored reviewer version/configuration is unavailable, changed or over budget.",
    );
  return {
    model: `openrouter/${current.id}`,
    estimatedCallUsd: current.estimated_call_usd,
    grace: now > expiresAt,
    // A qualified replacement runs exactly as it was evaluated.
    inputTokens: REVIEW_PROFILE.inputTokens,
    reasoningEffort: "",
    reasoningTokens: current.reasoning_supported ? REVIEW_PROFILE.reasoningTokens : 0,
    customReasoningModel: !current.temperature_supported,
  };
}

// A stored replacement needs real qualification. Missing/stale state returns
// the explicit trusted owner baseline, never the old smoke-only selection.
export function loadAcceptedReviewer(
  policy,
  catalog,
  suite,
  now = Date.now(),
  maxCallUsd = CONFIG.maxCallUsd,
) {
  if (policy?.schema === 3 && policy.class_hash === CLASS_HASH) {
    try {
      const selected = validateStoredPolicy(
        { ...policy, schema: 2 },
        catalog,
        suite,
        now,
        classCeiling(catalog, maxCallUsd),
      );
      return { ...selected, acceptance: "TypeSafe-selected, representative checks passed" };
    } catch (error) {
      if (!(error instanceof SelectionError)) throw error;
    }
  }
  const baseline = acceptedBaseline(catalog, maxCallUsd);
  return {
    model: `openrouter/${baseline.id}`,
    estimatedCallUsd: baseline.estimated_call_usd,
    grace: false,
    // DeepSeek ignored a 2,048 reasoning budget and spent all 8,192 output
    // tokens thinking (empty review), so baselines default to thinking off.
    inputTokens: BASELINE_PROFILE.inputTokens,
    reasoningEffort: REVIEWER_CLASS.baselineReasoning === "off" ? "none" : "",
    reasoningTokens:
      REVIEWER_CLASS.baselineReasoning === "off" || !baseline.reasoning_supported
        ? 0
        : REVIEW_PROFILE.reasoningTokens,
    customReasoningModel: false,
    acceptance: "owner-accepted baseline; incomplete benchmark qualification",
  };
}

export async function readState(github, repo, path, ref = STATE_BRANCH) {
  try {
    const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
    if (Array.isArray(data) || data.encoding !== "base64")
      throw new SelectionError("Invalid reviewer state file.");
    return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function writeState(github, repo, path, value) {
  let sha;
  try {
    const { data } = await github.rest.repos.getContent({ ...repo, path, ref: STATE_BRANCH });
    sha = data.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  await github.rest.repos.createOrUpdateFileContents({
    ...repo,
    path,
    branch: STATE_BRANCH,
    sha,
    message: `chore(review): update ${path}`,
    content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString("base64"),
  });
}

export async function loadReviewer({ github, context, core, fetchImpl = fetch }) {
  const policy = await readState(github, context.repo, "policy.json");
  const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new SelectionError("Cannot confirm stored reviewer availability and price.");
  const catalog = await response.json();
  if (!Array.isArray(catalog.data)) throw new SelectionError("Invalid OpenRouter catalog.");
  const selected = loadAcceptedReviewer(
    policy,
    catalog.data,
    await loadSuite(),
    Date.now(),
    repositoryCeiling(),
  );
  if (selected.grace)
    core.warning("Using previous evaluated reviewer during its seven-day renewal grace period.");
  core.setOutput("model", selected.model);
  core.setOutput("input_tokens", String(selected.inputTokens));
  core.setOutput("output_tokens", String(REVIEW_PROFILE.outputTokens));
  core.setOutput("reasoning_effort", selected.reasoningEffort);
  core.setOutput("reasoning_tokens", String(selected.reasoningTokens));
  core.setOutput("custom_reasoning_model", String(selected.customReasoningModel));
  core.info(
    `Stored reviewer ${selected.model}; current estimated call $${selected.estimatedCallUsd.toFixed(4)}.`,
  );
  await core.summary
    .addRaw(
      `Reviewer **${selected.model}** (${selected.acceptance}). Current estimated call: $${selected.estimatedCallUsd.toFixed(4)}.\n`,
    )
    .write();
  return selected;
}
