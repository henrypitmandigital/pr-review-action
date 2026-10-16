import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CONFIG, CONFIG_DIR } from "./config.mjs";
import { SelectionError } from "./model-catalog.mjs";

// Missing fixture files mean an empty, unready suite: the owner baseline still
// reviews, but no challenger can qualify until labelled cases are adjudicated.
async function fixture(name, fallback, directory) {
  try {
    return await readFile(resolve(directory, "fixtures", name), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function loadSuite(directory = CONFIG_DIR) {
  const stableBytes = await fixture("cases.json", "[]", directory);
  const historicalBytes = await fixture("historical-pool.json", "[]", directory);
  const qualificationBytes = await fixture("qualification.json", '{"schema":1}', directory);
  const qualification = JSON.parse(qualificationBytes);
  const stable = JSON.parse(stableBytes);
  const pool = JSON.parse(historicalBytes);
  if (!Array.isArray(stable) || !Array.isArray(pool))
    throw new SelectionError("Invalid representative suite.");
  const cases = [
    ...pool.flatMap((c) => [
      {
        id: `${c.id}-buggy`,
        diff: c.buggy_diff,
        expected: c.expected,
        adjudication_notes: c.adjudication_notes,
        judge_control: c.buggy_judge_control ?? c.judge_control,
        critical: true,
        category: "historical",
        pr: c.pr,
        source_sha: c.buggy_sha,
      },
      {
        id: `${c.id}-fixed`,
        diff: c.fixed_diff,
        expected: null,
        adjudication_notes: c.adjudication_notes,
        judge_control: c.fixed_judge_control ?? c.judge_control,
        critical: true,
        category: "historical",
        pr: c.pr,
        source_sha: c.repair_sha,
      },
    ]),
    ...stable.map((c) => ({ ...c, category: "baseline" })),
  ];
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new SelectionError("Duplicate representative suite case.");
  return {
    cases,
    // Readiness is the owner's adjudication, bound to this repository, and
    // never possible for an empty or one-sided suite.
    ready:
      qualification.schema === 1 &&
      qualification.repository === CONFIG.repository &&
      qualification.ready === true &&
      stable.length > 0 &&
      pool.length > 0,
    qualification,
    hash: createHash("sha256")
      .update(stableBytes)
      .update(historicalBytes)
      .update(qualificationBytes)
      .digest("hex"),
    historical_prs: pool.map((c) => c.pr),
  };
}
