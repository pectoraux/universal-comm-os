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
