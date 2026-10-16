import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { REVIEW_PROFILE } from "./evaluate.mjs";
import { SelectionError } from "./model-catalog.mjs";

export const PROFILE_HASH = createHash("sha256")
  .update(JSON.stringify(REVIEW_PROFILE))
  .digest("hex");
export const EVAL_IMAGE =
  "pragent/pr-agent@sha256:65e5b196e38cecd7df8a71fe29942052e081a0c6645132c2ac874df60b1760c7";
export const SOURCE_SHA = "1d01f24f455bb879c1d9c557ad7de3d72dcc7975";
export const TYPESAFE_SDK = "@typesafe-ai/sdk@0.6.0";
export const GRADER_HASH = createHash("sha256")
  .update(readFileSync(new URL("./grade.mjs", import.meta.url)))
  .update(`${TYPESAFE_SDK}:jev-latest`)
  .digest("hex");
export const EVALUATOR_HASH = createHash("sha256")
  .update(readFileSync(new URL("./evaluate.mjs", import.meta.url)))
  .update(readFileSync(new URL("./observe_review.py", import.meta.url)))
  .update(readFileSync(new URL("./docker-run.mjs", import.meta.url)))
  .digest("hex");
// Exclude measured reasoning failures only for this exact version and harness.
// Transport errors and uncertain judgments do not establish poor review quality.
export function failedQuality(history, model, suite, image) {
  const key = evidenceKey(model, suite.hash, image);
  return (
    history.entries?.some((entry) =>
      entry.models?.some(
        (m) =>
          m.evidence_key === key &&
          m.cases?.some(
            (c) => c.reason === "graded" && (c.finding === "missed" || c.claims === "unsupported"),
          ),
      ),
    ) ?? false
  );
}
export function evidenceKey(model, suiteHash, image) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        model.id,
        model.created,
        model.temperature_supported,
        model.reasoning_supported,
        suiteHash,
        PROFILE_HASH,
        GRADER_HASH,
        EVALUATOR_HASH,
        SOURCE_SHA,
        image,
      ]),
    )
    .digest("hex");
}
export function qualifies(result, suite) {
  return (
    result?.outputs?.length === suite.cases.length &&
    result.cases?.length === suite.cases.length &&
    suite.cases.every(
      (c) =>
        result.outputs.some((o) => o.fixture_id === c.id && o.execution === "completed") &&
        result.cases.some((g) => g.id === c.id && g.passed === true),
    )
  );
}
export function selectWinner(results, suite, incumbentId, maxCallUsd = 0.05) {
  const passing = results.filter(
    (r) => qualifies(r, suite) && r.model.estimated_call_usd <= maxCallUsd,
  );
  if (!passing.length)
    throw new SelectionError("No production-priced model passed the representative quality gate.");
  const cheapest = [...passing].sort(
    (a, b) => a.model.estimated_call_usd - b.model.estimated_call_usd,
  )[0];
  const incumbent = passing.find((r) => r.model.id === incumbentId);
  // Equal benchmark quality requires a meaningful cost improvement to switch.
  return incumbent && cheapest.model.estimated_call_usd > incumbent.model.estimated_call_usd * 0.9
    ? incumbent
    : cheapest;
}
export function reusable(result, model, suite, image, now = Date.now()) {
  return (
    result?.evidence_key === evidenceKey(model, suite.hash, image) &&
    qualifies(result, suite) &&
    Number.isFinite(Date.parse(result.evaluated_at)) &&
    now - Date.parse(result.evaluated_at) >= 0 &&
    now - Date.parse(result.evaluated_at) <= 28 * 86400000
  );
}
