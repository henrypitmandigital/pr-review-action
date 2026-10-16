import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { calibrate, calibrationPlan } from "./calibrate.mjs";
import { mockGit } from "./test-state.mjs";

process.env.PR_REVIEW_OUTPUT_DIR = await mkdtemp(join(tmpdir(), "pr-review-calibration-"));
const ids = ["openai/gpt-6.1-sol", "midrange/coding", "economical/coding"];
const catalog = ids.map((id, i) => ({
  id,
  created: i + 1,
  context_length: 64000,
  supported_parameters: ["max_tokens", "reasoning"],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: {
    prompt: i === 0 ? "0.000002" : "0.0000001",
    completion: i === 0 ? "0.00001" : "0.0000002",
  },
}));
const control = { claims: "supported", review: { key_issues_to_review: [] } };
const suite = {
  cases: [
    { id: "a", diff: "d", expected: "defect", judge_control: control },
    { id: "b", diff: "d", expected: null, judge_control: control },
  ],
  ready: false,
  hash: "h".repeat(64),
};
function harness(outcome) {
  const state = {};
  const counts = { reviews: 0, paid: 0 };
  const refs = [];
  const github = {
    rest: {
      git: {
        ...mockGit(state),
        getRef: async () => {
          if (!refs.length) throw Object.assign(Error(), { status: 404 });
          return { data: { object: { sha: refs[0] } } };
        },
        createRef: async ({ sha }) => {
          refs.push(sha);
        },
      },
      repos: {
        getContent: async ({ path }) => {
          if (!state[path]) throw Object.assign(Error(), { status: 404 });
          return {
            data: {
              encoding: "base64",
              content: Buffer.from(JSON.stringify(state[path])).toString("base64"),
            },
          };
        },
        createOrUpdateFileContents: async ({ path, content }) => {
          state[path] = JSON.parse(Buffer.from(content, "base64"));
        },
      },
    },
  };
  const sdk = {
    choice: () => ({}),
    score: () => ({}),
    TypeSafeClient: class {
      async systemOne({ questions }) {
        counts.paid++;
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((k) => [
              k,
              k.startsWith("role_")
                ? { score: 3 }
                : {
                    choice: k.endsWith("_finding") ? "found" : "supported",
                    confidence: 0.9,
                  },
            ]),
          ),
          usage: { input_tokens: 100, output_tokens: 10 },
        };
      }
    },
  };
  const params = {
    github,
    context: { repo: { owner: "o", repo: "r" }, sha: "a".repeat(40), runId: 42 },
    core: { info() {} },
    sdk,
    budgetUsd: outcome === "over-budget" ? 0.01 : 5,
    roleIds: ids,
    suiteLoader: async () => suite,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: catalog }) }),
    evaluate: async (model, fixture) => {
      counts.reviews++;
      assert.ok(Object.keys(state).some((k) => k.startsWith("calibration-claims/")));
      return {
        fixture_id: fixture.id,
        execution:
          outcome === "reference-failed" && model.id === ids[0] ? "completion_limit" : "completed",
        review: { key_issues_to_review: [] },
      };
    },
  };
  return { state, counts, params, refs };
}

test("a qualified calibration records evidence and never replaces the reviewer policy", async () => {
  const { state, counts, params, refs } = harness("qualified");
  const certificate = await calibrate(params);
  assert.equal(certificate.reference_qualified, true);
  assert.ok(ids.slice(1).includes(certificate.recommended_model));
  assert.ok(counts.reviews > 0 && counts.paid > 0);
  assert.equal(state["policy.json"], undefined);
  assert.equal(state["calibration.json"].suite_ready, false);
  assert.deepEqual(refs, ["commit"], "creates the missing data branch first");
});
test("a failed reference is recorded and fails the run", async () => {
  const { state, params } = harness("reference-failed");
  await assert.rejects(calibrate(params), /Reference did not qualify/);
  assert.equal(state["calibration.json"].reference_qualified, false);
  assert.equal(state["policy.json"], undefined);
});
test("an insufficient budget spends nothing", async () => {
  const { state, counts, params } = harness("over-budget");
  await assert.rejects(calibrate(params));
  assert.deepEqual([counts.reviews, counts.paid], [0, 0]);
  assert.equal(state["policy.json"], undefined);
});
for (const [name, mutate] of [
  ["no budget", (p) => (p.budgetUsd = 0)],
  ["over the $10 cap", (p) => (p.budgetUsd = 11)],
  ["two models from one family", (p) => (p.roleIds = [ids[0], "midrange/a", "midrange/b"])],
  ["a non-reference first model", (p) => (p.roleIds = [ids[1], ids[0], ids[2]])],
  ["an empty suite", (p) => (p.suiteLoader = async () => ({ ...suite, cases: [] }))],
]) {
  test(`rejects ${name} before any paid call`, async () => {
    const { counts, params } = harness("qualified");
    let fetched = false;
    params.fetchImpl = async () => {
      fetched = true;
      return { ok: true, json: async () => ({ data: catalog }) };
    };
    mutate(params);
    await assert.rejects(calibrate(params));
    assert.deepEqual([counts.reviews, counts.paid, fetched], [0, 0, false]);
  });
}
test("the plan is free and lists only production candidates under the ceiling", async () => {
  const { state, params, refs } = harness("qualified");
  const plan = await calibrationPlan(params);
  assert.equal(plan.paid_calls, 0);
  assert.ok(
    plan.production_candidates.every((m) => m.estimated_call_usd <= plan.repository_call_usd),
  );
  assert.deepEqual(state["calibration-plan.json"], plan);
  assert.deepEqual(refs, ["commit"], "a first plan creates the data branch");
});
