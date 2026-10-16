import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { classScenarios, testClassDecisions } from "./class-scenarios.mjs";
import { EVAL_IMAGE, EVALUATOR_HASH, GRADER_HASH, PROFILE_HASH } from "./gate.mjs";
import { DAY, loadAcceptedReviewer } from "./policy.mjs";
import { beginRenewal, renewPolicy } from "./renew-policy.mjs";
import {
  acceptedBaseline,
  CLASS_HASH,
  chooseClassReviewer,
  classCandidates,
  REVIEWER_CLASS,
  resolveDecision,
} from "./reviewer-class.mjs";
import { loadSuite } from "./suite.mjs";
import { mockGit } from "./test-state.mjs";

const suite = { ...(await loadSuite()), ready: true };
const raw = (
  id,
  description,
  prompt = "0.00000003",
  completion = "0.0000005",
  created = 2000000000,
) => ({
  id,
  description,
  created,
  context_length: 1048576,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_parameters: ["max_tokens", "temperature", "reasoning"],
  pricing: { prompt, completion },
});
const catalog = () => [
  raw(
    REVIEWER_CLASS.baseline,
    "Accepted baseline",
    "0.0000003",
    "0.0000012",
    REVIEWER_CLASS.created,
  ),
  raw("openai/gpt-6.1-sol", "Price reference", "0.000002", "0.00001"),
  raw("future/reviewer-v8", "A future capable coding model"),
];
function harness(state = {}) {
  let calls = 0;
  const github = {
    rest: {
      repos: {
        getContent: async ({ path }) => {
          if (!(path in state)) throw Object.assign(Error(), { status: 404 });
          return {
            data: {
              encoding: "base64",
              content: Buffer.from(JSON.stringify(state[path])).toString("base64"),
              sha: "blob",
            },
          };
        },
        createOrUpdateFileContents: async ({ path, content }) => {
          state[path] = JSON.parse(Buffer.from(content, "base64").toString());
        },
      },
      git: mockGit(state),
    },
  };
  const sdk = {
    choice: (instruction, options) => ({ instruction, options }),
    TypeSafeClient: class {
      async systemOne(request) {
        calls++;
        if (request.questions.scenario_0)
          return {
            answers: Object.fromEntries(
              classScenarios().map((s, i) => [
                `scenario_${i}`,
                {
                  choice: s.expected
                    ? `candidate_${request.state.scenarios[i].candidates.findIndex((m) => m.id === s.expected)}`
                    : "retain",
                  confidence: 0.9,
                },
              ]),
            ),
            usage: { input_tokens: 20, output_tokens: 2 },
          };
        if (request.questions.challenger)
          return {
            answers: { challenger: { choice: "candidate_0", confidence: 0.9 } },
            usage: { input_tokens: 20, output_tokens: 2 },
          };
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
          usage: { input_tokens: 20, output_tokens: 2 },
        };
      }
    },
  };
  return { github, sdk, state, calls: () => calls };
}
const context = { repo: { owner: "o", repo: "r" }, sha: "b".repeat(40), runId: 400, runAttempt: 1 };
const core = { setOutput() {}, info() {}, warning() {} };

test("owner-selected DeepSeek replaces absent/smoke policy without claiming benchmark success", () => {
  for (const policy of [null, { schema: 1, model_id: "other/mini" }, { schema: 2 }]) {
    const selected = loadAcceptedReviewer(policy, catalog(), suite);
    assert.equal(selected.model, `openrouter/${REVIEWER_CLASS.baseline}`);
    assert.match(selected.acceptance, /incomplete benchmark/);
    assert.equal(selected.reasoningEffort, "none");
    assert.equal(selected.reasoningTokens, 0);
  }
  assert.throws(() => acceptedBaseline(catalog().filter((m) => m.id !== REVIEWER_CLASS.baseline)));
  assert.throws(() =>
    acceptedBaseline(
      catalog().map((m) => (m.id === REVIEWER_CLASS.baseline ? { ...m, created: 9 } : m)),
    ),
  );
  assert.throws(() => acceptedBaseline(catalog(), 0.001));
});
test("fresh catalogs admit future vendors while deterministically excluding overpriced/incompatible models", () => {
  const data = [
    ...catalog(),
    raw("future/pricey", "Excellent coding model", "0.000002", "0.000005"),
    { ...raw("future/too-small-context", "Coding"), context_length: 1000 },
    raw("future/cheaper-v9", "Comparable future reasoning", "0.00000002", "0.0000002"),
  ];
  const ids = classCandidates(data, REVIEWER_CLASS.baseline).map((m) => m.id);
  assert.ok(ids.includes("future/reviewer-v8"));
  assert.ok(ids.includes("future/cheaper-v9"));
  assert.ok(!ids.includes("future/pricey"));
  assert.ok(!ids.includes("future/too-small-context"));
  assert.ok(!ids.includes("openai/gpt-6.1-sol"));
  assert.throws(() => classCandidates(data, REVIEWER_CLASS.baseline, NaN));
});
test("owner-approved baseline price exception preserves challenger, repository and Sol ceilings", () => {
  const data = catalog();
  // 512k input tokens at $0.30/M plus 8,192 output tokens at $1.20/M.
  assert.ok(Math.abs(acceptedBaseline(data).estimated_call_usd - 0.1634304) < 1e-12);
  assert.throws(() => acceptedBaseline(data, 0.05));
  assert.throws(() => acceptedBaseline(data, REVIEWER_CLASS.maxCallUsd));
  assert.throws(() => acceptedBaseline(data, NaN));
  assert.throws(() =>
    acceptedBaseline(
      data.map((m) =>
        m.id === REVIEWER_CLASS.baseline
          ? { ...m, pricing: { prompt: "0.0000004", completion: "0.0000012" } }
          : m,
      ),
    ),
  );
  assert.throws(() =>
    acceptedBaseline(
      data.map((m) =>
        m.id === "openai/gpt-6.1-sol"
          ? { ...m, pricing: { prompt: "0", completion: "0.000002" } }
          : m,
      ),
    ),
  );
  const peer = raw(
    "new-vendor/credible-peer",
    "Comparable coding evidence",
    "0.0000003",
    "0.0000012",
  );
  assert.ok(
    !classCandidates([...data, peer], REVIEWER_CLASS.baseline).some((m) => m.id === peer.id),
  );
});
test("typed decision retains on uncertainty and rejects invalid or over-budget selections", async () => {
  const candidates = classCandidates(catalog(), REVIEWER_CLASS.baseline);
  for (const answer of [
    { choice: "retain", confidence: 1 },
    { choice: "candidate_0", confidence: 0.4 },
    { choice: "candidate_0" },
    { choice: "candidate_0", confidence: NaN },
  ])
    assert.equal(resolveDecision(answer, candidates), null);
  assert.throws(() => resolveDecision({ choice: "candidate_99", confidence: 0.9 }, candidates));
  assert.throws(() => resolveDecision({ choice: "execute me", confidence: 0.9 }, candidates));
  assert.throws(() =>
    resolveDecision({ choice: "candidate_0", confidence: 0.9 }, [
      { ...candidates[0], estimated_call_usd: 1 },
    ]),
  );
  let paid = 0;
  const result = await chooseClassReviewer({
    client: {
      systemOne: async () => {
        paid++;
      },
    },
    sdk: {},
    candidates: [],
    incumbent: acceptedBaseline(catalog()),
  });
  assert.equal(result.candidate, null);
  assert.equal(paid, 0);
});
for (const pass of [true, false])
  test(`complete renewal flow ${pass ? "promotes qualified future peer" : "retains DeepSeek after failed challenger"}`, async () => {
    const h = harness();
    await beginRenewal({ ...h, context, core });
    let nativeCalls = 0;
    const previous = process.env.PR_AGENT_EVAL_IMAGE;
    process.env.PR_AGENT_EVAL_IMAGE = EVAL_IMAGE;
    try {
      const winner = await renewPolicy({
        ...h,
        context,
        core,
        suiteLoader: async () => suite,
        fetchImpl: async () => ({ ok: true, json: async () => ({ data: catalog() }) }),
        evaluate: async (_m, fixture) => {
          nativeCalls++;
          assert.equal(h.state["attempt.json"].reserved_usd, 1);
          return {
            fixture_id: fixture.id,
            execution: pass ? "completed" : "rate_limit",
            review: pass ? { key_issues_to_review: [] } : null,
          };
        },
      });
      assert.equal(winner.id, pass ? "future/reviewer-v8" : REVIEWER_CLASS.baseline);
      assert.equal(nativeCalls, pass ? 10 : 1);
      assert.equal(h.calls(), pass ? 7 : 2);
      assert.equal(h.state["attempt.json"].reserved_usd, 1);
      assert.equal(h.state["decisions/400.json"].class_hash, CLASS_HASH);
      if (pass) {
        assert.equal(h.state["policy.json"].schema, 3);
        assert.equal(
          loadAcceptedReviewer(h.state["policy.json"], catalog(), suite).model,
          "openrouter/future/reviewer-v8",
        );
        assert.equal(
          loadAcceptedReviewer(h.state["policy.json"], catalog(), suite, Date.now() + 22 * DAY)
            .model,
          `openrouter/${REVIEWER_CLASS.baseline}`,
        );
      } else assert.equal(h.state["policy.json"], undefined);
      await assert.rejects(
        renewPolicy({
          ...h,
          context,
          core,
          suiteLoader: async () => suite,
          fetchImpl: async () => {
            throw Error("must not fetch");
          },
        }),
        /fresh preclaimed/,
      );
    } finally {
      if (previous === undefined) delete process.env.PR_AGENT_EVAL_IMAGE;
      else process.env.PR_AGENT_EVAL_IMAGE = previous;
      await rm("research-output", { recursive: true, force: true });
    }
  });
test("a replacement cannot bypass benchmark, class or evaluator evidence", () => {
  const now = Date.now();
  const policy = {
    schema: 3,
    class_hash: CLASS_HASH,
    model_id: "future/reviewer-v8",
    calibration_id: "x",
    profile_hash: PROFILE_HASH,
    suite_sha256: suite.hash,
    selected_at: new Date(now).toISOString(),
    expires_at: new Date(now + 14 * DAY).toISOString(),
    grace_until: new Date(now + 21 * DAY).toISOString(),
    evaluation: { grader_hash: GRADER_HASH, evaluator_hash: EVALUATOR_HASH },
  };
  assert.equal(
    loadAcceptedReviewer(policy, catalog(), suite).model,
    `openrouter/${REVIEWER_CLASS.baseline}`,
  );
});

test("scenario harness checks typed semantic answers without exposing expected labels", async () => {
  let requests = 0;
  const sdk = { choice: (instruction, options) => ({ instruction, options }) };
  const report = await testClassDecisions({
    sdk,
    client: {
      systemOne: async (request) => {
        requests++;
        assert.equal(JSON.stringify(request.state).includes('"expected"'), false);
        return {
          answers: Object.fromEntries(
            classScenarios().map((s, i) => [
              `scenario_${i}`,
              {
                choice: s.expected
                  ? `candidate_${request.state.scenarios[i].candidates.findIndex((m) => m.id === s.expected)}`
                  : "retain",
                confidence: 0.9,
              },
            ]),
          ),
        };
      },
    },
  });
  assert.equal(report.passed, true);
  assert.equal(requests, 1);
  const wrong = await testClassDecisions({
    sdk,
    client: {
      systemOne: async () => ({
        answers: { scenario_0: { choice: "candidate_0", confidence: 0.9 } },
      }),
    },
  });
  assert.equal(wrong.passed, false);
});

test("changed baseline version reenters evaluation rather than silently inheriting acceptance", () => {
  const data = catalog().map((m) =>
    m.id === REVIEWER_CLASS.baseline
      ? { ...m, created: m.created + 1, pricing: { prompt: "0.00000003", completion: "0.0000005" } }
      : m,
  );
  assert.throws(() => acceptedBaseline(data));
  assert.ok(
    classCandidates(data, REVIEWER_CLASS.baseline).some((m) => m.id === REVIEWER_CLASS.baseline),
  );
});

test("semantic judge sees the overpriced foil and cannot pass by selecting it", async () => {
  const sdk = { choice: (instruction, options) => ({ instruction, options }) };
  const report = await testClassDecisions({
    sdk,
    client: {
      systemOne: async (request) => {
        const frontier = request.state.scenarios[1].candidates.findIndex(
          (m) => m.id === "future/frontier-v20",
        );
        assert.ok(frontier >= 0);
        assert.ok(
          request.questions.scenario_1.options[`candidate_${frontier}`].includes("frontier"),
        );
        assert.match(request.questions.scenario_1.instruction.task, /maximum-call class ceiling/);
        const answers = Object.fromEntries(
          classScenarios().map((s, i) => [
            `scenario_${i}`,
            {
              choice: s.expected
                ? `candidate_${request.state.scenarios[i].candidates.findIndex((m) => m.id === s.expected)}`
                : "retain",
              confidence: 0.9,
            },
          ]),
        );
        answers.scenario_1 = { choice: `candidate_${frontier}`, confidence: 0.99 };
        return { answers };
      },
    },
  });
  assert.equal(report.passed, false);
  assert.equal(report.outcomes[1].valid_decision, false);
  assert.equal(report.outcomes[1].passed, false);
});
