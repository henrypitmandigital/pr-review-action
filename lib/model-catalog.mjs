// Trusted catalog parsing and error reporting shared by renewal and manual review.
export class SelectionError extends Error {}

// Report only errors we constructed or validated provider categories/statuses.
export function failureReason(error) {
  if (error instanceof SelectionError) return error.message;
  const safeNames = [
    "APIError",
    "AuthenticationError",
    "PermissionDeniedError",
    "BadRequestError",
    "RateLimitError",
    "APITimeoutError",
    "APIConnectionError",
    "TypeSafeError",
  ];
  const name = safeNames.includes(error?.constructor?.name)
    ? error.constructor.name
    : "upstream error";
  const status =
    Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
      ? ` (HTTP ${error.status})`
      : "";
  return `Reviewer selection failed: ${name}${status}. Provider response/input details are suppressed.`;
}

export const POLICY = Object.freeze({
  inputTokens: 32000,
  outputTokens: 8192,
  maxCallUsd: 0.05,
  newestCandidates: 24,
  cheapestCandidates: 8,
});
export const PRICE_REFERENCE = "openai/gpt-6.1-sol";

// Owner's maximum-priced option; compare identical configured token limits.
// This price bound never relaxes the separate normal $0.05 call estimate.
export function solPriceCeiling(models, limits = POLICY) {
  if (!Array.isArray(models)) throw new SelectionError("Invalid catalog.");
  const reference = eligibleModels(
    models.filter((m) => m?.id === PRICE_REFERENCE),
    Number.MAX_VALUE,
    limits,
  )[0];
  if (!reference)
    throw new SelectionError("GPT-6.1 Sol price reference unavailable; no paid reviewer selected.");
  return reference.estimated_call_usd;
}

export function eligibleModels(models, maxCallUsd = POLICY.maxCallUsd, limits = POLICY) {
  if (!Number.isFinite(maxCallUsd) || maxCallUsd <= 0)
    throw new SelectionError("Invalid cost ceiling.");
  if (
    !Array.isArray(models) ||
    ![limits.inputTokens, limits.outputTokens].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw new SelectionError("Invalid catalog or token limits.");
  const eligible = new Map();
  const counts = new Map();
  for (const model of models) {
    if (typeof model?.id === "string") counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
  }
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const id = model.id;
    if (counts.get(id) !== 1 || !Number.isSafeInteger(model.created) || model.created <= 0)
      continue;
    // Catalog IDs are data, never URLs, command arguments or arbitrary expressions.
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/.test(id))
      continue;
    if (!Array.isArray(model.supported_parameters)) continue;
    if (
      !model.architecture?.input_modalities?.includes("text") ||
      !model.architecture?.output_modalities?.includes("text")
    )
      continue;
    if (
      !model.supported_parameters?.includes("max_tokens") &&
      !model.supported_parameters?.includes("max_completion_tokens")
    )
      continue;
    if (
      !Number.isFinite(model.context_length) ||
      model.context_length < limits.inputTokens + limits.outputTokens
    )
      continue;
    const limit = model.top_provider?.max_completion_tokens;
    if (limit != null && (!Number.isFinite(limit) || limit < limits.outputTokens)) continue;
    const prices = conservativePrices(model.pricing, limits.inputTokens);
    if (!prices) continue;
    const { prompt, completion, request } = prices;
    const estimate = limits.inputTokens * prompt + limits.outputTokens * completion + request;
    if (!Number.isFinite(estimate) || estimate > maxCallUsd) continue;
    eligible.set(id, {
      id,
      description: clip(model.description, 700),
      temperature_supported: model.supported_parameters.includes("temperature"),
      reasoning_supported:
        model.supported_parameters.includes("reasoning") ||
        model.supported_parameters.includes("reasoning_effort"),
      created: model.created,
      context_tokens: model.context_length,
      estimated_call_usd: estimate,
      input_usd_per_million: prompt * 1e6,
      output_usd_per_million: completion * 1e6,
      request_usd: request,
    });
  }
  return [...eligible.values()];
}

export function buildCandidates(models, maxCallUsd = POLICY.maxCallUsd, limits = POLICY) {
  const all = eligibleModels(models, maxCallUsd, limits);
  const newest = [...all]
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
    .slice(0, POLICY.newestCandidates);
  const cheapest = [...all]
    .sort(
      (a, b) =>
        a.estimated_call_usd - b.estimated_call_usd ||
        b.created - a.created ||
        a.id.localeCompare(b.id),
    )
    .slice(0, POLICY.cheapestCandidates);
  return [...new Map([...newest, ...cheapest].map((model) => [model.id, model])).values()];
}

const clip = (value, length) => String(value ?? "").slice(0, length);

const PRICE_KEYS = new Set([
  "prompt",
  "completion",
  "request",
  "image",
  "web_search",
  "internal_reasoning",
  "input_cache_read",
  "input_cache_write",
  "input_cache_write_1h",
  "input_audio_cache",
  "audio",
]);
const CONDITION_KEYS = new Set(["min_prompt_tokens", "utc_start", "utc_end", "utc_days"]);
const WEEKDAYS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
const parsePrice = (value) =>
  typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
const validPrice = (value) => Number.isFinite(parsePrice(value)) && parsePrice(value) >= 0;
const validClock = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 2359 && value % 100 < 60;

// OpenRouter: https://openrouter.ai/docs/guides/overview/models#pricing-overrides
// Bound every possible request instant and prompt size up to the configured limit.
// Per-key maxima also bound overlapping/partial overrides and later-entry precedence,
// deliberately overestimating mutually exclusive rates rather than racing the clock.
function conservativePrices(pricing, inputTokens) {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return null;
  const prices = {
    prompt: parsePrice(pricing.prompt),
    completion: parsePrice(pricing.completion),
    request: pricing.request == null ? 0 : parsePrice(pricing.request),
  };
  if (!Object.values(prices).every((price) => Number.isFinite(price) && price >= 0)) return null;
  if (pricing.overrides === undefined) return prices;
  if (!Array.isArray(pricing.overrides)) return null;
  for (const entry of pricing.overrides) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const keys = Object.keys(entry);
    if (!keys.some((key) => CONDITION_KEYS.has(key))) return null;
    if (keys.some((key) => !CONDITION_KEYS.has(key) && !PRICE_KEYS.has(key))) return null;
    if (keys.some((key) => PRICE_KEYS.has(key) && !validPrice(entry[key]))) return null;
    if (
      "min_prompt_tokens" in entry &&
      (!Number.isSafeInteger(entry.min_prompt_tokens) || entry.min_prompt_tokens < 0)
    )
      return null;
    if (
      ("utc_start" in entry || "utc_end" in entry) &&
      (!validClock(entry.utc_start) || !validClock(entry.utc_end))
    )
      return null;
    if ("utc_days" in entry) {
      const days = entry.utc_days;
      if (
        !Array.isArray(days) ||
        days.length === 0 ||
        new Set(days).size !== days.length ||
        days.some((day) => !WEEKDAYS.has(day))
      )
        return null;
    }
    // Include equality conservatively, retaining the existing token-boundary guard.
    if ("min_prompt_tokens" in entry && entry.min_prompt_tokens > inputTokens) continue;
    for (const key of Object.keys(prices)) {
      if (key in entry) prices[key] = Math.max(prices[key], parsePrice(entry[key]));
    }
  }
  return prices;
}
