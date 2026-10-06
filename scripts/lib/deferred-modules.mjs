import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../../tooling/deferred-modules.json", import.meta.url), "utf8"));
export const DEFERRED_TEST_PATTERNS = manifest.modules.flatMap((module) => module.testPatterns);
const deferredGates = new Set(manifest.modules.flatMap((module) => module.gates));

// Manifest chỉ dùng glob repo-relative với * và **; không phụ thuộc runner.
function globRegex(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern.slice(i, i + 3) === "**/") {
      source += "(?:.*/)?";
      i += 2;
    } else if (pattern.slice(i, i + 2) === "**") {
      source += ".*";
      i += 1;
    } else if (pattern[i] === "*") source += "[^/]*";
    else source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

const deferredTests = DEFERRED_TEST_PATTERNS.map(globRegex);
export function isDeferredTest(path) {
  const relative = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return deferredTests.some((pattern) => pattern.test(relative));
}

export function isDeferredGate(scriptName) {
  return deferredGates.has(scriptName.replace(/\\/g, "/").replace(/^scripts\//, "").replace(/\.mjs$/, ""));
}
