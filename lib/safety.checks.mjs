import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { catalogPlan } from "./catalog-plan.mjs";
import { EVAL_IMAGE, EVALUATOR_HASH, evidenceKey, GRADER_HASH, PROFILE_HASH } from "./gate.mjs";
import { loadAcceptedReviewer, loadReviewer } from "./policy.mjs";
import { beginRenewal, ensureDataBranch, renewPolicy } from "./renew-policy.mjs";
import { CLASS_HASH, REVIEWER_CLASS } from "./reviewer-class.mjs";
import { loadSuite } from "./suite.mjs";
import { mockGit } from "./test-state.mjs";

const suite = await loadSuite();
const context = { repo: { owner: "o", repo: "r" }, sha: "a".repeat(40), runId: 900, runAttempt: 1 };
const model = (id) => ({
  id,
  created: id === REVIEWER_CLASS.baseline ? REVIEWER_CLASS.created : 123,
  description: "Untrusted catalog description",
  context_length: 1048576,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_parameters: ["temperature", "max_tokens", "reasoning"],
  pricing: { prompt: "0.00000003", completion: "0.0000005" },
});
const catalog = [model(REVIEWER_CLASS.baseline), model("openai/gpt-6.1-sol"), model("future/peer")];
const core = {
  setOutput() {},
  info() {},
  warning() {},
  summary: {
    addRaw() {
      return this;
    },
    async write() {},
  },
};
function harness() {
  const state = {};
  const writes = [];
  return {
    state,
    writes,
    github: {
      rest: {
        git: mockGit(state, writes),
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
            writes.push(path);
          },
        },
      },
    },
  };
}
test("no-inference fresh plan preserves availability/version/price discrepancies", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: catalog }) });
  const plan = await catalogPlan(fetchImpl);
  assert.equal(plan.activation_preflight, "passed");
  assert.equal(plan.inference_calls, 0);
  assert.equal(JSON.stringify(plan).includes("Untrusted"), false);
  const changed = await catalogPlan(async () => ({
    ok: true,
    json: async () => ({
      data: catalog.map((m) => (m.id === REVIEWER_CLASS.baseline ? { ...m, created: 124 } : m)),
    }),
  }));
  assert.equal(changed.activation_preflight, "blocked");
  assert.equal(changed.model_snapshots[0].created, 124);
});
test("manual loader uses fresh catalog, exact routing and run outputs", async () => {
  const h = harness();
  const outputs = {};
  await loadReviewer({
    ...h,
    context,
    core: {
      ...core,
      setOutput: (k, v) => {
        outputs[k] = v;
      },
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: catalog }) }),
  });
  assert.equal(outputs.model, "openrouter/deepseek/deepseek-v4.1-flash");
  assert.equal(outputs.input_tokens, "512000");
  assert.equal(outputs.reasoning_effort, "none");
  assert.equal(outputs.reasoning_tokens, "0");
  await assert.rejects(
    loadReviewer({ ...h, context, core, fetchImpl: async () => ({ ok: false }) }),
  );
});
test("pending actual adjudication blocks even a complete simulated replacement certificate", () => {
  assert.equal(suite.ready, false);
  const now = Date.now();
  const evaluated = {
    id: "future/peer",
    created: 123,
    reasoning_supported: true,
    temperature_supported: true,
  };
  const policy = {
    schema: 3,
    class_hash: CLASS_HASH,
    calibration_id: "mock",
    model_id: evaluated.id,
    profile_hash: PROFILE_HASH,
    suite_sha256: suite.hash,
    selected_at: new Date(now).toISOString(),
    expires_at: new Date(now + 14 * 86400000).toISOString(),
    grace_until: new Date(now + 21 * 86400000).toISOString(),
    evaluation: {
      model: evaluated,
      grader_hash: GRADER_HASH,
      evaluator_hash: EVALUATOR_HASH,
      evidence_key: evidenceKey(evaluated, suite.hash, EVAL_IMAGE),
      outputs: suite.cases.map((c) => ({ fixture_id: c.id, execution: "completed" })),
      cases: suite.cases.map((c) => ({ id: c.id, passed: true })),
    },
  };
  assert.equal(
    loadAcceptedReviewer(policy, catalog, suite).model,
    `openrouter/${REVIEWER_CLASS.baseline}`,
  );
});
test("atomic durable claim precedes inference, survives failure and blocks reruns", async () => {
  const h = harness();
  await beginRenewal({ ...h, context, core });
  assert.deepEqual(h.writes, ["claims/900.json", "attempt.json"]);
  const sdk = {
    TypeSafeClient: class {
      async systemOne() {
        throw Error("must never reach inference after catalog failure");
      }
    },
  };
  let fetched = false;
  await assert.rejects(
    renewPolicy({
      ...h,
      context,
      core,
      sdk,
      fetchImpl: async () => {
        fetched = true;
        assert.equal(h.state["attempt.json"].status, "inference_started");
        throw Error("network failure");
      },
    }),
  );
  assert.equal(fetched, true);
  assert.equal(h.state["claims/900.json"].reserved_usd, 1);
  await assert.rejects(renewPolicy({ ...h, context, core, sdk }), /fresh preclaimed/);
  const outputs = {};
  await beginRenewal({
    ...h,
    context: { ...context, runAttempt: 2 },
    core: {
      ...core,
      setOutput: (k, v) => {
        outputs[k] = v;
      },
    },
    now: Date.now() + 20 * 86400000,
  });
  assert.equal(outputs.due, "false");
  assert.equal(h.state["claims/900.json"].reserved_usd, 1);
});
test("failed non-fast-forward claim never grants an inference opportunity", async () => {
  const h = harness();
  let due = false;
  h.github.rest.git.updateRef = async () => {
    throw Object.assign(Error(), { status: 422 });
  };
  await assert.rejects(
    beginRenewal({
      ...h,
      context,
      core: {
        ...core,
        setOutput: (_, v) => {
          due ||= v === "true";
        },
      },
    }),
  );
  assert.equal(due, false);
  assert.equal(h.state["attempt.json"], undefined);
});
test("data-branch initialization creates an orphan containing only state documentation", async () => {
  let entries;
  let parents;
  let branch;
  const git = {
    getRef: async () => {
      throw Object.assign(Error(), { status: 404 });
    },
    createTree: async ({ tree }) => {
      entries = tree;
      return { data: { sha: "tree" } };
    },
    createCommit: async (args) => {
      parents = args.parents;
      return { data: { sha: "commit" } };
    },
    createRef: async (args) => {
      branch = args.ref;
    },
  };
  await ensureDataBranch({ rest: { git } }, context.repo);
  assert.deepEqual(parents, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "README.md");
  assert.equal(branch, "refs/heads/pr-review-policy");
});
test("semantic failure retains incumbent without executing any saved diff", async () => {
  const h = harness();
  await beginRenewal({ ...h, context, core });
  let nativeCalls = 0;
  const sdk = {
    choice: () => ({}),
    TypeSafeClient: class {
      async systemOne() {
        return { answers: {} };
      }
    },
  };
  await assert.rejects(
    renewPolicy({
      ...h,
      context,
      core,
      sdk,
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: catalog }) }),
      evaluate: async () => {
        nativeCalls++;
      },
    }),
    /regression/,
  );
  assert.equal(nativeCalls, 0);
  assert.equal(h.state["policy.json"], undefined);
  assert.equal(h.state["decision-tests/900.json"].passed, false);
  assert.equal(h.state["claims/900.json"].reserved_usd, 1);
  await rm("research-output", { recursive: true, force: true });
});

test("real suite gate preserves advisory selection without any native evaluation", async () => {
  const h = harness();
  await beginRenewal({ ...h, context, core });
  let nativeCalls = 0;
  const { classScenarios } = await import("./class-scenarios.mjs");
  const sdk = {
    choice: () => ({}),
    TypeSafeClient: class {
      async systemOne(request) {
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
          };
        return { answers: { challenger: { choice: "candidate_0", confidence: 0.9 } } };
      }
    },
  };
  const selected = await renewPolicy({
    ...h,
    context,
    core,
    sdk,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: catalog }) }),
    evaluate: async () => {
      nativeCalls++;
    },
  });
  assert.equal(selected.id, REVIEWER_CLASS.baseline);
  assert.equal(nativeCalls, 0);
  assert.equal(h.state["attempt.json"].status, "retained_pending_adjudication");
  assert.equal(h.state["periods/900.json"].model_id, REVIEWER_CLASS.baseline);
  assert.equal(h.state["policy.json"], undefined);
});
