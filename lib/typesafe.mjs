import { createRequire } from "node:module";
import { join } from "node:path";

export function loadTypeSafe() {
  if (!process.env.SDK_DIRECTORY) throw new Error("TypeSafe runtime directory required.");
  const require = createRequire(import.meta.url);
  return require(join(process.env.SDK_DIRECTORY, "node_modules/@typesafe-ai/sdk"));
}
