import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG, ConfigError, parseConfig } from "./config.mjs";
import { repositoryCeiling } from "./policy.mjs";
import { loadSuite } from "./suite.mjs";

const valid = () => ({
  schema: 1,
  repository: "o/r",
  baseline: { model: "vendor/model", created: 1 },
});

test("minimal config takes the shared defaults", () => {
  const config = parseConfig(valid());
  assert.equal(config.stateBranch, "pr-review-policy");
  assert.equal(config.maxCallUsd, 0.2);
  assert.equal(config.reviewerClass.baselineReasoning, "off");
  assert.deepEqual(config.reviewProfile, {
    inputTokens: 32000,
    outputTokens: 8192,
    reasoningTokens: 2048,
  });
  assert.ok(Object.isFrozen(config.reviewerClass));
});
for (const [name, mutate] of [
  ["schema", (c) => (c.schema = 2)],
  ["repository", (c) => (c.repository = "no-owner")],
  ["model id", (c) => (c.baseline.model = "vendor/model\nINJECT=1")],
  ["created", (c) => (c.baseline.created = 0)],
  ["ceiling", (c) => (c.max_call_usd = -1)],
  ["tokens", (c) => (c.challenger = { input_tokens: 1.5 })],
  ["reasoning", (c) => (c.baseline.reasoning = "high")],
  ["state branch", (c) => (c.state_branch = "../main")],
]) {
  test(`rejects invalid ${name}`, () => {
    const config = valid();
    mutate(config);
    assert.throws(() => parseConfig(config), ConfigError);
  });
}
test("a repository variable can lower but never raise the configured ceiling", () => {
  assert.equal(repositoryCeiling({}), CONFIG.maxCallUsd);
  assert.equal(repositoryCeiling({ PR_REVIEW_MAX_CALL_USD: "" }), CONFIG.maxCallUsd);
  assert.equal(repositoryCeiling({ PR_REVIEW_MAX_CALL_USD: "0.05" }), 0.05);
  assert.equal(repositoryCeiling({ PR_REVIEW_MAX_CALL_USD: "99" }), CONFIG.maxCallUsd);
  assert.throws(() => repositoryCeiling({ PR_REVIEW_MAX_CALL_USD: "abc" }));
});
test("a repository without fixtures has an empty, unready suite", async () => {
  const suite = await loadSuite(await mkdtemp(join(tmpdir(), "pr-review-")));
  assert.equal(suite.cases.length, 0);
  assert.equal(suite.ready, false);
});
test("readiness is bound to this repository and to adjudicated cases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-review-"));
  await import("node:fs/promises").then((fs) => fs.mkdir(join(dir, "fixtures")));
  const write = (name, value) => writeFile(join(dir, "fixtures", name), JSON.stringify(value));
  await write("qualification.json", { schema: 1, repository: CONFIG.repository, ready: true });
  assert.equal((await loadSuite(dir)).ready, false, "empty suite is never ready");
  await write("cases.json", [{ id: "a", diff: "d" }]);
  await write("historical-pool.json", [{ id: "h", pr: 1 }]);
  assert.equal((await loadSuite(dir)).ready, true);
  await write("qualification.json", { schema: 1, repository: "other/repo", ready: true });
  assert.equal((await loadSuite(dir)).ready, false);
  await write("cases.json", [{ id: "h-buggy" }]);
  await assert.rejects(loadSuite(dir), /Duplicate/);
});
