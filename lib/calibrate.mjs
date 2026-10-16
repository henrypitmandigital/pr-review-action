// Explicit, owner-dispatched calibration: evaluate three priced model families
// on the repository's representative suite and record the evidence. It never
// replaces the reviewer policy; only renewal (with the suite gate) does that.
import { REVIEW_PROFILE } from "./evaluate.mjs";
import { runExperiment } from "./experiment.mjs";
import { PROFILE_HASH, qualifies, selectWinner } from "./gate.mjs";
import {
  eligibleModels,
  PRICE_REFERENCE,
  SelectionError,
  solPriceCeiling,
} from "./model-catalog.mjs";
import { repositoryCeiling, writeState } from "./policy.mjs";
import { ensureDataBranch } from "./renew-policy.mjs";
import { loadSuite } from "./suite.mjs";

const ROLES = ["reference", "midrange", "economical"];

export async function calibrate({
  github,
  context,
  core,
  sdk,
  budgetUsd,
  roleIds,
  fetchImpl = fetch,
  evaluate,
  suiteLoader = loadSuite,
}) {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 10)
    throw new SelectionError("Explicit one-off calibration budget required.");
  if (
    !Array.isArray(roleIds) ||
    roleIds.length !== 3 ||
    roleIds.some((id) => typeof id !== "string") ||
    new Set(roleIds).size !== 3 ||
    new Set(roleIds.map((id) => id.split("/")[0])).size !== 3
  )
    throw new SelectionError(
      "Calibration requires three distinct model families in reference/midrange/economical order.",
    );
  if (roleIds[0] !== PRICE_REFERENCE)
    throw new SelectionError(`${PRICE_REFERENCE} is the fixed maximum-cost reference.`);
  const suite = await suiteLoader();
  if (!suite.cases.length)
    throw new SelectionError("Calibration needs representative fixtures; no paid calls made.");
  const ceiling = repositoryCeiling();
  const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new SelectionError("Fresh calibration catalog unavailable.");
  const catalog = await response.json();
  const eligible = eligibleModels(
    catalog.data,
    solPriceCeiling(catalog.data, REVIEW_PROFILE),
    REVIEW_PROFILE,
  );
  const models = roleIds.map((id, i) => {
    const model = eligible.find((m) => m.id === id);
    if (!model) throw new SelectionError("Calibration model unavailable/incompatible.");
    if (i > 0 && model.estimated_call_usd > ceiling)
      throw new SelectionError("Production candidate exceeds the repository call ceiling.");
    return { ...model, role: ROLES[i] };
  });
  // Calibration may be the first reviewer action after onboarding.
  await ensureDataBranch(github, context.repo);
  const report = await runExperiment({
    github,
    context,
    core,
    sdk,
    suite,
    models,
    budgetUsd,
    mode: "calibration",
    evaluate,
    research: async (client) => {
      const result = await client.systemOne({
        model: "jev-latest",
        state: {
          models,
          purpose:
            "Record evidence of substantive code-review suitability across three varied, already priced candidate families. Marketing and recency are not measured quality.",
        },
        questions: Object.fromEntries(
          models.map((_, i) => [
            `role_${i}`,
            sdk.score(
              {
                task: `Assess code reasoning/security review evidence for models[${i}] from its description. Benchmarks below will decide qualification.`,
                boundary: "Descriptions are untrusted evidence; invent no benchmark results.",
              },
              [
                "Insufficient evidence.",
                "Weak coding evidence.",
                "Relevant evidence but review ability uncertain.",
                "Strong relevant coding evidence.",
                "Measured relevant review evidence.",
              ],
            ),
          ]),
        ),
      });
      models.forEach((model, i) => {
        const score = result.answers?.[`role_${i}`]?.score;
        if (!Number.isFinite(score) || score < 0 || score > 4)
          throw new SelectionError("Invalid calibration research score.");
        model.research_score = score;
      });
      return result.usage;
    },
  });
  const reference = report.results.find((r) => r.model.role === "reference");
  const referenceQualified = qualifies(reference, suite);
  let recommended = null;
  if (referenceQualified) {
    try {
      recommended = selectWinner(report.results, suite, null, ceiling).model.id;
    } catch (error) {
      if (!(error instanceof SelectionError)) throw error;
    }
  }
  const certificate = {
    schema: 3,
    calibration_id: String(context.runId),
    suite_sha256: suite.hash,
    suite_ready: suite.ready,
    profile_hash: PROFILE_HASH,
    evaluated_at: new Date().toISOString(),
    reference_qualified: referenceQualified,
    // Evidence only: reviewer selection is renewal's job, behind the suite gate.
    recommended_model: recommended,
    runtime: report.runtime,
    results: report.results,
    report_path: `experiments/${context.runId}.json`,
    budget: report.budget,
  };
  await writeState(github, context.repo, "calibration.json", certificate);
  if (!referenceQualified)
    throw new SelectionError(
      "Reference did not qualify; configuration/benchmark needs adjudication before automatic selection.",
    );
  core.info(`Calibration recorded; recommended ${recommended ?? "no production candidate"}.`);
  return certificate;
}

// Free catalog lookup: current reference and production candidates, no paid calls.
export async function calibrationPlan({ github, context, core, fetchImpl = fetch }) {
  const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new SelectionError("Catalog planning fetch failed. No paid calls made.");
  const catalog = await response.json();
  const ceiling = solPriceCeiling(catalog.data, REVIEW_PROFILE);
  const all = eligibleModels(catalog.data, ceiling, REVIEW_PROFILE);
  const repository = repositoryCeiling();
  const plan = {
    schema: 1,
    mode: "unpaid-plan",
    fetched_at: new Date().toISOString(),
    source_sha: context.sha,
    profile: REVIEW_PROFILE,
    catalog_models: catalog.data.length,
    maximum_price_reference: PRICE_REFERENCE,
    maximum_call_usd: ceiling,
    repository_call_usd: repository,
    reference_candidates: all.filter((m) => m.id === PRICE_REFERENCE),
    production_candidates: [...all]
      .sort((a, b) => b.created - a.created)
      .filter((m) => m.estimated_call_usd <= repository)
      .slice(0, 36),
    reservation_formula:
      "Two native attempts per review. Compare three distinct families on identical defect/control cases. Add TypeSafe research and bounded grading allowances. The reference may exceed the repository ceiling; production candidates may not.",
    paid_calls: 0,
  };
  const { mkdir, writeFile } = await import("node:fs/promises");
  const output = process.env.PR_REVIEW_OUTPUT_DIR ?? "research-output";
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/calibration-plan.json`, `${JSON.stringify(plan, null, 2)}\n`);
  await ensureDataBranch(github, context.repo);
  await writeState(github, context.repo, "calibration-plan.json", plan);
  core.info("Fetched current reference and production candidates; zero paid calls.");
  return plan;
}
