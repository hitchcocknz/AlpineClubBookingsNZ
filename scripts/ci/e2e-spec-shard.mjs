import { readdirSync } from "node:fs";
import path from "node:path";

// #4397: which `chromium` spec files one E2E shard runs. Playwright's own
// `--shard` cannot split this suite: `pre-setup` depends on `chromium`, which
// depends on `setup`, and a sharded run keeps a dependency chain whole, so
// shard 1 received all 203 tests and the others none. Each shard instead gets
// its own stack and database and a slice of the spec FILES, chosen here and
// applied as the project's `testMatch` (a CLI file filter would not hold:
// Playwright runs a project's dependencies in full whatever the filter).
//
// Round-robin over the sorted list keeps every shard's slice stable for a given
// tree and balanced to within one file; no file took over a minute on
// 25 Oct 2026 (624 s across 51 files).

/** `E2E_SHARD=i/N`, or null when unset (an ordinary, unsharded run). */
export function parseE2eShard(value) {
  if (value === undefined || value === "") return null;
  const match = /^([1-9]\d?)\/([1-9]\d?)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`Invalid E2E_SHARD: ${value} (expected i/N)`);
  return { index: Number(match[1]), total: Number(match[2]) };
}

/** The spec files (relative to the test dir, `/`-separated) the default `chromium` project owns. */
export function chromiumSpecFiles(testDir) {
  return readdirSync(testDir, { recursive: true })
    .map((entry) => String(entry).split(path.sep).join("/"))
    .filter((file) => file.endsWith(".spec.ts") && !/^(multi-lodge|pre-setup)\//.test(file))
    .sort();
}

export function specsForShard(files, { index, total }) {
  return [...files].sort().filter((_, position) => position % total === index - 1);
}

/** Exact-path patterns for a project's `testMatch`. */
export function exactSpecPatterns(files) {
  return files.map((file) => new RegExp(`(^|/)${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
}
