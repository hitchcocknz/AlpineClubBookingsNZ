#!/usr/bin/env node
/**
 * Fails early, and by name, when the install-script approvals in
 * `pnpm-workspace.yaml` no longer match what the lockfile installs, or when
 * Dependabot's `install-scripts` group could stop catching those packages
 * (#4364).
 *
 * ## Why
 *
 * `allowBuilds` approves each package's install script at one exact version
 * (#3673). A bump of one of those packages makes `pnpm install
 * --frozen-lockfile` stop with `ERR_PNPM_IGNORED_BUILDS`, deep in the install
 * log and with no pointer to what to do. This runs before the install, names
 * the package and both versions, and says where the review procedure lives.
 *
 * The second half pins `.github/dependabot.yml`. Its `install-scripts` group is
 * meant to give such a bump a PR of its own, but Dependabot does not assign a
 * dependency to the first group that matches, as its documentation says: the
 * updater scores every match (dependabot-core `PatternSpecificityCalculator`),
 * and a group with no `patterns` outscores a wildcard such as `@sentry/*`. So
 * every other npm group must list each `install-scripts` pattern under
 * `exclude-patterns`, and every approved package must match one of those
 * patterns.
 *
 * Source-only: it reads three files with the repository's own YAML reader
 * (`parseWorkflowYaml`), needs no install and no network, and so runs in
 * `verify` before the install.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseWorkflowYaml } from "./check-workflow-suite-checkout-depth.mjs";

export const WORKSPACE_FILE = "pnpm-workspace.yaml";
export const LOCKFILE = "pnpm-lock.yaml";
export const DEPENDABOT_FILE = path.join(".github", "dependabot.yml");
export const INSTALL_SCRIPTS_GROUP = "install-scripts";

/** Where a reader is sent: the one home of the review procedure. */
export const REAPPROVAL_GUIDE =
  'CONTRIBUTING.md -> "Package manager: pnpm" -> "Bumping a package that runs an install script"';

/** `@scope/name@1.2.3` -> `@scope/name` and `1.2.3`; a bare name has no version. */
function splitNameAndVersion(key) {
  const at = key.lastIndexOf("@");
  if (at <= 0) return { name: key, version: undefined };
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/**
 * The `allowBuilds` entries of `pnpm-workspace.yaml`, in file order. Each is
 * `{ name, versions, allowed }`; `versions` is empty for a bare name, and holds
 * every version of an `a || b` union. Throws on a value that is not `true` or
 * `false`, since nothing else is a reviewed answer.
 */
export function readAllowBuilds(workspaceText) {
  const block = parseWorkflowYaml(workspaceText).allowBuilds;
  if (block === undefined) return [];
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new Error(`${WORKSPACE_FILE}: \`allowBuilds\` is not a mapping.`);
  }
  return Object.entries(block).map(([key, value]) => {
    if (value !== "true" && value !== "false") {
      throw new Error(`${WORKSPACE_FILE}: unreadable allowBuilds entry \`${key}: ${value}\`.`);
    }
    const { name, version } = splitNameAndVersion(key);
    const versions = version === undefined ? [] : version.split("||").map((v) => v.trim());
    return { name, versions, allowed: value === "true" };
  });
}

/** Every version `pnpm-lock.yaml` resolves for each package, from its `packages` keys. */
export function lockfileVersions(lockText) {
  const packages = parseWorkflowYaml(lockText).packages;
  const versions = new Map();
  if (!packages || typeof packages !== "object") return versions;
  for (const key of Object.keys(packages)) {
    const { name, version } = splitNameAndVersion(key);
    if (version === undefined) continue;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(version.split("(")[0]);
  }
  return versions;
}

/** Why `allowBuilds` and the lockfile disagree; empty when every approval matches. */
export function allowBuildsProblems({ workspaceText, lockText }) {
  const resolved = lockfileVersions(lockText);
  const problems = [];
  for (const { name, versions, allowed } of readAllowBuilds(workspaceText)) {
    if (!allowed) continue;
    if (versions.length === 0) {
      problems.push(
        `${name}: allowBuilds approves every version of it. Pin the exact version that was reviewed.`,
      );
      continue;
    }
    const approved = versions.join(" || ");
    const installed = resolved.get(name);
    if (!installed) {
      problems.push(
        `${name}: allowBuilds approves ${approved}, but ${LOCKFILE} no longer installs ${name}. ` +
          "Remove the entry.",
      );
      continue;
    }
    const sameSet =
      installed.size === versions.length && versions.every((version) => installed.has(version));
    if (!sameSet) {
      problems.push(
        `${name}: allowBuilds approves ${approved}, but ${LOCKFILE} resolves ` +
          `${[...installed].sort().join(", ")}.`,
      );
    }
  }
  return problems;
}

/** Dependabot's `*` wildcard, as a whole-name match. */
function matchesPattern(pattern, name) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

/** Why `.github/dependabot.yml` could let an approved package escape its group; empty when it cannot. */
export function dependabotGroupProblems({ dependabotText, workspaceText }) {
  const updates = asList(parseWorkflowYaml(dependabotText).updates);
  const npm = updates.find((update) => update?.["package-ecosystem"] === "npm");
  if (!npm) return [`${DEPENDABOT_FILE}: no \`npm\` update entry.`];
  const groups = npm.groups ?? {};
  const installScripts = groups[INSTALL_SCRIPTS_GROUP];
  const patterns = asList(installScripts?.patterns);
  if (patterns.length === 0) {
    return [`${DEPENDABOT_FILE}: the npm \`${INSTALL_SCRIPTS_GROUP}\` group has no \`patterns\`.`];
  }

  const problems = [];
  for (const [name, group] of Object.entries(groups)) {
    if (name === INSTALL_SCRIPTS_GROUP) continue;
    const excluded = new Set(asList(group?.["exclude-patterns"]));
    const missing = patterns.filter((pattern) => !excluded.has(pattern));
    if (missing.length > 0) {
      problems.push(
        `${DEPENDABOT_FILE}: group \`${name}\` does not exclude ${missing.map((p) => `"${p}"`).join(", ")}. ` +
          `Dependabot scores group matches rather than taking the first, so every other npm group ` +
          `must list each \`${INSTALL_SCRIPTS_GROUP}\` pattern under \`exclude-patterns\`.`,
      );
    }
  }
  for (const { name, allowed } of readAllowBuilds(workspaceText)) {
    if (!allowed) continue;
    if (!patterns.some((pattern) => matchesPattern(pattern, name))) {
      problems.push(
        `${DEPENDABOT_FILE}: ${name} runs an approved install script, but no ` +
          `\`${INSTALL_SCRIPTS_GROUP}\` pattern matches it.`,
      );
    }
  }
  return problems;
}

/** Both checks against the files under `root`. */
export function checkWorkingTree(root) {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const workspaceText = read(WORKSPACE_FILE);
  const allowBuilds = allowBuildsProblems({ workspaceText, lockText: read(LOCKFILE) });
  const dependabot = dependabotGroupProblems({ dependabotText: read(DEPENDABOT_FILE), workspaceText });
  const approvals = readAllowBuilds(workspaceText).filter((entry) => entry.allowed).length;
  return { allowBuilds, dependabot, approvals };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const { allowBuilds, dependabot, approvals } = checkWorkingTree(process.cwd());
    if (allowBuilds.length > 0) {
      console.error(`Install-script approvals in ${WORKSPACE_FILE} do not match ${LOCKFILE} (#4364):`);
      for (const problem of allowBuilds) console.error(`  - ${problem}`);
      console.error("");
      console.error(
        "The install would stop with ERR_PNPM_IGNORED_BUILDS. Read what the new version's " +
          "install script does, then move the approval to it in allowBuilds, as " +
          `${REAPPROVAL_GUIDE} describes.`,
      );
      console.error("");
    }
    if (dependabot.length > 0) {
      console.error("Dependabot could put an install-script package in the wrong group (#4364):");
      for (const problem of dependabot) console.error(`  - ${problem}`);
    }
    if (allowBuilds.length > 0 || dependabot.length > 0) {
      process.exitCode = 1;
    } else {
      console.log(
        `allowBuilds check passed: ${approvals} approval(s) match ${LOCKFILE}, and ` +
          `${DEPENDABOT_FILE} keeps them in the ${INSTALL_SCRIPTS_GROUP} group.`,
      );
    }
  } catch (error) {
    console.error(`allowBuilds check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
