import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeRenewal } from "./authorize.mjs";
import { beginRenewal } from "./renew-policy.mjs";
import { mockGit } from "./test-state.mjs";

const DAY = 86400000;
const now = Date.parse("2026-10-07T08:00:00Z");
const context = (runId = 200) => ({
  repo: { owner: "o", repo: "r" },
  sha: "b".repeat(40),
  runId,
  runAttempt: 1,
});
const claimed = (overrides = {}) => ({
  schema: 2,
  started_at: new Date(now - 2 * DAY).toISOString(),
  run_id: "100",
  source_sha: "a".repeat(40),
  status: "claimed",
  reserved_usd: 1,
  ...overrides,
});
function harness(attempt, previousRun = {}) {
  const state = attempt ? { "attempt.json": attempt } : {};
  const writes = [];
  const outputs = {};
  return {
    state,
    writes,
    outputs,
    core: {
      setOutput: (k, v) => {
        outputs[k] = v;
      },
    },
    github: {
      rest: {
        git: mockGit(state, writes),
        actions: {
          getWorkflowRun: async ({ run_id }) => ({
            data: {
              id: run_id,
              status: "completed",
              conclusion: "failure",
              path: ".github/workflows/pr-review-policy.yml",
              head_sha: "a".repeat(40),
              ...previousRun,
            },
          }),
        },
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
const suiteLoader = async () => ({ ready: false });
process.env.GITHUB_WORKFLOW_REF = "o/r/.github/workflows/pr-review-policy.yml@refs/heads/main";

test("an unspent claim whose run failed resumes under the new run, keeping the reservation", async () => {
  const h = harness(claimed());
  await beginRenewal({ ...h, context: context(), now, suiteLoader, resumeRunId: "100" });
  assert.equal(h.outputs.due, "true");
  const attempt = h.state["attempt.json"];
  assert.deepEqual(
    [attempt.run_id, attempt.execution_run_id, attempt.started_at, attempt.reserved_usd],
    ["100", "200", claimed().started_at, 1],
  );
  assert.equal(h.state["recoveries/200.json"].previous_execution_run_id, "100");
  assert.deepEqual(h.writes, ["recoveries/200.json", "attempt.json"]);
});
for (const [name, attempt, previous] of [
  ["a spent claim", claimed({ status: "inference_started" }), {}],
  ["a finished cycle", claimed({ status: "retained" }), {}],
  ["another cycle's id", claimed({ run_id: "99" }), {}],
  ["an expired cycle", claimed({ started_at: new Date(now - 15 * DAY).toISOString() }), {}],
  ["no claim", null, {}],
  ["a run that did not fail", claimed(), { conclusion: "success" }],
  ["a run still in progress", claimed(), { status: "in_progress" }],
  ["a different workflow", claimed(), { path: ".github/workflows/other.yml" }],
  ["an untrusted commit", claimed(), { head_sha: "c".repeat(40) }],
]) {
  test(`refuses to resume ${name} and writes nothing`, async () => {
    const h = harness(attempt, previous);
    await assert.rejects(
      beginRenewal({ ...h, context: context(), now, suiteLoader, resumeRunId: "100" }),
    );
    assert.deepEqual(h.writes, []);
  });
}
test("recovery commits on the validated state and fails closed if the branch moved", async () => {
  const h = harness(claimed());
  const parents = [];
  const createCommit = h.github.rest.git.createCommit;
  h.github.rest.git.createCommit = async (args) => {
    parents.push(args.parents);
    return createCommit(args);
  };
  h.github.rest.git.updateRef = async ({ force }) => {
    assert.equal(force, false);
    throw Object.assign(Error("Update is not a fast forward"), { status: 422 });
  };
  await assert.rejects(
    beginRenewal({ ...h, context: context(), now, suiteLoader, resumeRunId: "100" }),
  );
  assert.deepEqual(parents, [["head"]]);
  assert.deepEqual(h.writes, []);
  assert.equal(h.state["attempt.json"].execution_run_id, undefined);
  assert.notEqual(h.outputs.due, "true");
});
test("a legacy inference claim blocks recovery", async () => {
  for (const id of ["100", "150"]) {
    const h = harness(claimed({ execution_run_id: "150" }));
    h.state[`inference-claims/${id}.json`] = { run_id: id };
    await assert.rejects(
      beginRenewal({ ...h, context: context(), now, suiteLoader, resumeRunId: "100" }),
      /already claimed/,
    );
    assert.deepEqual(h.writes, []);
  }
});
test("the resuming run cannot resume itself", async () => {
  const h = harness(claimed({ execution_run_id: "200" }));
  await assert.rejects(
    beginRenewal({ ...h, context: context(200), now, suiteLoader, resumeRunId: "100" }),
  );
});
test("a rerun of a resume grants nothing", async () => {
  const h = harness(claimed());
  await beginRenewal({
    ...h,
    context: { ...context(), runAttempt: 2 },
    now,
    suiteLoader,
    resumeRunId: "100",
  });
  assert.equal(h.outputs.due, "false");
  assert.deepEqual(h.writes, []);
});

// Trigger authorisation.
function trigger(eventName, { body, permission = "write", principal = 7, actor = "owner" } = {}) {
  const outputs = {};
  let lookups = 0;
  let failed = false;
  const run = (runAttempt = "1", resumeInput = "") =>
    authorizeRenewal({
      runAttempt,
      resumeInput,
      context: {
        eventName,
        actor,
        repo: { owner: "o", repo: "r" },
        payload: {
          action: "created",
          issue: { pull_request: {} },
          comment: { body, user: { login: "author", type: "User", id: 7 } },
        },
      },
      github: {
        rest: {
          repos: {
            getCollaboratorPermissionLevel: async () => {
              lookups++;
              if (permission === "error") throw Error("down");
              return { data: { permission, user: { id: principal } } };
            },
          },
        },
      },
      core: {
        setOutput: (k, v) => {
          outputs[k] = v;
        },
        notice() {},
        setFailed() {
          failed = true;
        },
      },
    }).then(() => ({ ...outputs, lookups, failed }));
  return run;
}
test("the schedule is authorised without a lookup", async () => {
  assert.deepEqual(await trigger("schedule")(), {
    allowed: "true",
    resume_run_id: "",
    lookups: 0,
    failed: false,
  });
});
test("a dispatch needs a write-permitted actor and a numeric resume id", async () => {
  assert.equal((await trigger("workflow_dispatch")()).allowed, "true");
  assert.equal((await trigger("workflow_dispatch")("1", "123")).resume_run_id, "123");
  assert.equal((await trigger("workflow_dispatch", { permission: "read" })()).allowed, "false");
  const bad = await trigger("workflow_dispatch")("1", "12; rm");
  assert.deepEqual([bad.allowed, bad.lookups], ["false", 0]);
});
for (const [body, allowed, resume] of [
  ["/review-policy", "true", ""],
  ["/review-policy-resume 42", "true", "42"],
  ["/review-policy\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_", "true", ""],
  ["/review-policy-resume 0", "false", ""],
  ["/review-policy-resume 42 --x=y", "false", ""],
  ["/review-policy please", "false", ""],
  [" /review-policy", "false", ""],
  ["/review", "false", ""],
]) {
  test(`comment ${JSON.stringify(body)} → allowed ${allowed}`, async () => {
    const result = await trigger("issue_comment", { body })();
    assert.deepEqual([result.allowed, result.resume_run_id], [allowed, resume]);
    if (allowed === "false") assert.equal(result.lookups, 0);
  });
}
test("a comment is bound to its original author and fails closed on errors", async () => {
  assert.equal(
    (await trigger("issue_comment", { body: "/review-policy", principal: 8 })()).allowed,
    "false",
  );
  const error = await trigger("issue_comment", { body: "/review-policy", permission: "error" })();
  assert.deepEqual([error.allowed, error.failed], ["false", true]);
});
test("reruns and other events are never authorised", async () => {
  assert.equal((await trigger("schedule")("2")).allowed, "false");
  assert.equal((await trigger("push")()).allowed, "false");
});
