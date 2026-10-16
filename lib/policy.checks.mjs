import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { classifyExecution } from "./evaluate.mjs";
import { ExperimentBudget, runExperiment } from "./experiment.mjs";
import {
  EVAL_IMAGE,
  EVALUATOR_HASH,
  evidenceKey,
  failedQuality,
  GRADER_HASH,
  PROFILE_HASH,
  qualifies,
  reusable,
  selectWinner,
} from "./gate.mjs";
import { DAY, renewalDue, validateStoredPolicy } from "./policy.mjs";
import { beginRenewal } from "./renew-policy.mjs";
import { loadSuite } from "./suite.mjs";
import { mockGit } from "./test-state.mjs";

const suite = { ...(await loadSuite()), ready: true };
const now = Date.parse("2026-10-01T08:00:00Z");
const image = EVAL_IMAGE;
const model = {
  id: "vendor/current",
  created: 10,
  estimated_call_usd: 0.01,
  input_usd_per_million: 0.1,
  output_usd_per_million: 0.2,
  temperature_supported: true,
  reasoning_supported: true,
};
const result = () => ({
  model,
  grader_hash: GRADER_HASH,
  evaluator_hash: EVALUATOR_HASH,
  outputs: suite.cases.map((c) => ({
    fixture_id: c.id,
    execution: "completed",
    review: { key_issues_to_review: [] },
  })),
  cases: suite.cases.map((c) => ({ id: c.id, passed: true })),
  evidence_key: evidenceKey(model, suite.hash, image),
  evaluated_at: new Date(now).toISOString(),
});
const policy = () => ({
  schema: 2,
  model_id: model.id,
  selected_at: new Date(now).toISOString(),
  expires_at: new Date(now + 14 * DAY).toISOString(),
  grace_until: new Date(now + 21 * DAY).toISOString(),
  calibration_id: "cal",
  profile_hash: PROFILE_HASH,
  suite_sha256: suite.hash,
  evaluation: result(),
});
const catalog = () => [
  {
    id: "openai/gpt-6.1-sol",
    created: 10,
    context_length: 40192,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["max_tokens", "reasoning"],
    pricing: { prompt: "0.000002", completion: "0.00001" },
  },
  {
    id: model.id,
    created: 10,
    context_length: 40192,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["max_tokens", "temperature", "reasoning"],
    pricing: { prompt: "0.0000001", completion: "0.0000002" },
  },
];

function harness(state = {}) {
  const writes = [];
  return {
    state,
    writes,
    github: {
      rest: {
        repos: {
          getContent: async ({ path }) => {
            if (!state[path]) throw Object.assign(Error("missing"), { status: 404 });
            return {
              data: {
                content: Buffer.from(JSON.stringify(state[path])).toString("base64"),
                encoding: "base64",
                sha: "blob",
              },
            };
          },
          createOrUpdateFileContents: async ({ path, content }) => {
            state[path] = JSON.parse(Buffer.from(content, "base64").toString());
            writes.push(path);
          },
        },
        git: mockGit(state, writes),
      },
    },
  };
}
const core = { setOutput() {}, info() {}, notice() {} };
const context = { repo: { owner: "o", repo: "r" }, sha: "a".repeat(40), runId: 1, runAttempt: 1 };

test("fourteen-day cycle cannot reset on reruns or malformed timestamps", () => {
  assert.equal(renewalDue(null, now), true);
  assert.equal(renewalDue({ started_at: new Date(now - 13 * DAY).toISOString() }, now), false);
  assert.equal(renewalDue({ started_at: new Date(now - 14 * DAY).toISOString() }, now), true);
  assert.throws(() => renewalDue({ started_at: "bad" }, now));
});
test("normal reviews reject smoke certificates and changed model versions", () => {
  assert.equal(validateStoredPolicy(policy(), catalog(), suite, now + DAY).reasoningTokens, 2048);
  assert.equal(validateStoredPolicy(policy(), catalog(), suite, now + DAY).reasoningEffort, "");
  assert.equal(validateStoredPolicy(policy(), catalog(), suite, now + DAY).inputTokens, 32000);
  assert.throws(() => validateStoredPolicy({ ...policy(), schema: 1 }, catalog(), suite, now));
  assert.throws(() =>
    validateStoredPolicy(
      policy(),
      catalog().map((m) => (m.id === model.id ? { ...m, created: 11 } : m)),
      suite,
      now,
    ),
  );
  assert.throws(() => validateStoredPolicy(policy(), catalog(), suite, now + 22 * DAY));
  const incomplete = policy();
  incomplete.evaluation.cases.pop();
  assert.throws(() => validateStoredPolicy(incomplete, catalog(), suite, now));
  const pricier = catalog().map((m) =>
    m.id === model.id ? { ...m, pricing: { prompt: "0.000003", completion: "0.000015" } } : m,
  );
  assert.throws(() => validateStoredPolicy(policy(), pricier, suite, now, 0.5), /over budget/);
});
test("failed execution, judging uncertainty and missing historical controls cannot qualify", () => {
  assert.equal(qualifies(result(), suite), true);
  for (const execution of [
    "wall_timeout",
    "completion_limit",
    "provider_configuration",
    "incomplete_coverage",
  ]) {
    const r = result();
    r.outputs[0].execution = execution;
    assert.equal(qualifies(r, suite), false);
  }
  const bad = result();
  bad.cases[0].passed = false;
  assert.throws(() => selectWinner([bad], suite, null));
  const expensive = result();
  expensive.model = { ...model, estimated_call_usd: 0.2 };
  assert.throws(() => selectWinner([expensive], suite, null));
});
test("a minor price difference cannot churn a qualified incumbent", () => {
  const incumbent = result();
  const candidate = {
    ...result(),
    model: { ...model, id: "other/good", estimated_call_usd: 0.0095 },
  };
  assert.equal(selectWinner([candidate, incumbent], suite, model.id), incumbent);
  candidate.model.estimated_call_usd = 0.008;
  assert.equal(selectWinner([candidate, incumbent], suite, model.id), candidate);
});
test("reuse is limited by model version, configuration, suite, runtime and age", () => {
  assert.equal(reusable(result(), model, suite, image, now + DAY), true);
  assert.equal(reusable(result(), { ...model, created: 11 }, suite, image, now), false);
  assert.equal(
    reusable(result(), { ...model, reasoning_supported: false }, suite, image, now),
    false,
  );
  assert.equal(reusable(result(), model, { ...suite, hash: "changed" }, image, now), false);
  assert.equal(reusable(result(), model, suite, image, now + 29 * DAY), false);
});
test("measured quality failures exclude only the tested version and configuration", () => {
  const h = {
    entries: [
      {
        models: [
          {
            evidence_key: evidenceKey(model, suite.hash, image),
            cases: [{ reason: "graded", finding: "missed" }],
          },
        ],
      },
    ],
  };
  assert.equal(failedQuality(h, model, suite, image), true);
  assert.equal(failedQuality(h, { ...model, created: 11 }, suite, image), false);
  h.entries[0].models[0].cases = [{ reason: "judgment_uncertain", finding: "uncertain" }];
  assert.equal(failedQuality(h, model, suite, image), false);
});
test("diagnosis separates context, completion, provider and runtime failures", () => {
  const d = {
    coverage: [{ omitted_files: 0 }],
    attempts: [{ state: "completed", finish_reason: "stop" }],
  };
  assert.equal(classifyExecution({ status: 0 }, d, {}), "completed");
  assert.equal(classifyExecution({ error: { code: "ETIMEDOUT" } }, d, {}), "wall_timeout");
  assert.equal(
    classifyExecution(
      { status: 1 },
      { ...d, attempts: [{ finish_reason: "length", content_chars: 0 }] },
      null,
    ),
    "completion_limit",
  );
  assert.equal(
    classifyExecution({ status: 1 }, { ...d, attempts: [{ http_status: 400 }] }, null),
    "provider_configuration",
  );
  assert.equal(
    classifyExecution({ status: 0 }, { ...d, coverage: [{ omitted_files: 1 }] }, {}),
    "incomplete_coverage",
  );
  assert.equal(
    classifyExecution(
      { status: 0 },
      {
        ...d,
        limits: { reasoning: 2048 },
        attempts: [{ finish_reason: "stop", reasoning_tokens: 3737 }],
      },
      {},
    ),
    "completed",
  );
});
test("owner baseline enables renewal and durably claims one full cycle", async () => {
  const h = harness();
  await beginRenewal({ ...h, context, core, now });
  assert.equal(h.state["attempt.json"].reserved_usd, 1);
  await beginRenewal({ ...h, context, core, now: now + DAY });
  assert.equal(h.writes.length, 2);
});
test("approved one-off budgets cannot silently become larger renewal budgets", () => {
  const b = new ExperimentBudget(5);
  b.reserve("all", 4.7);
  assert.throws(() => b.reserve("overspend", 0.31));
  assert.throws(() => new ExperimentBudget(0));
  assert.throws(() => new ExperimentBudget(11));
});
test("all historical and stable cases parse as valid unified diffs", () => {
  assert.equal(suite.cases.length, 10);
  assert.equal(new Set(suite.historical_prs).size, 3);
  for (const c of suite.cases) {
    const p = spawnSync("git", ["apply", "--numstat", "-"], { input: c.diff, encoding: "utf8" });
    assert.equal(p.status, 0, `${c.id}: ${p.stderr}`);
  }
});
for (const judgeFails of [false, true])
  test(`experiment records history and blocks duplicate paid plans when judge ${judgeFails ? "fails" : "passes"}`, async () => {
    const previous = process.env.PR_AGENT_EVAL_IMAGE;
    process.env.PR_AGENT_EVAL_IMAGE = image;
    const h = harness();
    let reviews = 0,
      calls = 0;
    const sdk = {
      choice: () => ({}),
      TypeSafeClient: class {
        async systemOne(request) {
          calls++;
          if (judgeFails) throw Object.assign(Error("PRIVATE"), { status: 400 });
          return {
            answers: Object.fromEntries(
              Object.keys(request.questions).map((k) => [
                k,
                {
                  choice: k.endsWith("_control")
                    ? request.state.evidence[Number(k.match(/^c([0-9]+)/)[1])].expected
                      ? "supported"
                      : "unsupported"
                    : k.endsWith("_finding")
                      ? "found"
                      : "supported",
                  confidence: 0.9,
                },
              ]),
            ),
            usage: { input_tokens: 100, output_tokens: 20 },
          };
        }
      },
    };
    const params = {
      ...h,
      context,
      core,
      sdk,
      suite,
      models: [model],
      budgetUsd: 5,
      mode: "calibration",
      evaluate: async (_m, f) => {
        reviews++;
        assert.ok(h.writes.some((p) => p.startsWith("calibration-claims/")));
        return { fixture_id: f.id, execution: "completed", review: { key_issues_to_review: [] } };
      },
    };
    try {
      if (judgeFails) await assert.rejects(runExperiment(params));
      else {
        const report = await runExperiment(params);
        assert.equal(qualifies(report.results[0], suite), true);
      }
      assert.equal(h.state["history.json"].entries.length, 1);
      assert.equal(reviews, 10);
      await assert.rejects(runExperiment(params), /already claimed/);
      assert.equal(reviews, 10);
      assert.ok(calls <= 5);
      assert.equal(JSON.stringify(h.state).includes("PRIVATE"), false);
    } finally {
      if (previous === undefined) delete process.env.PR_AGENT_EVAL_IMAGE;
      else process.env.PR_AGENT_EVAL_IMAGE = previous;
      await rm("research-output", { recursive: true, force: true });
    }
  });

test("complete stored policy still rejects changed native runtime evidence", () => {
  const p = policy();
  assert.equal(validateStoredPolicy(p, catalog(), suite, now).model, "openrouter/vendor/current");
  p.evaluation.evidence_key = evidenceKey(
    model,
    suite.hash,
    `pragent/pr-agent@sha256:${"f".repeat(64)}`,
  );
  assert.throws(() => validateStoredPolicy(p, catalog(), suite, now), /changed or over budget/);
});
