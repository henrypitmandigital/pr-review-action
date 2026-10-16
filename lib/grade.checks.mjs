import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeBatch } from "./grade.mjs";
import { loadSuite } from "./suite.mjs";

const fixture = (await loadSuite()).cases.find((c) => c.id === "path-traversal-fixed");
for (const control of ["unsupported", "supported"])
  test(`judge sanity control ${control} ${control === "unsupported" ? "allows" : "blocks"} candidate grades`, async () => {
    const client = {
      async systemOne({ questions, state }) {
        assert.equal(Object.keys(questions).length, 7);
        assert.equal(state.evidence[0].reviews.length, 4);
        // Desired control outcome is withheld from judge state.
        assert.equal(state.evidence[0].judge_control, undefined);
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((k) => [
              k,
              {
                choice: k.endsWith("_control")
                  ? control
                  : k.endsWith("_finding")
                    ? "found"
                    : "supported",
                confidence: 0.9,
              },
            ]),
          ),
        };
      },
    };
    const row = Array.from({ length: 3 }, () => ({
      execution: "completed",
      review: { key_issues_to_review: [] },
    }));
    const result = await gradeBatch([fixture], [row], { client, sdk: { choice: () => ({}) } });
    assert.equal(result.controlsPassed, control === "unsupported");
    assert.equal(
      result.grades[0].every((g) => g.passed),
      control === "unsupported",
    );
    assert.equal(result.grades[0][0].confidence.claims, 0.9);
  });
for (const kind of ["finding", "claims", "control"])
  test(`low ${kind} confidence cannot qualify a candidate`, async () => {
    const client = {
      async systemOne({ questions }) {
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((k) => [
              k,
              {
                choice: k.endsWith("_control")
                  ? "unsupported"
                  : k.endsWith("_finding")
                    ? "found"
                    : "supported",
                confidence: k.endsWith(`_${kind}`) ? 0.25 : 0.9,
              },
            ]),
          ),
        };
      },
    };
    const result = await gradeBatch(
      [fixture],
      [[{ execution: "completed", review: { key_issues_to_review: [] } }]],
      { client, sdk: { choice: () => ({}) } },
    );
    assert.equal(result.grades[0][0].passed, false);
    assert.equal(
      result.grades[0][0].reason,
      kind === "control" ? "judge_control_failed" : "judgment_uncertain",
    );
  });
