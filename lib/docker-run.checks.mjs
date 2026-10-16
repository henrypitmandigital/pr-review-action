import assert from "node:assert/strict";
import test from "node:test";
import { runDocker } from "./docker-run.mjs";

test("deadline kills CLI and removes the uniquely named container without forwarding secrets", () => {
  const calls = [];
  const timeout = { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" } };
  const result = runDocker(["--rm", "image"], {
    env: { OPENROUTER_API_KEY: "test-placeholder" },
    spawn: (...args) => {
      calls.push(args);
      return timeout;
    },
  });
  assert.equal(result, timeout);
  assert.equal(calls.length, 2);
  const name = calls[0][1][2];
  assert.match(name, /^pr-review-[a-f0-9-]+$/);
  assert.equal(calls[0][2].killSignal, "SIGKILL");
  assert.equal(calls[0][2].timeout, 180000);
  assert.deepEqual(calls[1][1], ["rm", "--force", name]);
  assert.equal(calls[1][2].env, undefined);
  assert.equal(calls[1][2].killSignal, "SIGKILL");
  assert.equal(calls[1][2].timeout, 10000);
});

test("cleanup also happens if starting Docker throws", () => {
  const calls = [];
  assert.throws(
    () =>
      runDocker(["--rm", "image"], {
        spawn: (...args) => {
          calls.push(args);
          if (calls.length === 1) throw new Error("launch failed");
        },
      }),
    /launch failed/,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1], ["rm", "--force", calls[0][1][2]]);
});
