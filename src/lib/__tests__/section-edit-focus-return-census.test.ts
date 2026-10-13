// Every staged section wires its focus return (#4087, `INV-SSOT-001`).
//
// `useSectionEditState` returns focus after Save or Cancel by itself, but the
// Edit it returns to is unmounted while the editor is open, so the one rendered
// in its place is found by the per-instance marker in `editTriggerProps`, and
// the section to fall back to by `sectionRegionProps`. A section that forgets
// either still works — focus falls back to the nearest landmark — so nothing
// else would notice. This census does.
//
// It reads the tree from disk, so `pnpm run test:related` cannot reach it — run
// it by name (`pnpm run test:named`) when a section adopts the hook.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

function trackedSources(): string[] {
  const listing = execFileSync("git", ["ls-files", "-z", "src"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing
    .split("\0")
    .filter(Boolean)
    .filter((file) => file.endsWith(".tsx"))
    .filter((file) => !file.includes("__tests__/") && !/\.test\.tsx$/.test(file));
}

/** Each `const x = useSectionEditState…` whose Edit the section renders. */
function editableInstances(source: string): string[] {
  return [...source.matchAll(/const\s+(\w+)\s*=\s*useSectionEditState\b/g)]
    .map((match) => match[1])
    .filter((name) => source.includes(`${name}.startEditing`));
}

describe("staged sections wire their focus return (#4087)", () => {
  const adopters = trackedSources()
    .map((file) => ({
      file,
      source: stripComments(
        fs.readFileSync(path.join(process.cwd(), file), "utf8"),
      ),
    }))
    .map((entry) => ({ ...entry, instances: editableInstances(entry.source) }))
    .filter((entry) => entry.instances.length > 0);

  it("finds the adopters", () => {
    // Twenty-one sections open their editor through `startEditing` today; a scan
    // that finds a handful has stopped reading the tree.
    expect(adopters.length).toBeGreaterThan(15);
  });

  it("spreads editTriggerProps and sectionRegionProps for every instance that opens an editor", () => {
    const missing = adopters.flatMap(({ file, source, instances }) =>
      instances.flatMap((name) =>
        ["editTriggerProps", "sectionRegionProps"]
          .filter((prop) => !source.includes(`${name}.${prop}`))
          .map((prop) => `${file}: ${name}.${prop}`),
      ),
    );
    expect(
      missing,
      "#4087: spread `editTriggerProps` on the section's Edit and " +
        "`sectionRegionProps` on its card, so focus returns to the Edit " +
        "rendered after Save or Cancel, or to the section when it is gone.",
    ).toEqual([]);
  });
});
