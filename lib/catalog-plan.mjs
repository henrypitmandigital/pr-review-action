import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_PROFILE } from "./evaluate.mjs";
import {
  eligibleModels,
  failureReason,
  PRICE_REFERENCE,
  SelectionError,
  solPriceCeiling,
} from "./model-catalog.mjs";
import { repositoryCeiling } from "./policy.mjs";
import {
  acceptedBaseline,
  BASELINE_PROFILE,
  classCeiling,
  REVIEWER_CLASS,
} from "./reviewer-class.mjs";

// Free catalog lookup only; no credentials, inference or state mutation.
export async function catalogPlan(fetchImpl = fetch) {
  const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new SelectionError("Fresh OpenRouter catalog unavailable.");
  const catalog = (await response.json()).data;
  if (!Array.isArray(catalog)) throw new SelectionError("Invalid OpenRouter catalog.");
  const report = {
    schema: 1,
    fetched_at: new Date().toISOString(),
    profile: REVIEW_PROFILE,
    owner_acceptance: `${REVIEWER_CLASS.baseline}; not benchmark-qualified`,
    expected_created: REVIEWER_CLASS.created,
    model_snapshots: catalog
      .filter((m) => [REVIEWER_CLASS.baseline, PRICE_REFERENCE].includes(m?.id))
      .map((m) => ({
        id: m.id,
        created: m.created,
        context_length: m.context_length,
        supported_parameters: m.supported_parameters,
        pricing: m.pricing,
        top_provider: m.top_provider,
      })),
    current_prices: eligibleModels(
      catalog.filter((m) => [REVIEWER_CLASS.baseline, PRICE_REFERENCE].includes(m?.id)),
      Number.MAX_VALUE,
      REVIEW_PROFILE,
    ),
    inference_calls: 0,
  };
  try {
    const ceiling = repositoryCeiling();
    report.ceiling_usd = classCeiling(catalog, ceiling);
    report.baseline_ceiling_usd = Math.min(
      ceiling,
      REVIEWER_CLASS.baselineMaxCallUsd,
      solPriceCeiling(catalog, BASELINE_PROFILE),
    );
    report.baseline = acceptedBaseline(catalog, ceiling);
    report.activation_preflight = "passed";
  } catch (error) {
    report.activation_preflight = "blocked";
    report.reason = failureReason(error);
  }
  // Descriptions are untrusted and unnecessary in this activation evidence.
  report.current_prices = report.current_prices.map(({ description: _description, ...m }) => m);
  if (report.baseline) {
    const { description: _description, ...baseline } = report.baseline;
    report.baseline = baseline;
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new SelectionError("Catalog plan output path required.");
  const report = await catalogPlan();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  if (report.activation_preflight !== "passed") process.exitCode = 1;
}
