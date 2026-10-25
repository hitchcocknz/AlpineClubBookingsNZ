import path from "node:path";

import { chromiumSpecFiles, exactSpecPatterns, parseE2eShard, specsForShard } from "./e2e-spec-shard.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");

describe("E2E spec shards (#4397)", () => {
  it("parses E2E_SHARD, treating unset as an unsharded run and refusing a bad value", () => {
    expect(parseE2eShard(undefined)).toBeNull();
    expect(parseE2eShard("")).toBeNull();
    expect(parseE2eShard("2/3")).toEqual({ index: 2, total: 3 });
    for (const bad of ["0/3", "4/3", "3", "a/b", "1/0", "1/3 "]) expect(() => parseE2eShard(bad)).toThrow(/Invalid E2E_SHARD/);
  });

  it("splits the real chromium specs into disjoint shards that together hold every spec exactly once", () => {
    const files = chromiumSpecFiles(path.join(root, "e2e"));
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.startsWith("multi-lodge/") || file.startsWith("pre-setup/"))).toBe(false);
    for (const total of [1, 2, 3, 4]) {
      const shards = Array.from({ length: total }, (_, i) => specsForShard(files, { index: i + 1, total }));
      expect(shards.flat().sort()).toEqual(files);
      expect(new Set(shards.flat()).size).toBe(files.length);
      const sizes = shards.map((shard) => shard.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });

  it("matches each chosen file exactly, never a file whose name merely contains it", () => {
    const [pattern] = exactSpecPatterns(["waitlist.spec.ts"]);
    expect(pattern.test("/repo/e2e/waitlist.spec.ts")).toBe(true);
    expect(pattern.test("/repo/e2e/admin-waitlist.spec.ts")).toBe(false);
    expect(pattern.test("/repo/e2e/waitlistXspec.ts")).toBe(false);
  });
});
