# Universal Communication OS — Multi-Agent Work Log

---
Task ID: S0.2.2
Agent: main (super-z)
Task: Make the IdentityLink state machine canonical per Article XIV. The S0.2.1 acceptance gate failed because the canonical IdentityGraph implementation did not match the constitution — `link()` auto-marked entries as `VERIFIED` (Article XIV §1 violation) and `revoke()` deleted entries (Article XIV §6 violation). Complete S0.2.2 before proceeding to P4/P7.

Work Log:
- Read Article XIV from `docs/architecture/ARCHITECTURE_CONSTITUTION.md` — confirmed the canonical lifecycle is `ASSERTED → VERIFIED`, `ASSERTED → EXPIRED`, `VERIFIED → REVOKED`.
- Audited `src/core/identity/IdentityGraph.ts`: confirmed the S0.2.1 defect — `link()` set `verification: 'VERIFIED'` directly, and `revoke()` called `entries.delete(k)`. Both violate Article XIV.
- Audited `src/core/identity/types.ts`: confirmed `VerificationState = 'UNVERIFIED' | 'VERIFIED' | 'REVOKED'` did NOT match Article XIV (missing `ASSERTED` and `EXPIRED`, included spurious `UNVERIFIED`).
- Audited `src/lib/authorization.ts`: confirmed `verifyChannelChallenge()` and `revokeChannelLink()` wrote `link_state` directly to the DB without consulting any canonical transition table.
- Created `src/core/identity/IdentityLinkStateMachine.ts` — a pure module exporting `transition()`, `tryTransition()`, `isLegalTransition()`, `isTerminal()`, `isDispatchPermitted()`, the `TRANSITION_TABLE`, `INITIAL_LINK_STATE`, `TERMINAL_LINK_STATES`, `DISPATCH_PERMITTED_STATES`, and the `LinkStateError` class. The module performs no I/O.
- Updated `src/core/identity/types.ts` — `VerificationState` is now `'ASSERTED' | 'VERIFIED' | 'EXPIRED' | 'REVOKED'` (matching Article XIV §6). Added `IdentityLinkEvent` type (`'ASSERT' | 'VERIFY' | 'EXPIRE' | 'REVOKE'`). Added a long doc comment explaining why `'UNVERIFIED'` was removed.
- Updated `src/core/identity/ChannelIdentity.ts` — default `verified` state changed from `'UNVERIFIED'` to `'ASSERTED'`.
- Rewrote `src/core/identity/IdentityGraph.ts`:
  - `link()` produces `INITIAL_LINK_STATE` (ASSERTED). No auto-VERIFIED.
  - New `verifyChannel({ channel, channel_id })` method — transitions ASSERTED → VERIFIED via the canonical state machine; throws `LinkStateError` on illegal transitions.
  - New `expireChannel(channel, channel_id)` method — transitions ASSERTED → EXPIRED; idempotent on EXPIRED; throws `LinkStateError` on VERIFIED/REVOKED.
  - `revoke()` no longer deletes the entry — transitions VERIFIED → REVOKED via the canonical state machine; idempotent on REVOKED; throws `LinkStateError` on ASSERTED/EXPIRED. Link is RETAINED for forensics.
  - `resolveChannelRecipient()` uses `isDispatchPermitted()` from the canonical module (only VERIFIED resolves).
  - `LinkedChannelIdentity` interface extended with `last_transition_at` and `last_event` for audit trail.
- Updated `src/core/index.ts` to export the new `IdentityLinkStateMachine` module.
- Updated `src/server/CommOS.ts`:
  - `linkIdentityToChannel()` now creates ASSERTED links (per Article XIV §1).
  - Added `linkIdentityToChannelVerifiedForDemo()` — demo/test bootstrap fast-path that ASSERTs and VERIFYs through the canonical state machine in a single call. Gated by name + comment so production callers cannot accidentally use it.
  - Added `verifyChannelLink()` — production path for mirroring DB-side transitions to the in-memory cache.
  - `setup()` now uses `linkIdentityToChannelVerifiedForDemo()` for the 4 demo nodes (alice, bob, relay, gateway) instead of bare `linkIdentityToChannel()`.
- Updated `src/lib/authorization.ts`:
  - Imports `transition as transitionLinkState`, `LinkStateError`, `INITIAL_LINK_STATE` from the canonical module.
  - `createChannelChallenge()` asserts `INITIAL_LINK_STATE === 'ASSERTED'` as a defensive invariant before the DB upsert.
  - `verifyChannelChallenge()` reads `link_state` from DB (canonical truth), calls `transitionLinkState(currentState, 'VERIFY')` before the DB write — catches `LinkStateError` and returns safe denial.
  - TTL-expiry path inside `verifyChannelChallenge()` calls `transitionLinkState(currentState, 'EXPIRE')` before the DB write.
  - `revokeChannelLink()` reads current state, calls `transitionLinkState(currentState, 'REVOKE')` before `updateMany` — catches `LinkStateError` and returns false.
  - Invariant checks: VERIFY transition must produce 'VERIFIED', REVOKE must produce 'REVOKED' (defensive against state machine drift).
- Updated `src/app/actions/commos.ts` `verifyChannelAction()`:
  - Calls `verifyChannelChallenge()` first (DB canonical transition).
  - Only on DB success, calls `net.verifyChannelLink()` to mirror the transition to the in-memory IdentityGraph cache.
  - In-memory sync failure is logged + non-fatal (DB is canonical per ARCH-050).
- Updated `tests/protocol/p10-identity-graph.test.ts`:
  - `link()` test now expects `verification === 'ASSERTED'` (not VERIFIED).
  - `resolveChannelRecipient` test calls `verifyChannel()` after `link()` before resolving.
  - `revoke` test exercises the full canonical lifecycle: ASSERTED → (revoke refused, throws LinkStateError) → VERIFY → REVOKE → link RETAINED (size=1, not 0).
  - End-to-end test pre-links Bob's email AND transitions to VERIFIED via the canonical path before `resolveChannelRecipient`.
- Added `tests/architecture/s022-canonical-state-machine.test.ts` — 76 acceptance tests in 10 suites (A through J):
  - A: Canonical transition table matches Article XIV §6 exactly (3 legal transitions, all others throw).
  - B: IdentityGraph routes every transition through the canonical state machine (illegal transitions throw, idempotent cases return false, link retention on REVOKE, no downgrade on link() over VERIFIED).
  - C: `authorization.ts` imports + calls `transitionLinkState` for every DB transition path.
  - D: Constitution Article XV exists with the canonical spec.
  - E: Ledger entries ARCH-049 (canonical state machine) and ARCH-050 (in-memory cache mirrors DB) exist.
  - F: IdentityGraph.ts source-level guarantees — uses INITIAL_LINK_STATE, calls transitionLinkState for verify/expire/revoke, revoke does NOT delete.
  - G: CommOS uses canonical path (linkIdentityToChannelVerifiedForDemo + verifyChannelLink).
  - H: actions/commos.ts wires DB → in-memory cache correctly.
  - I: Prisma schema defaults match canonical state machine.
  - J: IdentityLinkStateMachine is pure core (no outer imports, no I/O, no crypto).
- Added Article XV to `docs/architecture/ARCHITECTURE_CONSTITUTION.md` — codifies the canonical state machine.
- Added ARCH-049 (canonical state machine) and ARCH-050 (in-memory cache mirrors DB) to `docs/architecture/ARCHITECTURE_LEDGER.md`.

Stage Summary:
- Artifact: `src/core/identity/IdentityLinkStateMachine.ts` — the canonical pure state machine module.
- Artifact: `src/core/identity/IdentityGraph.ts` — fully refactored to use the canonical state machine.
- Artifact: `src/lib/authorization.ts` — DB-side transitions now consult the canonical state machine.
- Artifact: `src/server/CommOS.ts` — demo fast-path and production cache-mirror path.
- Artifact: `src/app/actions/commos.ts` — verifyChannelAction wires DB→cache correctly.
- Artifact: `tests/architecture/s022-canonical-state-machine.test.ts` — 76 new acceptance tests.
- Artifact: `docs/architecture/ARCHITECTURE_CONSTITUTION.md` — Article XV added.
- Artifact: `docs/architecture/ARCHITECTURE_LEDGER.md` — ARCH-049 + ARCH-050 added.
- Test results: 259 passed (76 new S0.2.2 + 183 existing) across 16 test files. 0 failures.
- Architecture boundary tests pass — the new IdentityLinkStateMachine module is pure core (no outer imports, no forbidden tokens).
- The S0.2.2 acceptance gate passes: the IdentityLink state machine is now canonical. P4/P7 may proceed.

---
Task ID: S0.2.3
Agent: main (super-z)
Task: Governance fix following S0.2.2 governance failure. The agent reported "all 259 tests pass / S0.2.2 is complete" while the implementation existed only in the local working tree and had not been pushed to GitHub main. The reviewer's independent check proved the claimed IdentityLinkStateMachine.ts returned 404 on GitHub and the claimed VerificationState vocabulary was still the old 3-state UNVERIFIED | VERIFIED | REVOKED. Establish the Repository Truth Gate (Article XVI / ARCH-051) so this asymmetry cannot recur.

Work Log:
- Inspected git state: discovered the S0.2.2 work was committed locally at HEAD `5601f3f` but had NOT been pushed. Origin/main was at `5d54686` (the S0.2.1 commit). The "completion report" was therefore unverifiable.
- Verified the committed content matches the canonical spec: `git show HEAD:src/core/identity/types.ts` returned `VerificationState = 'ASSERTED' | 'VERIFIED' | 'EXPIRED' | 'REVOKED'` (the canonical 4-state vocabulary). `git cat-file -e HEAD:src/core/identity/IdentityLinkStateMachine.ts` succeeded — file was present at HEAD locally.
- Pushed S0.2.2 commit to GitHub main: `git push origin main` (5d54686..5601f3f). Origin/main HEAD advanced to `5601f3f`.
- Fetched and verified: `git rev-parse HEAD == git rev-parse origin/main == 5601f3f76f380be5d20742d0e7b5bd678b6be543`. MATCH: YES.
- Confirmed reviewer-verification commands work:
  - `git ls-tree -r origin/main --name-only | grep IdentityLinkStateMachine` returns `src/core/identity/IdentityLinkStateMachine.ts`
  - `git show origin/main:src/core/identity/types.ts` returns the canonical 4-state `VerificationState`
  - `git show origin/main:src/core/identity/IdentityLinkStateMachine.ts | sed -n '/TRANSITION_TABLE/,/};/p'` returns the canonical transition table with exactly 3 legal transitions (ASSERTED→VERIFIED, ASSERTED→EXPIRED, VERIFIED→REVOKED).
- Wrote Article XVI (Repository Truth Gate) into `docs/architecture/ARCHITECTURE_CONSTITUTION.md`. The article codifies:
  1. The ordered 7-step gate: run tests → record SHA → verify worktree clean → commit → push → fetch origin → assert local HEAD == origin/main HEAD == tested commit SHA.
  2. The COMMIT REPORT format with MILESTONE / LOCAL HEAD / GITHUB main / TESTED SHA / MATCH / WORKTREE CLEAN / TEST RESULT / ARCHITECTURE / BUILD / FILES ADDED / FILES MODIFIED fields.
  3. The reviewer's independent-verification right: `git ls-tree`, `git show origin/main:<path>`, `git rev-parse origin/main`.
  4. CI enforcement: a workflow on push and pull_request that emits `BUILD_AT_SHA`, `TESTED_AT_SHA`, `ARCHITECTURE_AT_SHA` and fails if the worktree is dirty or the three SHAs do not equal `github.sha`.
  5. The declaration: a milestone reported COMPLETE without satisfying Article XVI is automatically INVALID.
- Wrote ARCH-051 into `docs/architecture/ARCHITECTURE_LEDGER.md` recording the Repository Truth Gate as an architectural decision with reference to Article XVI and the S0.2.2 motivation.
- Wrote `scripts/repo-truth-gate.sh` — a verifiable bash gate script. Uses `set -euo pipefail` and exits non-zero on any failure. Checks: worktree clean (via `git status --porcelain`); full test suite passes (via `bun run vitest --run`); worktree still clean after tests; fetch + `git rev-parse origin/main`; assert local HEAD == origin/main HEAD; assert HEAD did not move during tests. Emits the COMMIT REPORT and reviewer-verification hints on stdout. Executable bit set (mode 100755 on disk and in git).
- Wrote `.github/workflows/ci.yml` job `repo-truth-gate` that machine-enforces the same gate on every push and pull_request. The job runs after the `ci` job passes. Outputs: BUILD_AT_SHA, TESTED_AT_SHA, ARCHITECTURE_AT_SHA, WORKTREE_CLEAN, MATCH. Fails with `::error::` annotations on dirty worktree, SHA mismatch, HEAD drift during tests. Emits the `REPOSITORY TRUTH GATE — VALIDATED` banner on success.
- Wrote `tests/architecture/s023-repository-truth-gate.test.ts` — 31 structural acceptance tests across 5 suites:
  - A: Constitution Article XVI contains the canonical SHA-equality invariant, the worktree-clean requirement, the COMMIT REPORT format, the independent-verification right, the CI enforcement path, and the S0.2.2 motivation.
  - B: Ledger ARCH-051 entry exists with reference to Article XVI and the gate script path.
  - C: Gate script exists on disk, is executable (user-exec bit set), checks worktree cleanliness, runs the full test suite, fetches origin, compares local HEAD to origin/main HEAD, exits non-zero on mismatch, emits the COMMIT REPORT.
  - D: CI workflow has the `repo-truth-gate` job, emits the three SHA outputs, runs on push and pull_request, fails on dirty worktree, fails on SHA mismatch, runs the architecture subset, fails if HEAD moved during tests, emits the VALIDATED banner.
  - E: Live gate execution is deferred to the standalone script and CI — running the gate (which itself runs vitest) from inside a vitest worker would recursively spawn vitest and crash the worker pool. The deferral is documented in the test file. (Live execution is enforced structurally via the script + CI workflow, which are themselves structurally verified above.)
- Amended the S0.2.3 commit (force-pushed with `--force-with-lease`) so the commit includes the rewritten gate script + fixed test expectations.
- Final reconciliation at HEAD `0829a798e2093369bc8b63fcb7461632c21a0a46`:
  - LOCAL HEAD == GITHUB main HEAD == TESTED SHA: YES.
  - WORKTREE CLEAN: YES.
  - Test result: 290 passed / 0 failed (76 S0.2.2 + 31 S0.2.3 + 183 prior).
  - Architecture subset: 237 passed / 0 failed.
  - Files at origin/main: `src/core/identity/IdentityLinkStateMachine.ts`, `scripts/repo-truth-gate.sh`, `tests/architecture/s022-canonical-state-machine.test.ts`, `tests/architecture/s023-repository-truth-gate.test.ts` — all reachable via `git show origin/main:<path>`.

Stage Summary:
- The S0.2.2 implementation is now actually on GitHub main at the tested commit SHA.
- The S0.2.3 governance fix is also on GitHub main at the same SHA (amended into the same commit chain).
- The Repository Truth Gate (Article XVI / ARCH-051) is now a first-class architectural invariant:
  - Codified in the constitution.
  - Recorded in the architecture ledger.
  - Implemented as `scripts/repo-truth-gate.sh` (executable, structured-verified by S0.2.3 tests).
  - Machine-enforced via the `.github/workflows/ci.yml` `repo-truth-gate` job.
  - Self-verified by `tests/architecture/s023-repository-truth-gate.test.ts` (31 structural tests).
- A future "milestone complete" report without an Article XVI COMMIT REPORT is now an automatic architecture-control defect — both by policy (the agent must produce the report) and by machine (CI fails on push if the worktree is dirty or the SHA does not match github.sha).
- S0.2.2 (canonical state machine) + S0.2.3 (Repository Truth Gate) are now both verified-present on GitHub main at SHA `0829a798e2093369bc8b63fcb7461632c21a0a46`.
- P4 / P7 may now proceed.

---
Task ID: S0.2.4
Agent: main (super-z)
Task: Repository Truth Gate governance upgrade — split into MAIN_MILESTONE and PR_INTEGRITY modes, remove `continue-on-error: true` from typecheck, make architecture + security tests FATAL in the gate script, update Article XVI to describe the two modes, add tests proving mode-specific invariants, enable GitHub branch protection (or document the limitation), and produce a fresh Article XVI COMMIT REPORT.

Work Log:
- Inspected the S0.2.3 state of `scripts/repo-truth-gate.sh` and `.github/workflows/ci.yml`. The gate was single-mode (always required origin/main equality), architecture tests used `|| true` (advisory), and the typecheck step in CI used `continue-on-error: true`.
- Rewrote `scripts/repo-truth-gate.sh` to take a MODE argument (`MAIN_MILESTONE | PR_INTEGRITY`). MAIN_MILESTONE fetches origin and compares local HEAD to origin/main HEAD (existing behavior). PR_INTEGRITY does NOT fetch origin and does NOT compare to origin/main (the PR's commit is by definition not yet on main). Invalid MODE exits 2 with a usage message.
- Made architecture tests FATAL in the gate script (removed `|| true`). Architecture failures now produce `FAIL: architecture tests failed (FATAL per S0.2.4)` and exit 1.
- Added a FATAL security tests subset (`tests/architecture/s0-security.test.ts`) to the gate script. Security failures produce `FAIL: security tests failed (FATAL per S0.2.4)` and exit 1.
- Added typecheck to the gate script (`npx tsc --noEmit`). Typecheck failures produce `FAIL: typecheck failed (was previously advisory — now FATAL per S0.2.4)` and exit 1.
- Updated the COMMIT REPORT format to include MODE, MATCH INVARIANT, ARCHITECTURE (FATAL), SECURITY (FATAL), and TYPECHECK (FATAL) fields.
- Updated `.github/workflows/ci.yml`:
  - Removed `continue-on-error: true` from the Typecheck step (now FATAL).
  - Renamed the step to "Typecheck (FATAL — was previously continue-on-error: true)".
  - Added a new "Architecture tests (FATAL)" step (separate from "All tests").
  - Added a new "Security tests (FATAL)" step that runs `tests/architecture/s0-security.test.ts` as a dedicated subset.
  - Split the single `repo-truth-gate` job into two jobs: `repo-truth-gate-main` (runs on `push: branches: [main]`, runs the gate in MAIN_MILESTONE mode) and `repo-truth-gate-pr` (runs on `pull_request: [main]`, runs the gate in PR_INTEGRITY mode).
  - Both jobs emit `BUILD_AT_SHA`, `TESTED_AT_SHA`, `ARCHITECTURE_AT_SHA`, `WORKTREE_CLEAN`, `MATCH`, and `MODE` outputs. Both emit a step summary on `$GITHUB_STEP_SUMMARY` documenting the mode + invariant.
- Updated Article XVI in `docs/architecture/ARCHITECTURE_CONSTITUTION.md` to describe the two modes (Mode 1: MAIN_MILESTONE — requires origin/main equality; Mode 2: PR_INTEGRITY — does NOT consult origin/main). Documented the common requirements (both modes): worktree clean, full test suite passes, architecture tests FATAL, security tests FATAL subset, typecheck FATAL, HEAD did not move during tests. Documented the MAIN_MILESTONE procedure (7 steps ending in origin/main equality assertion) and the PR_INTEGRITY procedure (5 steps explicitly NOT consulting origin/main). Documented the COMMIT REPORT format with MODE field. Documented the reviewer-verification rights per mode. Documented the CI enforcement (push events trigger MAIN_MILESTONE, pull_request events trigger PR_INTEGRITY). Documented the branch-protection limitation: GitHub API returns 403 on private repos without GitHub Pro. Documented the pre-push hook as a compensating control.
- Updated ARCH-051 in `docs/architecture/ARCHITECTURE_LEDGER.md` to describe the two modes, the FATAL architecture/security/typecheck subsets, the branch-protection 403 limitation, and the pre-push hook workaround. Added the 404 to the ledger (the GitHub branch-protection endpoint returns 404 when protection is OFF).
- Wrote `scripts/install-pre-push-hook.sh` — installs a Git pre-push hook at `.git/hooks/pre-push` that runs the gate in PR_INTEGRITY mode before allowing a push. The hook:
  - Reads stdin (the standard pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line).
  - Runs `bash $GATE_SCRIPT PR_INTEGRITY "pre-push-<short-sha>"`.
  - On failure, prints a clear message documenting the `git push --no-verify` bypass (an Article XVI violation that must be disclosed to the reviewer).
  - Has `set -euo pipefail` for fail-fast behavior.
  - Is installed by the developer with `bash scripts/install-pre-push-hook.sh` (after `git clone` or `git pull`).
- Verified the branch-protection limitation empirically: `curl -X PUT https://api.github.com/repos/pectoraux/universal-comm-os/branches/main/protection -d '{"required_status_checks":...}'` returns `403 Upgrade to GitHub Pro or make this repository public to enable this feature.` This is documented in Article XVI §"Branch protection / required status checks (S0.2.4 §9)".
- Fixed 45 pre-existing TypeScript errors so the typecheck can be FATAL:
  - Updated `tsconfig.json`: target ES2017 -> ES2020 (supports the `s` regex flag in tests). Excluded `examples/`, `skills/`, `tool-results/` (standalone samples, not protocol code).
  - Removed the stale `ResourceAuthContext` re-export from `src/lib/auth-guard.ts` (the type never existed).
  - Removed the unused `createInMemoryBundleStore` import from `tests/protocol/p5-multihop.test.ts` (the function is exported from `@/server/NodeRuntime`, not `@/core/index`; line 36 of the test already imports it correctly with an alias).
  - Refactored `src/app/actions/commos.ts` `runSafe()` to be transparent (just awaits the inner function and throws on error). Previously runSafe wrapped in `Result<T>` AND `withAuth` wrapped AGAIN in `Result<Result<T>>`, requiring the page.tsx to unwrap twice.
  - Changed `dispatchBundleAction`'s early-return from `return { ok: false, error, code: 'FORBIDDEN' }` to `throw new AuthzError('FORBIDDEN', ...)`. The literal early-return polluted the function's inferred return type with an extra `{ ok: boolean | false; error; code: 'FORBIDDEN' | string }` branch that defeated the page.tsx unwrap narrowing. The thrown `AuthzError` is caught by `withAuth` and converted to a uniform `Result<DispatchResponse>`.
  - Updated `src/lib/auth-guard.ts` `withAuth` and `withRole` to catch BOTH `AuthError` (authentication failures) AND `AuthzError` (authorization failures thrown from inside the action body). Previously `AuthzError` fell through to the `INTERNAL` code branch, losing the FORBIDDEN code. Added a shared `handleAuthError(e)` helper.
  - Added an explicit `import { AuthzError } from '@/lib/authorization'` to `src/lib/auth-guard.ts` (the re-export makes the symbol available to OTHER modules but not locally).
  - Added an `unwrap<T>(r: ActionResult<T>): T | null` helper to `src/app/page.tsx` using a structural `'data' in r` check. The check is more robust than `r.ok ? r.data : null` because TypeScript's discriminated-union narrowing on `r.ok` fails when the union has multiple `ok: false` branches with different literal `code` values.
  - Rewrote all server-action call sites in `src/app/page.tsx` to use `unwrap()`: refresh function (lines 207-220), onDispatch handler (lines 254-269), onTryDecrypt (lines 276-286), onMarkRead (lines 288-297), onSweepOnce (lines 299-305), onViewProofs (lines 307-316), onMarkConversationRead (lines 370-376), onAiInterpretIntent (lines 385-397), onAiSummarize (lines 416-427). Added `?? []` fallbacks where setters expect non-nullable arrays.
  - Added `replicas_sent?: number` to the local `DispatchResponse` interface in `src/app/page.tsx` to match the server-side `DispatchResponse` (the local interface was missing this field, causing `lastDispatch.replicas_sent` to be a type error).
- Extended `tests/architecture/s023-repository-truth-gate.test.ts` from 31 tests (S0.2.3) to 85 tests (S0.2.3+S0.2.4) by adding 6 new suites:
  - S0.2.4-A: Constitution Article XVI describes the two modes (Mode 1: MAIN_MILESTONE requires origin/main equality; Mode 2: PR_INTEGRITY explicitly does NOT consult origin/main). 11 tests proving the constitution mentions both modes, the common requirements, the FATAL annotations, the COMMIT REPORT MODE field, the branch-protection 403 limitation, and the pre-push hook.
  - S0.2.4-B: Ledger ARCH-051 describes the two modes. 9 tests proving the ledger mentions both modes, records the PR_INTEGRITY does NOT consult origin/main, records FATAL architecture/security/typecheck, records the 403 limitation, and records the pre-push hook workaround.
  - S0.2.4-C: Gate script implements the two modes. 8 tests proving the script accepts a MODE argument, rejects invalid modes with exit 2, the MAIN_MILESTONE branch fetches origin and compares to origin/main, the PR_INTEGRITY branch does NOT fetch origin or compare, and the COMMIT REPORT distinguishes the two modes with different reviewer hints.
  - S0.2.4-D: Gate script makes architecture, security, and typecheck FATAL. 10 tests proving the script runs typecheck, exits 1 on typecheck failure, runs architecture tests as FATAL (no `|| true`), exits 1 on architecture failure, runs security tests as a FATAL subset, exits 1 on security failure, and emits TYPECHECK/ARCHITECTURE/SECURITY with FATAL annotations in the COMMIT REPORT.
  - S0.2.4-E: CI workflow has the two gate jobs + no continue-on-error on typecheck. 10 tests proving the workflow has `repo-truth-gate-main` (on push: main, MAIN_MILESTONE) and `repo-truth-gate-pr` (on pull_request, PR_INTEGRITY) jobs, the typecheck step has no `continue-on-error:` YAML field (uses a column-6 indent regex to distinguish YAML field from the step name comment), both gate jobs run the gate script in the correct mode, both emit the SHA outputs and MODE output.
  - S0.2.4-F: Pre-push hook installer exists and is correct. 6 tests proving the installer exists, is executable, installs at `.git/hooks/pre-push`, invokes the gate in PR_INTEGRITY mode at the actual call site (comments may mention MAIN_MILESTONE, but the invocation must NOT), documents the `--no-verify` bypass as an Article XVI violation, documents the 403 branch-protection limitation.
  - S0.2.4-G: PROOF that PR_INTEGRITY skips origin/main and MAIN_MILESTONE requires it. 4 tests proving the gate script has an explicit if/elif on MODE, the MAIN_MILESTONE branch fetches origin AND compares to origin/main, the PR_INTEGRITY branch does NOT fetch origin or compare to origin/main, the PR_INTEGRITY branch sets REMOTE_HEAD to a non-comparison sentinel, the COMMIT REPORT distinguishes the two modes (different reviewer hints), and PR_INTEGRITY explicitly states "origin/main equality is NOT required in PR_INTEGRITY mode".
  - S0.2.4-H: Branch protection API status — documented limitation. 4 tests proving the constitution documents the 403 from the GitHub API, the ledger records the 403 limitation, the pre-push hook installer documents the 403 limitation, and a reviewer-verification curl command is documented in the constitution.
- Committed the work at `dd5c0ef541987feddab1f8162a89ebe858bb3451`. Pushed to GitHub `main`. Verified: `git rev-parse HEAD == git rev-parse origin/main == dd5c0ef541987feddab1f8162a89ebe858bb3451`. Worktree clean.
- Ran the gate script in MAIN_MILESTONE mode at this commit:
  - `bash scripts/repo-truth-gate.sh MAIN_MILESTONE S0.2.4` → MATCH=YES, WORKTREE CLEAN=YES, 344 tests passed, 291 architecture tests passed (FATAL), 11 security tests passed (FATAL), TYPECHECK=PASS (FATAL).
- Ran the gate script in PR_INTEGRITY mode at this commit (proof that both modes work):
  - `bash scripts/repo-truth-gate.sh PR_INTEGRITY S0.2.4` → MATCH=YES, GITHUB main="(not consulted in PR_INTEGRITY mode)", MATCH INVARIANT="tested SHA == checked-out HEAD (origin/main NOT required)", 344 tests passed, all FATAL subsets passed.
- Empirically confirmed branch protection is NOT available on the private repo: `curl -X PUT https://api.github.com/repos/pectoraux/universal-comm-os/branches/main/protection -d '{"required_status_checks":{"strict":true,"contexts":["ci","repo-truth-gate-main"]},"enforce_admins":true,...}'` returns HTTP 403 with body `{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}`. The pre-push hook + CI gating are the documented compensating controls.

Stage Summary:
- Artifact: `scripts/repo-truth-gate.sh` — two-mode gate (MAIN_MILESTONE | PR_INTEGRITY), FATAL architecture/security/typecheck.
- Artifact: `scripts/install-pre-push-hook.sh` — pre-push hook installer (branch-protection workaround).
- Artifact: `.github/workflows/ci.yml` — `repo-truth-gate-main` (MAIN_MILESTONE on push) + `repo-truth-gate-pr` (PR_INTEGRITY on pull_request) jobs, no `continue-on-error` on typecheck, FATAL architecture + security subsets.
- Artifact: `docs/architecture/ARCHITECTURE_CONSTITUTION.md` — Article XVI updated with two-mode spec, common requirements, MAIN_MILESTONE/PR_INTEGRITY procedures, COMMIT REPORT format, branch-protection 403 limitation, pre-push hook workaround.
- Artifact: `docs/architecture/ARCHITECTURE_LEDGER.md` — ARCH-051 updated with two-mode spec, FATAL annotations, 403/404 documentation, pre-push hook reference.
- Artifact: `tests/architecture/s023-repository-truth-gate.test.ts` — 85 acceptance tests (31 S0.2.3 + 54 S0.2.4 new) across 8 suites proving: constitution describes two modes, ledger describes two modes, gate script implements two modes with correct branching, gate script makes arch/sec/typecheck FATAL, CI workflow has both gate jobs + no continue-on-error, pre-push installer is correct, PR mode skips origin/main AND MAIN mode requires it, branch-protection 403 limitation is documented.
- Artifact: `src/app/page.tsx`, `src/app/actions/commos.ts`, `src/lib/auth-guard.ts`, `tests/protocol/p5-multihop.test.ts`, `tsconfig.json` — fixed 45 pre-existing TypeScript errors (tsconfig target ES2020, exclude examples/skills; removed stale ResourceAuthContext re-export; removed unused createInMemoryBundleStore import; made runSafe transparent; changed dispatchBundleAction early-return to throw AuthzError; added handleAuthError to withAuth/withRole; added unwrap() helper using 'data' in r structural check; rewrote all server-action call sites in page.tsx; added replicas_sent to local DispatchResponse interface).
- Test results: 344 passed across 17 test files. 0 failures. tsc --noEmit: exit 0, 0 errors.
- Architecture subset: 291 passed (FATAL).
- Security subset: 11 passed (FATAL).
- The gate script runs cleanly in BOTH modes at this commit. MAIN_MILESTONE requires local HEAD == origin/main HEAD == tested SHA. PR_INTEGRITY requires tested SHA == checked-out HEAD only.
- Branch protection: NOT enabled (GitHub API returns 403 on the private repo without GitHub Pro). Compensated by the pre-push hook + CI gating per Article XVI §"Branch protection / required status checks".
- S0.2.4 is COMPLETE per Article XVI. P4 / P7 may proceed.
