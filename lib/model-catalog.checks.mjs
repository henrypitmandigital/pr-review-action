import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildCandidates,
  eligibleModels,
  failureReason,
  POLICY,
  PRICE_REFERENCE,
  SelectionError,
  solPriceCeiling,
} from "./model-catalog.mjs";

function catalogModel(id = "vendor/new-model", overrides = {}) {
  return {
    id,
    created: 100,
    description: "Code reasoning model",
    context_length: 200000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["temperature", "max_tokens"],
    pricing: { prompt: "0.0000005", completion: "0.000002" },
    ...overrides,
  };
}

test("discovers previously unknown models from the live catalog within five cents", () => {
  const [model] = buildCandidates([catalogModel("new-provider/future-version")]);
  assert.equal(model.id, "new-provider/future-version");
  assert.equal(model.estimated_call_usd, 32000 * 0.0000005 + 8192 * 0.000002);
  assert.ok(model.estimated_call_usd < POLICY.maxCallUsd);
});
test("fresh Sol price caps comparable candidates and fails closed without the reference", () => {
  const profile = { inputTokens: 32000, outputTokens: 8192 };
  const sol = catalogModel(PRICE_REFERENCE, {
    pricing: { prompt: "0.000002", completion: "0.00001" },
  });
  const cheap = catalogModel("deepseek/new-flash", {
    pricing: { prompt: "0.00000003", completion: "0.0000005" },
  });
  const expensive = catalogModel("qwen/expensive", {
    pricing: { prompt: "0.000003", completion: "0.000015" },
  });
  const ceiling = solPriceCeiling([sol, cheap, expensive], profile);
  assert.equal(ceiling, 0.14592);
  assert.deepEqual(
    eligibleModels([sol, cheap, expensive], ceiling, profile).map((m) => m.id),
    [PRICE_REFERENCE, cheap.id],
  );
  assert.throws(() => solPriceCeiling([cheap], profile), /reference unavailable/);
  assert.equal(
    solPriceCeiling([{ ...sol, pricing: { prompt: "0.000001", completion: "0.000005" } }], profile),
    ceiling / 2,
  );
});

for (const [name, overrides] of Object.entries({
  expensive: { pricing: { prompt: "0.000003", completion: "0.000015" } },
  missingPrice: { pricing: {} },
  negativePrice: { pricing: { prompt: "-1", completion: "0" } },
  maliciousId: { id: "vendor/model\nINJECT=value" },
  shortContext: { context_length: 16000 },
  shortOutput: { top_provider: { max_completion_tokens: 1024 } },
  imageOnly: { architecture: { input_modalities: ["image"], output_modalities: ["image"] } },
  incompatible: { supported_parameters: ["temperature"] },
})) {
  test(`excludes ${name}`, () =>
    assert.deepEqual(buildCandidates([catalogModel(undefined, overrides)]), []));
}

test("accounts for request charges and rejects invalid budget", () => {
  assert.deepEqual(
    buildCandidates([
      catalogModel(undefined, { pricing: { prompt: "0", completion: "0", request: "0.06" } }),
    ]),
    [],
  );
  assert.throws(() => buildCandidates([], NaN));
  assert.throws(() => buildCandidates([], 0));
});

test("bounds the shortlist, retaining inexpensive older models alongside new ones", () => {
  const models = Array.from({ length: 80 }, (_, i) =>
    catalogModel(`vendor/model-${i}`, { created: i + 1 }),
  );
  models[0].pricing = { prompt: "0", completion: "0" };
  const shortlist = buildCandidates(models);
  assert.ok(shortlist.length <= 32);
  assert.ok(shortlist.some(({ id }) => id === "vendor/model-79"));
  assert.ok(shortlist.some(({ id }) => id === "vendor/model-0"));
});

test("diagnostics never disclose provider messages or input", () => {
  const secret = new Error("secret and private PR input");
  secret.status = 401;
  assert.equal(failureReason(secret).includes("secret"), false);
  assert.ok(failureReason(secret).includes("HTTP 401"));
  assert.equal(
    failureReason(new SelectionError("No sufficiently suitable reviewer.")),
    "No sufficiently suitable reviewer.",
  );
});

test("reasoning models without temperature remain eligible and retain compatibility metadata", () => {
  const [model] = buildCandidates([
    catalogModel("vendor/reasoning", {
      supported_parameters: ["max_completion_tokens", "reasoning"],
    }),
  ]);
  assert.equal(model.temperature_supported, false);
  assert.equal(model.reasoning_supported, true);
});

test("ambiguous versions and missing metadata fail closed", () => {
  const m = catalogModel();
  assert.deepEqual(eligibleModels([m, { ...m, created: 101 }]), []);
  assert.deepEqual(eligibleModels([{ ...m, created: undefined }]), []);
  assert.deepEqual(eligibleModels([{ ...m, supported_parameters: "max_tokens" }]), []);
  assert.deepEqual(eligibleModels([{ ...m, context_length: 32000 }]), []);
});

test("active context-price tiers cannot bypass the per-call ceiling", () => {
  const m = catalogModel();
  const expensive = {
    ...m,
    pricing: {
      ...m.pricing,
      overrides: [{ min_prompt_tokens: 32000, prompt: "0.000003", completion: "0.000015" }],
    },
  };
  assert.deepEqual(eligibleModels([expensive]), []);
  const futureTier = {
    ...m,
    pricing: {
      ...m.pricing,
      overrides: [{ min_prompt_tokens: 272000, prompt: "0.000003", completion: "0.000015" }],
    },
  };
  assert.equal(
    eligibleModels([futureTier])[0].estimated_call_usd,
    eligibleModels([m])[0].estimated_call_usd,
  );
  assert.deepEqual(
    eligibleModels([
      { ...m, pricing: { ...m.pricing, overrides: [{ min_prompt_tokens: "unknown" }] } },
    ]),
    [],
  );
});

test("captured OpenRouter DeepSeek weekly schedule remains inside the approved ceiling", () => {
  // Public /api/v1/models metadata captured 2026-10-14; no paid inference.
  const model = JSON.parse(
    readFileSync(new URL("../test/openrouter-timed-pricing.json", import.meta.url)),
  );
  const [selected] = eligibleModels([model], 0.023514);
  assert.equal(selected?.estimated_call_usd, 0.0194304);
  assert.deepEqual(eligibleModels([model], 0.019), []);
});

test("weekly timed pricing stays eligible using the most expensive rates", () => {
  const m = catalogModel("deepseek/deepseek-v4.1-flash", {
    pricing: {
      prompt: "0.00000014",
      completion: "0.00000021",
      overrides: [
        {
          utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          utc_start: 30,
          utc_end: 1630,
          prompt: "0.00000056",
          completion: "0.00000084",
        },
        {
          utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          utc_start: 1630,
          utc_end: 30,
          prompt: "0.00000028",
          completion: "0.00000042",
        },
        { utc_days: ["saturday", "sunday"], prompt: "0.00000028", completion: "0.00000042" },
      ],
    },
  });
  const expected = 32000 * 0.00000056 + 8192 * 0.00000084;
  assert.equal(eligibleModels([m])[0]?.estimated_call_usd, expected);
  assert.deepEqual(eligibleModels([m], expected - 0.000001), []);
  m.pricing.prompt = "0.00000056";
  m.pricing.completion = "0.00000084";
  assert.equal(eligibleModels([m])[0]?.estimated_call_usd, expected);
});

test("partial and overlapping overrides cannot underprice any supported token tier", () => {
  const m = catalogModel(undefined, {
    pricing: {
      prompt: "0",
      completion: "0",
      overrides: [
        { min_prompt_tokens: 1000, prompt: "0.000001" },
        { min_prompt_tokens: 2000, completion: "0.000002" },
        { utc_start: 2300, utc_end: 100, request: "0.001" },
        { min_prompt_tokens: 3000, prompt: "0.0000001" },
        { min_prompt_tokens: 32001, completion: "1" },
      ],
    },
  });
  assert.equal(eligibleModels([m])[0]?.estimated_call_usd, 0.049384);
  assert.deepEqual(eligibleModels([m], 0.049), []);
});

for (const override of [
  null,
  [],
  {},
  { min_prompt_tokens: -1 },
  { min_prompt_tokens: "0" },
  { utc_start: 30 },
  { utc_end: 1630 },
  { utc_start: 1260, utc_end: 1630 },
  { utc_start: -1, utc_end: 0 },
  { utc_start: 0, utc_end: 2400 },
  { utc_start: "30", utc_end: 1630 },
  { utc_start: 0.5, utc_end: 30 },
  { utc_days: [] },
  { utc_days: ["Monday"] },
  { utc_days: ["monday", "monday"] },
  { utc_days: "monday" },
  { utc_days: null },
  { region: "us", prompt: "0" },
  { min_prompt_tokens: 999999, prompt: "-1" },
  { utc_days: ["monday"], completion: null },
  { utc_days: ["monday"], input_cache_read: "bad" },
  { min_prompt_tokens: 0, request: "Infinity" },
]) {
  test(`rejects malformed or unknown override ${JSON.stringify(override)}`, () => {
    const m = catalogModel();
    m.pricing.overrides = [override];
    assert.deepEqual(eligibleModels([m]), []);
  });
}

test("timed prices cannot hide invalid base rates or arithmetic overflow", () => {
  const m = catalogModel();
  m.pricing = {
    prompt: "bad",
    completion: "0",
    overrides: [{ utc_start: 0, utc_end: 0, prompt: "0" }],
  };
  assert.deepEqual(eligibleModels([m]), []);
  m.pricing = { prompt: "1e308", completion: "0" };
  assert.deepEqual(eligibleModels([m], Number.MAX_VALUE), []);
});
