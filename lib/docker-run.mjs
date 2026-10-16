import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// Kill the CLI at the deadline, then forcibly remove its uniquely named
// container. SIGTERM alone can wait indefinitely for a Docker PID-1 process.
export function runDocker(args, { env = process.env, timeout = 180000, spawn = spawnSync } = {}) {
  const name = `pr-review-${randomUUID()}`;
  try {
    return spawn("docker", ["run", "--name", name, ...args], {
      env,
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 2000000,
      encoding: "utf8",
    });
  } finally {
    spawn("docker", ["rm", "--force", name], {
      timeout: 10000,
      killSignal: "SIGKILL",
      stdio: "ignore",
    });
  }
}
