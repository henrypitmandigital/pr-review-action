import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.mjs";
import { runDocker } from "./docker-run.mjs";
import { SelectionError } from "./model-catalog.mjs";

export const REVIEW_PROFILE = CONFIG.reviewProfile;
// Pinned PR-Agent source checkout and this module's own observer directory.
const SOURCE_DIR = resolve(process.env.PR_AGENT_SOURCE_DIR ?? "vendor/pr-agent");
const OBSERVER_DIR = dirname(fileURLToPath(import.meta.url));
export function callEstimate(model, profile = REVIEW_PROFILE) {
  return (
    (profile.inputTokens * model.input_usd_per_million +
      profile.outputTokens * model.output_usd_per_million) /
      1e6 +
    (model.request_usd ?? 0)
  );
}
export function classifyExecution(result, diagnostics, review) {
  if (result.error?.code === "ETIMEDOUT") return "wall_timeout";
  if (result.error) return "runtime_error";
  if (!diagnostics?.coverage?.length || !diagnostics.attempts?.length) return "missing_diagnostics";
  if (diagnostics.coverage.some((c) => c.omitted_files !== 0)) return "incomplete_coverage";
  if (diagnostics.attempts.at(-1).finish_reason === "length") return "completion_limit";
  // Reasoning is a soft provider request. Total completion and price limits
  // govern spending; retain observed overruns as diagnostics, not quality failures.
  if (
    diagnostics.attempts.some(
      (a) => a.error_category === "AuthenticationError" || a.http_status === 401,
    )
  )
    return "authentication";
  if (
    diagnostics.attempts.some((a) => a.error_category === "RateLimitError" || a.http_status === 429)
  )
    return "rate_limit";
  if (diagnostics.attempts.some((a) => a.error_category === "APITimeoutError"))
    return "provider_timeout";
  if (diagnostics.attempts.some((a) => a.http_status === 400)) return "provider_configuration";
  if (result.status !== 0 || !review) return "review_generation_failed";
  return "completed";
}

export async function evaluateReview(
  model,
  fixture,
  index,
  { image = process.env.PR_AGENT_EVAL_IMAGE, profile = REVIEW_PROFILE, run = runDocker } = {},
) {
  if (!/^pragent\/pr-agent@sha256:[a-f0-9]{64}$/.test(image ?? ""))
    throw new SelectionError("Evaluation runtime must be digest-pinned.");
  if (!/^[a-z0-9-]{1,100}$/.test(String(index)))
    throw new SelectionError("Unsafe evaluation identifier.");
  const directory = resolve(
    process.env.RUNNER_TEMP ?? "/tmp",
    "pr-review-evaluation-v2",
    String(index),
  );
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "case.diff"), fixture.diff);
  const configuration = {
    CONFIG__MODEL: `openrouter/${model.id}`,
    CONFIG__FALLBACK_MODELS: "[]",
    CONFIG__CUSTOM_MODEL_MAX_TOKENS: String(profile.inputTokens),
    CONFIG__MAX_MODEL_TOKENS: String(profile.inputTokens),
    CONFIG__MAX_OUTPUT_TOKENS: String(profile.outputTokens),
    OPENROUTER__MAX_TOKENS: String(profile.outputTokens),
    OPENROUTER__REASONING_MAX_TOKENS: String(
      model.reasoning_supported ? profile.reasoningTokens : 0,
    ),
    CONFIG__CUSTOM_REASONING_MODEL: String(!model.temperature_supported),
    CONFIG__NUM_RETRIES: "0",
    CONFIG__RETRY_SAME_MODEL_ON_TIMEOUT: "false",
    CONFIG__AI_TIMEOUT: "90",
    CONFIG__PROPAGATE_TOOL_ERRORS: "true",
    CONFIG__USE_REPO_SETTINGS_FILE: "false",
    CONFIG__USE_GLOBAL_SETTINGS_FILE: "false",
    CONFIG__REPO_CONTEXT_FILES: "[]",
    CONFIG__PUBLISH_OUTPUT_PROGRESS: "false",
    CONFIG__LOG_LEVEL: "ERROR",
    MODEL_ROUTING__ENABLE: "false",
    PR_REVIEWER__ENABLE_LARGE_PR_CHUNKING: "false",
    PR_REVIEWER__ENABLE_REVIEW_LABELS_SECURITY: "false",
    PR_REVIEWER__ENABLE_REVIEW_LABELS_EFFORT: "false",
    PR_REVIEWER__REQUIRE_TICKET_ANALYSIS_REVIEW: "false",
  };
  const env = { ...process.env, ...configuration };
  const args = [
    "--rm",
    "--network",
    "bridge",
    "-v",
    `${directory}:/evaluation`,
    "-v",
    `${SOURCE_DIR}:/opt/pr-agent:ro`,
    "-v",
    `${OBSERVER_DIR}:/observer:ro`,
    "-w",
    "/evaluation",
    "--entrypoint",
    "python",
    "-e",
    "PYTHONPATH=/opt/pr-agent",
    "-e",
    "PR_REVIEW_DIAGNOSTICS_PATH=/evaluation/diagnostics.json",
    "-e",
    "OPENROUTER_API_KEY",
    ...Object.keys(configuration).flatMap((key) => ["-e", key]),
    image,
    "/observer/observe_review.py",
    "--diff-file",
    "/evaluation/case.diff",
    "--json-output",
    "/evaluation/review.json",
    "review",
  ];
  const start = Date.now();
  const result = run(args, { env, timeout: 240000 });
  let output, diagnostics;
  try {
    output = JSON.parse(await readFile(resolve(directory, "review.json"), "utf8"));
  } catch {
    /* absent review is classified below */
  }
  try {
    diagnostics = JSON.parse(await readFile(resolve(directory, "diagnostics.json"), "utf8"));
  } catch {
    /* missing audit fails closed */
  }
  return {
    fixture_id: fixture.id,
    execution: classifyExecution(result, diagnostics, output?.review),
    elapsed_ms: Date.now() - start,
    diagnostics,
    review: output?.review ?? null,
    usage: output?.usage ?? null,
  };
}
