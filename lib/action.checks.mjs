import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const action = (name) => readFile(new URL(`../${name}/action.yml`, import.meta.url), "utf8");
const review = await action("review");
const renew = await action("renew");
const checks = await action("checks");
const calibrateAction = await action("calibrate");

test("review authorizes before any checkout and checks out only trusted config", () => {
  assert.ok(review.indexOf("authorize.mjs") < review.indexOf("actions/checkout"));
  assert.match(review, /ref: \$\{\{ github.sha \}\}/);
  assert.ok(!/pull_request.head|head_ref|typesafe/i.test(review));
  assert.match(review, /The-PR-Agent\/pr-agent@v0\.46\.0/);
  assert.match(review, /CONFIG__OUTPUT_RUN_DETAILS: 'true'/);
  // Comment text is never interpolated into scripts.
  assert.ok(!/\$\{\{[^}]*comment/.test(review));
});
test("review runs the selected reviewer's input, output and reasoning profile", () => {
  for (const [key, output] of [
    ["CONFIG__CUSTOM_MODEL_MAX_TOKENS", "input_tokens"],
    ["CONFIG__MAX_MODEL_TOKENS", "input_tokens"],
    ["OPENROUTER__MAX_TOKENS", "output_tokens"],
    ["CONFIG__MAX_OUTPUT_TOKENS", "output_tokens"],
    ["OPENROUTER__REASONING_EFFORT", "reasoning_effort"],
    ["OPENROUTER__REASONING_MAX_TOKENS", "reasoning_tokens"],
    ["CONFIG__MODEL", "model"],
  ])
    assert.match(
      review,
      new RegExp(`${key}: \\$\\{\\{ steps\\.select\\.outputs\\.${output} \\}\\}`),
    );
});
test("review keeps every PR-Agent hardening control", () => {
  for (const line of [
    "CONFIG__FALLBACK_MODELS: '[]'",
    "CONFIG__USE_GLOBAL_SETTINGS_FILE: 'false'",
    "CONFIG__ENABLE_PER_DIRECTORY_SETTINGS: 'false'",
    "CONFIG__ENABLE_AUTO_APPROVAL: 'false'",
    "CONFIG__PROPAGATE_TOOL_ERRORS: 'true'",
    "CONFIG__NUM_RETRIES: '0'",
    "CONFIG__RETRY_SAME_MODEL_ON_TIMEOUT: 'false'",
    "GITHUB_ACTION_CONFIG.AUTO_REVIEW: 'false'",
    "GITHUB_ACTION_CONFIG.AUTO_DESCRIBE: 'false'",
    "GITHUB_ACTION_CONFIG.AUTO_IMPROVE: 'false'",
    "GITHUB_ACTION_CONFIG.HANDLE_PUSH_TRIGGER: 'false'",
    "GITHUB_ACTION_CONFIG.REVIEW_COMMANDS: '[]'",
    "MODEL_ROUTING__ENABLE: 'false'",
  ])
    assert.ok(review.includes(line), line);
});
test("renewal is default-branch only, trusted, and keeps the claim before spend", () => {
  const guard = renew.indexOf("authorizeRenewal");
  assert.ok(guard > 0 && guard < renew.indexOf("actions/checkout"));
  assert.ok(renew.indexOf("default_branch") < guard);
  assert.ok(renew.indexOf("beginRenewal") < renew.indexOf("renewPolicy"));
  assert.match(renew, /ref: \$\{\{ github.sha \}\}/);
  assert.match(renew, /--ignore-scripts/);
  assert.ok(!/pull_request.head|head_ref/.test(renew));
});
test("PR-time checks receive no secrets", () => {
  assert.ok(!/secrets\.|api-key|API_KEY/i.test(checks));
});
test("calibration checks branch and dispatcher first, and never writes the policy", () => {
  const guard = calibrateAction.indexOf("getCollaboratorPermissionLevel");
  assert.ok(guard > 0 && guard < calibrateAction.indexOf("actions/checkout"));
  assert.ok(
    calibrateAction.indexOf("default_branch") < calibrateAction.indexOf("actions/checkout"),
  );
  assert.match(calibrateAction, /ref: \$\{\{ github.sha \}\}/);
  assert.ok(!/policy\.json|pull_request.head|head_ref/.test(calibrateAction));
  // Dispatch inputs reach scripts only through environment variables.
  const scripts = calibrateAction
    .split("script: |\n")
    .slice(1)
    .map((block) => block.split(/\n(?! {10})/)[0]);
  assert.equal(scripts.length, 3);
  for (const script of scripts) assert.ok(!script.includes("${{"), script);
});
test("authorize-only stops both actions before any checkout, secret or spend", () => {
  for (const action of [review, renew]) {
    const steps = action.split("\n    - name: ").slice(2);
    for (const step of steps)
      assert.match(
        step,
        /inputs\.authorize-only != 'true'|steps\.claim\.outputs\.due == 'true'/,
        step.split("\n")[0],
      );
  }
});
