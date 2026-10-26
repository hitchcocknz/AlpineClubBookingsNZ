# Sekreton Orchestrator

**Audience: Agent.** Last reviewed **26 Oct 2026** (owner decisions: #4429, #4404). Any agent (Claude Code, Codex, or a fresh session) acting as the
orchestrator for the Sekreton lane on `thatskiff33/AlpineClubBookingsNZ`. AGENTS.md and
[`COORDINATION.md`](COORDINATION.md) win wherever this page disagrees with them.

## Goal (owner, 26 Oct 2026, #4429)

Every open issue is closed with a plain-English close-out comment. Every PR it needed is
CI-green on its exact head and merged with a merge commit under AGENTS.md "Completion
and Merge". The orchestrator's job is to **fill Sekreton's gaps and keep Sekreton
moving**, with no owner input outside the owner's two daily review windows.

## Why an orchestrator is needed: Sekreton's gaps

| Gap | Who fills it |
| --- | --- |
| Task sandboxes have no GitHub write (ALP-83): no CLAIM, LANE-SYNC, review, ready or close-out comment | Orchestrator, as `thatskiff33-agents` |
| The project ships by pull request, so Sekreton never merges | Orchestrator merges under gate #3959 |
| Sekreton's gates are only `lint` + `knip` (4 GB sandbox, `.sekreton/config.toml`) | Orchestrator runs `typecheck`, `test:related`, `test:named`, mutation checks and realdb suites locally (WSL host: 16 cores, 23 GB, Docker), and fixes red PR CI |
| Agents can't push to a branch someone else opened | Orchestrator finishes released PRs in a local worktree |
| Task plans must be approved, and dependent tasks only start once their predecessors ship | Orchestrator approves plans and edits dependencies when the board changes |

## Identities

- Use `gh` as **`thatskiff33-agents` only**. Never act as `thatskiff33` (the owner),
  even if that login is present. Never write approval wording.
- Sign GitHub comments `Sekreton lane (orchestrator)`.

## Owner decisions in force

Read each one at source on #4429 and #4404:

- Up to **3** Sekreton implementation tasks at once, on units that don't overlap.
  One writer per shared financial invariant. One heavy local job (typecheck, full
  suite, E2E, build) at a time on the host.
- Owner decisions are batched into two review windows a day (06:00 and 21:00 NZ).
  Everything else proceeds without the owner.

## Where it runs

On the owner's WSL host, as systemd user timers. They run outside the repository, so no
tracked file holds credentials. Each timer runs `claude -p` headless under `flock`:

- `sekreton-pass.timer` runs a pass at :07 and :37 past every hour;
- `sekreton-digest.timer` runs the digest at 05:45 and 20:45.

The runner, its prompts and its `state/` folder (`HANDOFF.md`, `log.md`, the
`task_changes` cursor) live in `~/src/sekreton-orchestrator/`. An empty `state/PAUSE`
file skips every run until it is removed. Another host can run the same loop with any
scheduler. The contract is this page.

## One pass (runs every 30 minutes; a lock prevents overlap)

1. **Read state.** Read the Sekreton queue (`get_queue`) and status changes
   (`task_changes`, with the cursor kept in `state/cursor`). Read open PRs and their
   checks, and new comments from `thatskiff33` since the last pass.
2. **Unstick.** For each task that is failed, stopped, gates-failed, push-failed,
   conflicted, or quiet long enough to look stalled (`get_activity`): read why. Then
   retry, `request_changes` with a concrete fix, or finish the work locally. Exit 137
   or out-of-memory: don't blindly retry. Shrink the task or run that step locally.
3. **Land PRs.** For each Sekreton-lane PR:
   - local validation (above);
   - review lenses chosen for its risk (AGENTS.md "Orchestration Model"), with every
     finding fixed or rejected with reasons;
   - the PR body passes `pr:check`;
   - green on its exact head, not a draft, no conflicts;
   - Ready-to-Merge comment on the issue and the PR;
   - `gh pr merge --merge`;
   - plain-English close-out on the issue;
   - close the Sekreton task, delete the branch, `pnpm run stale-containers`.
4. **Fill slots.** Keep 3 units running. Pick from the board reconcile, in order:
   MERGE-READY, FINISH-PR, BLOCKED-now-unblocked, FRESH-BUILD, INVESTIGATE. Before
   starting, re-read the issue thread for a new CLAIM or decision. Prefer a Sekreton
   task (approve its plan, or create it with a complete brief). Finish a released PR
   locally when only its existing branch can carry the work. Close stale Sekreton tasks
   whose issue is already closed, with a reason.
5. **Decisions.** When work needs the owner:
   - write a `needs-decision` issue, or a section in the existing issue, with checkbox
     options, a **Recommended** default and plain-English stakes;
   - add it to the owner queue;
   - move on to other work.

   Act on a direct `thatskiff33` comment as the decision, record it in the issue body
   in the same sitting, and remove `needs-decision`.
6. **Log.** Append one line per action to `state/log.md`. Don't pad passes. When
   nothing changed, write one line and stop.

## Owner queue digest (05:45 and 20:45 NZ)

Rewrite the pinned issue **"Owner queue (Sekreton orchestrator)"** with these sections:

- **Decisions needed:** link, one-line question, recommended option.
- **Needs you:** owner-only steps, such as production operations, deploys, and
  approvals a policy reserves for `thatskiff33`.
- **Shipped since the last digest:** PR, issue, one line each.
- **In flight:** each unit and its stage.
- **Blocked / risks.**

Email the owner a link to it, with the counts.

## Hard limits

- Never push to `main`, squash, rebase-merge or force-push.
- Never touch production, live Stripe/Xero/SES, real credentials or production data.
  Production operations are the owner's alone.
- Respect any new external CLAIM (it wins). Don't take issues the owner has
  explicitly reserved.
- Usage: the owner runs several plans and accepts the spend (26 Oct). When a pass hits
  a usage limit, it stops cleanly: push work in progress, update `state/HANDOFF.md`,
  and log the limit. The owner resumes with another agent or plan.

## Resuming: any agent, any plan

All state lives on GitHub, in Sekreton, and in the runner's `state/` folder (see "Where it runs"). Nothing
depends on a chat session. Each pass rewrites `state/HANDOFF.md`, which holds:

- each unit in flight: issue, PR, branch, worktree, Sekreton task, stage, and next step;
- local work that hasn't been pushed (there should be none);
- background jobs that were running;
- the `task_changes` cursor.

To resume, a new agent reads, in order:

1. this page;
2. `state/HANDOFF.md`;
3. the last 40 lines of `state/log.md`;
4. the pinned "Owner queue" issue.

Then it runs a pass. A unit's stage can always be re-derived from GitHub (PR head,
checks, comments) and Sekreton (`get_task`), so a stale HANDOFF is safe. Verify
against those sources before acting.
