import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { callEstimate, evaluateReview } from "./evaluate.mjs";
import { EVALUATOR_HASH, evidenceKey, GRADER_HASH, PROFILE_HASH, SOURCE_SHA } from "./gate.mjs";
import { gradeBatch, gradingGroups } from "./grade.mjs";
import { failureReason, SelectionError } from "./model-catalog.mjs";
import { readState, writeState } from "./policy.mjs";

export class ExperimentBudget {
  constructor(limit) {
    if (!Number.isFinite(limit) || limit <= 0 || limit > 10)
      throw new SelectionError("Experiment budget must be explicitly set between zero and $10.");
    this.limit = limit;
    this.reserved = 0;
    this.entries = [];
  }
  reserve(kind, usd) {
    if (!Number.isFinite(usd) || usd < 0 || this.reserved + usd > this.limit + 1e-9)
      throw new SelectionError("Experiment exceeds its approved planning budget.");
    this.reserved += usd;
    this.entries.push({ kind, usd });
  }
}

export async function runExperiment({
  github,
  context,
  core,
  sdk,
  suite,
  models,
  budgetUsd,
  mode,
  prior = [],
  evaluate = evaluateReview,
  research,
  preclaimed = false,
  researchAllowance = 0.1,
}) {
  if (!["calibration", "renewal"].includes(mode) || (mode === "renewal" && budgetUsd !== 1))
    throw new SelectionError("Invalid experiment mode/budget.");
  if (preclaimed) {
    const claim = await readState(github, context.repo, "attempt.json");
    if (
      mode !== "renewal" ||
      (claim?.execution_run_id ?? claim?.run_id) !== String(context.runId) ||
      claim.reserved_usd !== 1 ||
      claim.status !== "inference_started"
    )
      throw new SelectionError("Paid renewal needs its durable full-cycle claim.");
  }
  const planId = createHash("sha256")
    .update(
      JSON.stringify([context.sha, models.map((m) => [m.id, m.created]), suite.hash, PROFILE_HASH]),
    )
    .digest("hex");
  const claimPath = mode === "calibration" ? `calibration-claims/${planId}.json` : "attempt.json";
  if (mode === "calibration" && (await readState(github, context.repo, claimPath)))
    throw new SelectionError("Calibration already claimed; retries require a new reviewed plan.");
  const budget = new ExperimentBudget(budgetUsd);
  if (![0.1, 0.2].includes(researchAllowance))
    throw new SelectionError("Invalid research allowance.");
  budget.reserve("TypeSafe bounded research allowance", researchAllowance);
  // Ten separate source-shared judgments fit the validated request shape.
  // A $0.10 allowance per batch is a planning estimate, not a billing cap.
  const freshModels = models.filter((model) => !prior.some((p) => p.model.id === model.id));
  const groups = gradingGroups(suite, freshModels.length);
  budget.reserve("TypeSafe bounded grading allowances", groups.length * 0.1);
  for (const model of models)
    if (!prior.some((p) => p.model.id === model.id))
      budget.reserve(
        `PR-Agent ${model.id}, ${suite.cases.length} cases, two attempts`,
        callEstimate(model) * suite.cases.length * 2,
      );
  const image = process.env.PR_AGENT_EVAL_IMAGE;
  const report = {
    schema: 2,
    mode,
    run_id: String(context.runId),
    source_sha: context.sha,
    started_at: new Date().toISOString(),
    suite_sha256: suite.hash,
    profile_hash: PROFILE_HASH,
    profile: { inputTokens: 32000, outputTokens: 8192, reasoningTokens: 2048 },
    runtime: { image, source_sha: SOURCE_SHA },
    budget,
    results: [...prior],
    typesafe_usage: [],
    status: "claimed",
  };
  // Reserve the full plan atomically before any paid operation. No automatic
  // resumption or second paid attempt of a claimed experiment.
  if (!preclaimed)
    await writeState(github, context.repo, claimPath, {
      schema: 2,
      started_at: report.started_at,
      run_id: report.run_id,
      source_sha: context.sha,
      status: "claimed",
      budget,
    });
  const output = process.env.PR_REVIEW_OUTPUT_DIR ?? "research-output";
  await mkdir(output, { recursive: true });
  const persist = async () => {
    await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
    await writeState(github, context.repo, `experiments/${context.runId}.json`, report);
  };
  await persist();
  const client = new sdk.TypeSafeClient({
    timeout: 60000,
    retry: { maxRetries: 0 },
    logLevel: "off",
  });
  try {
    if (research)
      report.typesafe_usage.push({ purpose: "research", usage: await research(client) });
    for (const [m, model] of models.entries()) {
      if (report.results.some((r) => r.model.id === model.id)) continue;
      const result = {
        model,
        outputs: [],
        cases: [],
        grader_hash: GRADER_HASH,
        evaluator_hash: EVALUATOR_HASH,
        evidence_key: evidenceKey(model, suite.hash, image),
        evaluated_at: new Date().toISOString(),
      };
      report.results.push(result);
      for (const [c, fixture] of suite.cases.entries()) {
        const output = await evaluate(model, fixture, `${context.runId}-${m}-${c}`);
        result.outputs.push(output);
        core.info(`${model.id}: ${fixture.id}, ${output.execution}.`);
        await persist();
        if (output.execution !== "completed") {
          for (const remaining of suite.cases.slice(c + 1))
            result.outputs.push({
              fixture_id: remaining.id,
              execution: "not_run_after_failure",
              review: null,
            });
          await persist();
          break;
        }
      }
    }
    const freshResults = report.results.filter((r) => freshModels.some((m) => m.id === r.model.id));
    for (const fixtures of groups) {
      const rows = fixtures.map((f) =>
        freshResults.map((r) => r.outputs.find((o) => o.fixture_id === f.id)),
      );
      const judged = await gradeBatch(fixtures, rows, { client, sdk });
      if (judged.usage)
        report.typesafe_usage.push({
          purpose: `grade:${fixtures.map((f) => f.id).join(",")}`,
          usage: judged.usage,
          typesafe_model: judged.typesafe_model,
        });
      report.judge_controls ??= [];
      report.judge_controls.push(...(judged.controls ?? []));
      fixtures.forEach((f, c) => {
        freshResults.forEach((r, m) => {
          r.cases.push({ id: f.id, ...judged.grades[c][m] });
        });
      });
      await persist();
      if (judged.controlsPassed === false)
        throw new SelectionError(
          "Judge failed a source-grounded sanity control; manual adjudication required.",
        );
    }
    report.status = "evaluated";
    await persist();
  } catch (error) {
    report.status = "failed";
    report.failure = failureReason(error);
    await persist();
    throw error;
  } finally {
    const history = (await readState(github, context.repo, "history.json")) ?? {
      schema: 2,
      entries: [],
    };
    history.entries.push({
      run_id: report.run_id,
      mode,
      suite_sha256: suite.hash,
      profile_hash: PROFILE_HASH,
      evaluated_at: report.started_at,
      models: report.results.map((r) => ({
        id: r.model.id,
        created: r.model.created,
        cases: r.cases,
        executions: r.outputs.map((o) => ({ fixture_id: o.fixture_id, execution: o.execution })),
        evidence_key: r.evidence_key,
      })),
      report_path: `experiments/${context.runId}.json`,
    });
    history.entries = history.entries.slice(-100);
    await writeState(github, context.repo, "history.json", history);
  }
  return report;
}
