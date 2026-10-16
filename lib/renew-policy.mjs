import { requireClassTests, testClassDecisions } from "./class-scenarios.mjs";
import { REVIEW_PROFILE } from "./evaluate.mjs";
import { runExperiment } from "./experiment.mjs";
import { failedQuality, PROFILE_HASH, qualifies } from "./gate.mjs";
import { eligibleModels, failureReason, SelectionError } from "./model-catalog.mjs";
import {
  DAY,
  loadAcceptedReviewer,
  readState,
  renewalDue,
  repositoryCeiling,
  STATE_BRANCH,
  writeState,
} from "./policy.mjs";
import {
  CLASS_HASH,
  chooseClassReviewer,
  classCandidates,
  REVIEWER_CLASS,
} from "./reviewer-class.mjs";
import { loadSuite } from "./suite.mjs";

// Empty data branch: application source is never copied into policy storage.
export async function ensureDataBranch(github, repo) {
  try {
    await github.rest.git.getRef({ ...repo, ref: `heads/${STATE_BRANCH}` });
  } catch (error) {
    if (error.status !== 404) throw error;
    const { data: tree } = await github.rest.git.createTree({
      ...repo,
      tree: [
        {
          path: "README.md",
          mode: "100644",
          type: "blob",
          content:
            "PR-review decisions, evidence and durable claims. Never merge into application source.\n",
        },
      ],
    });
    const { data: commit } = await github.rest.git.createCommit({
      ...repo,
      message: "Initialize reviewer data branch",
      tree: tree.sha,
      parents: [],
    });
    await github.rest.git.createRef({
      ...repo,
      ref: `refs/heads/${STATE_BRANCH}`,
      sha: commit.sha,
    });
  }
}

export async function beginRenewal({
  github,
  context,
  core,
  now = Date.now(),
  suiteLoader = loadSuite,
  resumeRunId,
}) {
  // A rerun is never a new authorization to spend.
  if (Number(context.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT ?? 1) !== 1) {
    core.setOutput("due", "false");
    return;
  }
  const attempt = await readState(github, context.repo, "attempt.json");
  if (resumeRunId !== undefined && resumeRunId !== "") {
    await resumeClaim({ github, context, resumeRunId, now });
    const suite = await suiteLoader();
    core.setOutput("evaluation_ready", String(suite.ready));
    core.setOutput("due", "true");
    return;
  }
  if (!renewalDue(attempt, now)) {
    core.setOutput("due", "false");
    return;
  }
  await ensureDataBranch(github, context.repo);
  const claimPath = `claims/${context.runId}.json`;
  if (await readState(github, context.repo, claimPath)) {
    core.setOutput("due", "false");
    return;
  }
  const claim = {
    schema: 2,
    started_at: new Date(now).toISOString(),
    run_id: String(context.runId),
    source_sha: context.sha,
    status: "claimed",
    reserved_usd: 1,
  };
  // Commit pointer + append-only claim atomically. Non-fast-forward updates fail
  // closed, so a concurrent claim cannot overwrite another reservation.
  const { data: ref } = await github.rest.git.getRef({
    ...context.repo,
    ref: `heads/${STATE_BRANCH}`,
  });
  const { data: parent } = await github.rest.git.getCommit({
    ...context.repo,
    commit_sha: ref.object.sha,
  });
  const { data: tree } = await github.rest.git.createTree({
    ...context.repo,
    base_tree: parent.tree.sha,
    tree: [claimPath, "attempt.json"].map((path) => ({
      path,
      mode: "100644",
      type: "blob",
      content: `${JSON.stringify(claim, null, 2)}\n`,
    })),
  });
  const { data: commit } = await github.rest.git.createCommit({
    ...context.repo,
    message: `Claim reviewer cycle ${context.runId}`,
    tree: tree.sha,
    parents: [ref.object.sha],
  });
  await github.rest.git.updateRef({
    ...context.repo,
    ref: `heads/${STATE_BRANCH}`,
    sha: commit.sha,
    force: false,
  });
  const suite = await suiteLoader();
  core.setOutput("evaluation_ready", String(suite.ready));
  core.setOutput("due", "true");
}

// Explicit recovery of a cycle whose trusted run failed before inference: the
// original claim, start date and full reservation are kept; only the execution
// owner changes, recorded before any paid call. Spent cycles are never replayed.
async function resumeClaim({ github, context, resumeRunId, now }) {
  // Validate one data-branch commit and transfer ownership with a commit whose
  // parent is exactly that commit: a concurrent resume or inference start moves
  // the branch, so this non-fast-forward update then fails closed.
  const { data: ref } = await github.rest.git.getRef({
    ...context.repo,
    ref: `heads/${STATE_BRANCH}`,
  });
  const head = ref.object.sha;
  const attempt = await readState(github, context.repo, "attempt.json", head);
  const executionId = attempt?.execution_run_id ?? attempt?.run_id;
  if (
    !/^[1-9][0-9]{0,19}$/.test(String(resumeRunId)) ||
    attempt?.schema !== 2 ||
    attempt.run_id !== String(resumeRunId) ||
    attempt.status !== "claimed" ||
    attempt.reserved_usd !== 1 ||
    executionId === String(context.runId) ||
    renewalDue(attempt, now)
  )
    throw new SelectionError(
      "Only an unspent claim in its original fourteen-day cycle can be resumed.",
    );
  // Older implementations recorded inference here while leaving the claim's
  // status unchanged; any such record means paid work may already have run.
  for (const id of new Set([attempt.run_id, executionId]))
    if (await readState(github, context.repo, `inference-claims/${id}.json`, head))
      throw new SelectionError("Inference was already claimed; recovery cannot replay paid calls.");
  const { data: previous } = await github.rest.actions.getWorkflowRun({
    ...context.repo,
    run_id: Number(executionId),
  });
  const workflowPath = String(process.env.GITHUB_WORKFLOW_REF ?? "")
    .replace(/^[^/]+\/[^/]+\//, "")
    .replace(/@.*$/, "");
  if (
    previous.status !== "completed" ||
    previous.conclusion !== "failure" ||
    previous.path !== workflowPath ||
    previous.head_sha !== (attempt.execution_source_sha ?? attempt.source_sha)
  )
    throw new SelectionError("Recovery requires a failed trusted research run before inference.");
  const files = {
    [`recoveries/${context.runId}.json`]: {
      schema: 1,
      claim: attempt,
      previous_execution_run_id: executionId,
      execution_run_id: String(context.runId),
      execution_source_sha: context.sha,
      recovered_at: new Date(now).toISOString(),
    },
    "attempt.json": {
      ...attempt,
      execution_run_id: String(context.runId),
      execution_source_sha: context.sha,
    },
  };
  const { data: parent } = await github.rest.git.getCommit({ ...context.repo, commit_sha: head });
  const { data: tree } = await github.rest.git.createTree({
    ...context.repo,
    base_tree: parent.tree.sha,
    tree: Object.entries(files).map(([path, value]) => ({
      path,
      mode: "100644",
      type: "blob",
      content: `${JSON.stringify(value, null, 2)}\n`,
    })),
  });
  const { data: commit } = await github.rest.git.createCommit({
    ...context.repo,
    message: `Resume reviewer cycle ${attempt.run_id} in ${context.runId}`,
    tree: tree.sha,
    parents: [head],
  });
  await github.rest.git.updateRef({
    ...context.repo,
    ref: `heads/${STATE_BRANCH}`,
    sha: commit.sha,
    force: false,
  });
}

export async function renewPolicy(options) {
  try {
    return await renewPolicyAttempt(options);
  } catch (error) {
    // Persist only safe error categories. The consumed claim/reservation survives.
    const failurePath = `research-failures/${options.context.runId}.json`;
    if (!(await readState(options.github, options.context.repo, failurePath)))
      await writeState(options.github, options.context.repo, failurePath, {
        schema: 1,
        run_id: String(options.context.runId),
        source_sha: options.context.sha,
        failed_at: new Date().toISOString(),
        failure: failureReason(error),
        retained: true,
      });
    throw error;
  }
}

async function renewPolicyAttempt({
  github,
  context,
  core,
  sdk,
  fetchImpl = fetch,
  evaluate,
  suiteLoader = loadSuite,
}) {
  const suite = await suiteLoader();
  const attempt = await readState(github, context.repo, "attempt.json");
  if (
    attempt?.schema !== 2 ||
    (attempt.execution_run_id ?? attempt.run_id) !== String(context.runId) ||
    attempt.reserved_usd !== 1 ||
    attempt.status !== "claimed"
  )
    throw new SelectionError("A fresh preclaimed cycle is required.");
  // Consume the inference opportunity before network requests or SDK calls.
  await writeState(github, context.repo, "attempt.json", {
    ...attempt,
    status: "inference_started",
  });
  const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new SelectionError("Fresh reviewer catalog unavailable.");
  const catalog = await response.json();
  const maxCallUsd = repositoryCeiling();
  const previous = await readState(github, context.repo, "policy.json");
  let incumbent;
  try {
    const loaded = loadAcceptedReviewer(previous, catalog.data, suite, Date.now(), maxCallUsd);
    incumbent = eligibleModels(
      catalog.data,
      loaded.estimatedCallUsd, // Already validated against the baseline or qualified-policy ceiling.
      REVIEW_PROFILE,
    ).find((m) => `openrouter/${m.id}` === loaded.model);
  } catch (error) {
    if (!(error instanceof SelectionError) || !error.message.startsWith("Owner-accepted baseline"))
      throw error;
    // A retired/changed anchor still defines the target class; it cannot run a
    // manual review, but a newly qualified replacement can restore service.
    incumbent = {
      id: REVIEWER_CLASS.baseline,
      created: REVIEWER_CLASS.created,
      description: REVIEWER_CLASS.capability,
      estimated_call_usd: REVIEWER_CLASS.baselineCallUsd,
      available: false,
    };
  }
  const history = (await readState(github, context.repo, "history.json")) ?? { entries: [] };
  const candidates = classCandidates(
    catalog.data,
    incumbent.id,
    maxCallUsd,
    incumbent.created,
  ).filter((m) => !failedQuality(history, m, suite, process.env.PR_AGENT_EVAL_IMAGE));
  const client = new sdk.TypeSafeClient({
    timeout: 60000,
    retry: { maxRetries: 0 },
    logLevel: "off",
  });
  const regression = await testClassDecisions({ client, sdk });
  await writeState(github, context.repo, `decision-tests/${context.runId}.json`, {
    schema: 1,
    class_hash: CLASS_HASH,
    source_sha: context.sha,
    ...regression,
  });
  if (!regression.passed) await finish("retained_after_semantic_failure");
  requireClassTests(regression);
  const decision = await chooseClassReviewer({
    client,
    sdk,
    candidates,
    incumbent,
    history: history.entries,
  });
  await writeState(github, context.repo, `decisions/${context.runId}.json`, {
    schema: 1,
    class_hash: CLASS_HASH,
    source_sha: context.sha,
    researched_at: new Date().toISOString(),
    incumbent: incumbent.id,
    candidates,
    answer: decision.answer,
    usage: decision.usage,
    typesafe_model: decision.typesafe_model,
  });
  if (!decision.candidate) {
    await finish("retained");
    core.info("Retained incumbent; no credible class/cost improvement selected.");
    return incumbent;
  }
  if (suite.ready !== true) {
    await finish("retained_pending_adjudication");
    core.warning?.(
      "Repository fixture labels are pending independent adjudication; no native evaluation or automatic replacement.",
    );
    return incumbent;
  }
  const report = await runExperiment({
    github,
    context,
    core,
    sdk,
    suite,
    models: [decision.candidate],
    budgetUsd: 1,
    mode: "renewal",
    evaluate,
    preclaimed: true,
    researchAllowance: 0.2,
    research: async () => ({ selection: decision.usage, regression: regression.usage }),
  });
  const winner = report.results[0];
  if (!qualifies(winner, suite)) {
    await finish("retained_after_evaluation", report);
    core.warning?.("Challenger did not pass representative checks; accepted incumbent retained.");
    return incumbent;
  }
  const now = Date.now();
  await writeState(github, context.repo, "policy.json", {
    schema: 3,
    class_hash: CLASS_HASH,
    model_id: winner.model.id,
    selected_at: new Date(now).toISOString(),
    expires_at: new Date(now + 14 * DAY).toISOString(),
    grace_until: new Date(now + 21 * DAY).toISOString(),
    calibration_id: String(context.runId),
    profile_hash: PROFILE_HASH,
    profile: REVIEW_PROFILE,
    suite_sha256: suite.hash,
    evaluation: winner,
    price_snapshot: winner.model,
    source_sha: context.sha,
  });
  await finish("succeeded", report, winner.model);
  core.info(`Selected comparable reviewer ${winner.model.id}; $1 cycle remains claimed.`);
  return winner.model;

  async function finish(status, report, selected = incumbent) {
    const selectedAt = Date.now();
    await writeState(github, context.repo, `periods/${context.runId}.json`, {
      schema: 1,
      run_id: String(context.runId),
      source_sha: context.sha,
      status,
      model_id: selected.id,
      model_created: selected.created,
      selected_at: new Date(selectedAt).toISOString(),
      expires_at: new Date(selectedAt + 14 * DAY).toISOString(),
      acceptance:
        status === "succeeded"
          ? "representative checks passed"
          : selected.id === REVIEWER_CLASS.baseline
            ? "owner accepted; not benchmark qualified"
            : "retained previously qualified policy",
      available: selected.available !== false,
      class_hash: CLASS_HASH,
      suite_sha256: suite.hash,
      decision_path: `decisions/${context.runId}.json`,
      policy_path: status === "succeeded" ? "policy.json" : null,
    });
    await writeState(github, context.repo, "attempt.json", {
      ...attempt,
      status,
      decision_path: `decisions/${context.runId}.json`,
      ...(report
        ? { report_path: `experiments/${context.runId}.json`, budget: report.budget }
        : {}),
    });
  }
}
