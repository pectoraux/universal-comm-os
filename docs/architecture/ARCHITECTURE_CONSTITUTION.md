# ARCHITECTURE CONSTITUTION — Universal Communication OS

Frozen architectural decisions. Changing any of these requires an Architecture Change Proposal (ACP) approved through `CHANGE_CONTROL.md`.

## Article I — Layer Boundaries

1. **Core protocol primitives** (`src/core/*`) MUST NOT import from any layer that depends on a specific transport, channel adapter, platform UI, or runtime framework.
   - Forbidden imports from `core/`: `@/adapters/*`, `@/matrix/*`, `@/transport/*` (impl), `@/components/*`, `@/app/*`, `next`, `react`, `@prisma/client`.
2. **Transport implementations** (`src/transport/*`) MUST implement the `Transport` interface defined in `core/transport`. They may depend on `core/*` but MUST NOT depend on `adapters/*` or `matrix/*`.
3. **Channel adapters** (`src/adapters/*`) MUST implement the `ChannelAdapter` interface defined in `core/adapters`. They MUST NOT be imported by `core/*` or `transport/*`.
4. **Gateway runtime** (`src/gateway/*`) MAY depend on `core/*`, `transport/*`, and `adapters/*`. It MUST NOT be imported by `core/*`.
5. **Matrix integration** (`src/matrix/*`) is one fabric implementation among potentially many. `core/*` MUST NOT depend on it.
6. **Web/Electron UI** (`src/app/*`, `src/components/*`) consumes the Communication OS API. UI code MUST NOT contain channel-specific or transport-specific branching logic. UI MUST NOT directly invoke channel APIs.
7. **Server runtime** (`src/server/*`) hosts the Communication OS API and MAY depend on all lower layers.

## Article II — Universal Identity

1. `UniversalIdentity` is a transport-independent principal.
2. Channel identifiers (Matrix ID, phone, email, WhatsApp ID, …) are `ChannelIdentity` instances attached to a `UniversalIdentity`.
3. The protocol MUST NOT use a channel identifier as the universal identity primitive.
4. Identity linking MUST NOT auto-merge accounts based on unverified signals (name, avatar, phone number).

## Article III — Communication Intent

1. `Intent` expresses *what* the sender wants to accomplish (SEND_MESSAGE, NOTIFY, REQUEST_RESPONSE, DELIVER_DOCUMENT, SEND_MEDIA, EMERGENCY_ALERT, SYNC_CONVERSATION, …).
2. `Intent` MAY carry constraints: priority, TTL, max cost, latency requirement, privacy requirement, delivery requirement, payload constraints, preferred transports, fallback policy.
3. Applications express Intent. They MUST NOT call channel APIs directly. Transport selection belongs to the protocol/routing layer.

## Article IV — Communication Bundle

1. `CommunicationBundle` is the fundamental routable object.
2. Every bundle carries: `bundle_id`, `sender`, `recipient`, `conversation_id`, `intent`, `created_at`, `expires_at`, `priority`, `routing_policy`, `encryption_metadata`, `payload`, `delivery_requirements`, `proofs`.
3. Bundles MUST support: persistence, deduplication, expiry, prioritization, forwarding, store-and-forward, replication policies, delivery state, routing metadata, encryption, authentication, integrity, constrained transports.
4. A bundle MUST NOT inherently depend on Internet connectivity.

## Article V — Routing

1. Routing operates over **capabilities, policy, and resources** — NOT over device types.
2. Forbidden: `if device_type === 'android'`. Required: `if node.capabilities.has(BLE_RELAY)`.
3. A route MAY be a single hop or a multi-hop DTN path. The routing abstraction MUST permit all of:
   - Bluetooth → Wi-Fi → Internet → Matrix
   - SMS
   - Matrix
   - Bluetooth → Relay → Gateway → SMS
   - Bluetooth → Destination

## Article VI — Delivery Semantics

1. `sent = true` is forbidden as the delivery model.
2. Delivery is an explicit state machine:
   `CREATED → ACCEPTED → QUEUED → RELAYED → GATEWAY_REACHED → EXTERNAL_ACCEPTED → DELIVERED → READ`
3. Failure states: `EXPIRED`, `REJECTED`, `POLICY_BLOCKED`, `NO_ROUTE`, `CHANNEL_UNAVAILABLE`, `GATEWAY_UNAVAILABLE`, `DESTINATION_UNKNOWN`.
4. The model MUST distinguish "bundle left my device" from "bundle reached the recipient".

## Article VII — DTN and Matrix Roles

1. **DTN** is the offline/edge fabric. It MUST function with no Internet and no Matrix.
2. **Matrix** is the global/federated fabric. It MUST remain an adapter/fabric implementation, not the core protocol.
3. The system MUST be able to function without Matrix.
4. The system MUST be able to function without Internet.

## Article VIII — Channel Adapters

1. Every external network (Email, SMS, WhatsApp, Matrix-as-channel, Telegram, Instagram, Messenger, RCS, …) is an adapter implementing `ChannelAdapter`.
2. The core protocol MUST NOT contain channel-specific branching (`if whatsapp`, `if telegram`).
3. Channel-specific semantics live inside their adapters.
4. If an adapter cannot cleanly map to the canonical protocol, STOP and surface the mismatch (ACP).

## Article IX — Security & Trust

1. Relays MUST be able to forward opaque encrypted bundles without learning their contents.
2. Transport authentication ≠ end-to-end confidentiality.
3. Never invent cryptography. Use established primitives and libraries.
4. Treat relays, gateways, channel adapters, and external channels as potentially malicious.

## Article X — No Fake Implementations

1. No `TODO`, no stub, no placeholder, no fake success, no hardcoded route, no pretend encryption, no pretend signature, no simulated gateway, no fake delivery — outside of explicitly-isolated test fixtures.
2. A feature is either: (a) implemented correctly, (b) marked experimental behind a boundary, or (c) unimplemented.

## Article XI — Hardening Mode

Hardening sprints allow bug fixes, validation, bounds checks, crypto corrections, replay protection, authorization/authentication fixes, resource exhaustion protection, fuzzing, concurrency fixes, persistence integrity, protocol conformance, malicious-input handling, DoS resistance.

Hardening sprints DO NOT authorize: protocol redesign, replacing Matrix, replacing DTN, changing identity/bundle/routing semantics, merging layers, replacing foundational abstractions. If a foundational problem is found: STOP → document → propose → await approval.

## Article XII — Authentication vs Authorization (S0.1)

Authentication answers "who are you?" Authorization answers "what are you allowed to operate on?"

1. Every externally callable operation that accepts a resource identifier (node_id, bundle_id, conversation_id, channel_id) MUST authorize that identifier against the authenticated principal.
2. A client-supplied resource identifier is NEVER proof of authority. The server MUST independently verify that the authenticated principal's organization owns or has access to the referenced resource.
3. Unauthenticated callers receive 401/UNAUTHORIZED for every operation — including read-only ones.
4. Authenticated callers without resource ownership receive 403/FORBIDDEN.
5. Authenticated callers with ownership (or admin role) are allowed.
6. Every authorized operation MUST be logged to an AuditEvent table with: actor identity, action, resource_id, timestamp, outcome (allowed/denied).
7. Raw internal exceptions MUST NOT be returned to clients. All error responses use a safe structured format.
8. Request origin MUST be validated at the web/API boundary to prevent cross-origin attacks.

## Article XIII — Separate Authorization Dimensions (S0.2)

A resource's existence, ownership, membership, visibility, and channel verification are separate authorization dimensions. Authentication of the caller does not establish any of them.

1. **Resource Visibility Classes**: Every resource is classified as one of:
   - `PUBLIC` — network topology, node capabilities (visible to any authenticated user)
   - `ORGANIZATION` — transcripts, identity graph, capability caches (visible to org members)
   - `USER` — inboxes, decryption results, conversation content (visible to the owning user)
   - `PLATFORM` — analytics, community stats, routing policy (visible to platform admins)
2. **Role Hierarchy** (distinct from system role):
   - `PLATFORM_ADMIN` — can access any resource across all organizations
   - `ORG_OWNER` — can manage org members + access all org resources
   - `ORG_ADMIN` — can manage org settings + access all org resources
   - `ORG_MEMBER` — can access org resources they're explicitly authorized for
   - `DEMO` — same as ORG_MEMBER but for demo accounts
3. **Channel Verification States**: Identity links have distinct states:
   - `ASSERTED` — an org admin claimed ownership, but the channel owner has not verified
   - `VERIFIED` — the channel owner completed a challenge-response proving possession
   - `REVOKED` — the link is no longer valid
4. **ASSERTED identities MUST NOT be used for production delivery.** Only `VERIFIED` links can be used to resolve recipient encryption pubkeys for dispatch.
5. **Denied operations MUST be audited.** The authorization boundary itself logs `AuditEvent(denied)` before returning FORBIDDEN. The audit system never depends on the protected operation running first.
6. **Security audit persistence is mandatory for denied operations.** If the audit write fails for a denied operation, the operation is still denied, but a secondary alert/queue MUST capture the event.

## Article XIV — Authorization State ≠ Resource State (S0.2.1)

An authorization state and a resource state must never be inferred from each other. A channel's ASSERTED/VERIFIED/REVOKED state is independent of the caller's organization authorization. Both checks are mandatory.

1. New IdentityGraph links default to `ASSERTED`. The server asserting "this channel belongs to this node" is NOT the same as the channel owner proving it.
2. `resolveChannelRecipient()` returns ONLY `VERIFIED` links. `ASSERTED` and `REVOKED` links are invisible to the dispatch path.
3. Verification state is persisted in the database (not in-memory). It survives restarts.
4. Challenge codes are cryptographically random (`crypto.getRandomValues`). Stored as SHA-256 hashes. Never returned to the browser after creation.
5. Challenge is delivered through the actual target channel (email link, SMS OTP, etc.). In the demo, it appears in the channel transcript.
6. State transitions: `ASSERTED → VERIFIED` (challenge verified), `ASSERTED → EXPIRED` (TTL elapsed), `VERIFIED → REVOKED` (explicit revocation).
7. Dispatch MUST reject `ASSERTED` and `REVOKED` channel identities. Only `VERIFIED` can resolve the recipient's encryption pubkey.
8. All communication resources (IdentityGraph, transcripts, capability caches, delivery state) are partitioned by organization. Cross-org access is FORBIDDEN.

## Article XV — IdentityLink State Machine is Canonical (S0.2.2)

The IdentityLink state machine defined in `src/core/identity/IdentityLinkStateMachine.ts` is the canonical source of truth for every link state transition. No code path — in-memory `IdentityGraph`, persisted `ChannelVerificationChallenge`, server action, or adapter — is permitted to write a `link_state` value without first consulting the canonical state machine.

1. **States** (matching Article XIV §6): `ASSERTED`, `VERIFIED`, `EXPIRED`, `REVOKED`.
2. **Legal transitions** (and ONLY these):
   - `ASSERTED → VERIFIED` (event `VERIFY`)
   - `ASSERTED → EXPIRED` (event `EXPIRE`)
   - `VERIFIED → REVOKED` (event `REVOKE`)
3. **All other transitions are forbidden** and MUST throw `LinkStateError`. Terminal states (`EXPIRED`, `REVOKED`) accept no events. `ASSERTED` accepts only `VERIFY` and `EXPIRE`. `VERIFIED` accepts only `REVOKE`. The `ASSERT` event exists only to set the initial state on a brand-new link; it is NOT a transition from an existing state.
4. **The canonical state machine is pure.** It performs no I/O, no DB writes, no in-memory mutation, no cryptographic verification. Its only job is: "given (current_state, event), is the transition legal? If yes, return the new state; if no, throw." Side-effects (DB writes, in-memory cache updates, audit events) are the caller's responsibility — but the caller MUST call `transition()` first.
5. **The in-memory IdentityGraph is a CACHE of the DB state** (per Article XIV §3 — "Verification state is persisted in the database, not in-memory"). The DB is canonical. Production code MUST update the DB first via `verifyChannelChallenge()` / `revokeChannelLink()`; only on DB success does the caller mirror the transition to the in-memory graph via `IdentityGraph.verifyChannel()` / `expireChannel()` / `revoke()`.
6. **The `revoke()` method on `IdentityGraph` MUST NOT delete the link.** A `REVOKED` link is retained for forensic audit trail. The link's `last_transition_at` and `last_event` fields are updated to record the transition.
7. **The `link()` method on `IdentityGraph` MUST produce a link in `ASSERTED` state**, not `VERIFIED`. A signed `CHANNEL_OWNERSHIP` proof attests an assertion (the identity claims ownership); it does NOT prove channel control. Advancing to `VERIFIED` requires the channel owner to complete an in-band challenge-response through the actual target channel.
8. **Demo / test bootstrap MAY use a fast-path** (`linkIdentityToChannelVerifiedForDemo()` on `CommOS`) that asserts AND verifies in a single call. The transition still goes through the canonical state machine (`ASSERT` then `VERIFY`). The fast-path MUST be clearly named and gated so production callers cannot accidentally use it.

## Article XVI — Repository Truth Gate (S0.2.3, S0.2.4)

An agent's report that a milestone is "complete" is not verifiable unless the implementation that produced the test results is identical to the implementation in the authoritative repository branch. Local-only implementation that passes tests is not "complete" — it is "unpushed work" and counts as a governance failure.

The gate has TWO modes, each with its own SHA-equality invariant:

### Mode 1: MAIN_MILESTONE

For declaring a milestone (S0.X, Pn) COMPLETE on the `main` branch.

Invariant: `local HEAD == origin/main HEAD == tested commit SHA`. All three must be equal.

Used on:
- Push events to `main` (CI runs the gate in MAIN_MILESTONE mode automatically).
- Manual invocation: `bash scripts/repo-truth-gate.sh MAIN_MILESTONE <milestone-id>` before declaring a milestone complete.

### Mode 2: PR_INTEGRITY

For verifying a pull request's integrity BEFORE merge.

Invariant: `tested SHA == checked-out HEAD (== github.sha in CI)`. Origin/main is NOT consulted — the PR's commit has by definition not yet been merged into main.

Used on:
- `pull_request` events targeting `main` (CI runs the gate in PR_INTEGRITY mode automatically).
- Manual invocation: `bash scripts/repo-truth-gate.sh PR_INTEGRITY <pr-id>` before requesting review on a PR.

### Common requirements (both modes)

1. **Working tree clean** — `git status --porcelain` returns empty. If dirty, the test results do not correspond to a specific commit — STOP and either commit or stash before re-running tests.
2. **Full test suite passes** at HEAD (`bun run vitest --run`).
3. **Architecture tests pass** at HEAD — FATAL (previously advisory in S0.2.3 with `|| true`; made FATAL in S0.2.4).
4. **Security tests pass** at HEAD (`tests/architecture/s0-security.test.ts`) — FATAL (split out as a dedicated subset in S0.2.4 so a security failure cannot be hidden inside an aggregate pass).
5. **Typecheck passes** at HEAD (`npx tsc --noEmit`) — FATAL (previously `continue-on-error: true` in the CI workflow; made FATAL in S0.2.4 so type drift cannot accumulate while tests pass).
6. **HEAD did not move during tests** — the SHA at end of the gate run must equal the SHA recorded before the run.

### MAIN_MILESTONE procedure

1. Run the full acceptance suite. Record pass count.
2. Record the tested commit SHA = `git rev-parse HEAD` of the working tree at test time.
3. Verify the worktree is clean.
4. Commit all changes if any uncommitted work exists. Commit messages must reference the milestone ID.
5. Push to GitHub (`git push origin main`). The push must succeed without rejection.
6. Fetch GitHub main HEAD (`git fetch origin` then `git rev-parse origin/main`).
7. Assert `local HEAD == origin/main HEAD == tested commit SHA`. All three must be equal. If any pair differs, the milestone is NOT complete.
8. Produce the COMMIT REPORT in the milestone completion message.

### PR_INTEGRITY procedure

1. Run the full acceptance suite. Record pass count.
2. Record the tested commit SHA = `git rev-parse HEAD` of the working tree at test time.
3. Verify the worktree is clean.
4. Assert `tested SHA == checked-out HEAD`. (In CI, github.sha == checked-out HEAD, so this is `tested SHA == github.sha`.)
5. Do NOT consult `origin/main`. The PR's commit is by definition not yet on main.
6. Produce the COMMIT REPORT in the PR description.

### COMMIT REPORT format (both modes)

```
MILESTONE:       <id>
MODE:            MAIN_MILESTONE | PR_INTEGRITY
LOCAL HEAD:      <sha>
GITHUB main:     <sha>   (only required for MAIN_MILESTONE; "(not consulted)" for PR_INTEGRITY)
TESTED SHA:      <sha>
MATCH:           YES | NO
MATCH INVARIANT: <human-readable invariant>
WORKTREE CLEAN:  YES | NO

TEST RESULT:     <N> passed / <N> failed
ARCHITECTURE:    <N> passed / <N> failed (FATAL)
SECURITY:        <N> passed / <N> failed (FATAL)
TYPECHECK:        PASS | FAIL (FATAL)

FILES ADDED:     <list>
FILES MODIFIED:  <list>
```

### Reviewer verification rights

**MAIN_MILESTONE mode** — the reviewer may run:
- `git ls-tree -r origin/main --name-only` to list every file at origin/main.
- `git show origin/main:<path>` to retrieve the exact bytes.
- `git rev-parse origin/main` to confirm the SHA reported here.

The agent MUST NOT claim a file is on main unless `git show origin/main:<path>` succeeds for that path.

**PR_INTEGRITY mode** — the reviewer may run:
- `git rev-parse HEAD` to confirm the checked-out SHA.
- `git show HEAD:<path>` to retrieve the exact bytes at the checked-out commit.
- Note: `origin/main` equality is NOT required and NOT checked.

### CI enforcement (when GitHub Actions is enabled)

A workflow on `push: branches: [main]` runs the gate in MAIN_MILESTONE mode. A workflow on `pull_request: branches: [main]` runs the gate in PR_INTEGRITY mode. Both workflows emit `BUILD_AT_SHA`, `TESTED_AT_SHA`, and `ARCHITECTURE_AT_SHA` as outputs, and fail the build if:
- `git status --porcelain` is non-empty (worktree dirty), OR
- The three SHAs do not all equal `github.sha`, OR
- The architecture subset fails, OR
- The security subset fails, OR
- The typecheck fails (no longer `continue-on-error: true`).

### Branch protection / required status checks (S0.2.4 §9)

GitHub branch protection rules and repository rulesets are NOT available on private repositories without GitHub Pro / Team / Enterprise. The `pectoraux/universal-comm-os` repository is currently private — the GitHub API returns `403` on `PUT /repos/{owner}/{repo}/branches/main/protection` and on `POST /repos/{owner}/{repo}/rulesets`.

Until either:
- (a) the repository is made public (branch protection is free for public repos), OR
- (b) the repository is upgraded to GitHub Pro / Team / Enterprise,

the branch protection layer CANNOT be machine-enforced via GitHub's native API. Two compensating controls are in place:

1. **Self-enforcement via the gate script** — every push to `main` triggers the MAIN_MILESTONE gate job in CI, which fails the build if `local HEAD != origin/main HEAD`. A failed build is a clear signal to the reviewer that the gate was not satisfied. The agent MUST NOT report "complete" without an Article XVI COMMIT REPORT whose SHAs match.

2. **Pre-push hook** (`scripts/install-pre-push-hook.sh`, installed locally on every developer machine) runs the PR_INTEGRITY gate before allowing a push. The hook can be bypassed with `git push --no-verify`, but doing so is recorded as an Article XVI violation.

The reviewer MAY at any time:
- `curl -sS https://api.github.com/repos/pectoraux/universal-comm-os/branches/main/protection` to verify whether branch protection is enabled. If the response is `404`, protection is OFF (the repo is still private without Pro). If `200`, protection is ON.
- Recommend making the repository public (which enables free branch protection) before the next hardening sprint.

### Mandatory rule

A milestone reported COMPLETE without satisfying Article XVI is automatically INVALID — the report counts as an architecture-control defect, not a milestone completion. The reviewer MUST NOT accept such a report.

### History

This article was added in S0.2.3 in response to the S0.2.2 governance failure: the agent reported "All 259 tests pass / S0.2.2 is complete" while the implementation existed only in the local working tree and had not been pushed to GitHub `main`. The reviewer's independent check of the authoritative branch proved the claimed `IdentityLinkStateMachine.ts` returned 404 and the claimed `VerificationState` vocabulary was still the old 3-state `UNVERIFIED | VERIFIED | REVOKED`. The fix is not merely pushing the work — it is preventing the asymmetry from recurring.

S0.2.4 extended the gate with two modes (MAIN_MILESTONE and PR_INTEGRITY), made architecture tests FATAL (was `|| true`), made security tests a FATAL dedicated subset, made typecheck FATAL (was `continue-on-error: true`), and added the branch-protection self-enforcement layer (the GitHub API returns 403 on the private repo without GitHub Pro — compensated by pre-push hooks + CI gating).

## Article XVII — Execution Evidence Integrity (S0.2.5)

A milestone completion claim requires not only repository truth (Article XVI) but execution evidence. A passing test result without a recorded command, environment, commit SHA, and timestamp is not considered validated.

Article XVI proved that the tested code is identical to the repository code. Article XVII proves that the test was actually run, in a real environment, with real commands, producing real results — and that the evidence artifact corresponding to that run is durable and independently verifiable.

### Required principle

For any milestone (S0.X, Pn) reported COMPLETE, the agent MUST produce a machine-generated execution evidence manifest that records:

1. **What commit was tested** — the exact `git rev-parse HEAD` at the time of execution.
2. **What environment tested it** — operating system, Node.js version, package manager, runtime.
3. **What commands were executed** — the exact commands (with arguments) and their exit codes.
4. **Whether they succeeded** — every required command must have exit code 0; any non-zero exit code invalidates the manifest.
5. **Whether the evidence corresponds to the repository state** — the manifest's `commit_sha` must equal `git rev-parse HEAD` AND `git rev-parse origin/main HEAD` (for MAIN_MILESTONE mode) at verification time.

### Evidence manifest format (ARCH-052)

The manifest is a JSON document stored at `docs/verification/latest-execution.json`. It MUST contain the following fields (in this exact order for readability — JSON object key order is preserved by the generator):

```json
{
  "milestone": "",
  "commit_sha": "",
  "repository": "",
  "branch": "",
  "timestamp": "",
  "environment": {
    "os": "",
    "node": "",
    "package_manager": "",
    "runtime": ""
  },
  "commands": [
    {
      "command": "",
      "exit_code": 0,
      "duration_ms": 0
    }
  ],
  "results": {
    "tests": "",
    "architecture": "",
    "security": "",
    "typecheck": ""
  }
}
```

Field semantics:
- `milestone`: the milestone ID (e.g., `"S0.2.5"`). MUST match the milestone ID in the gate script invocation.
- `commit_sha`: the full 40-character SHA-1 of `git rev-parse HEAD` at execution time.
- `repository`: the canonical repository URL with credentials stripped (e.g., `"https://github.com/pectoraux/universal-comm-os"`).
- `branch`: the current branch name (e.g., `"main"`).
- `timestamp`: ISO-8601 UTC with timezone offset (e.g., `"2026-08-20T18:00:00+00:00"`).
- `environment.os`: the OS identifier (e.g., `"Linux x86_64"`).
- `environment.node`: the Node.js version (e.g., `"v20.10.0"`).
- `environment.package_manager`: the package manager identifier (e.g., `"bun 1.1.x"`).
- `environment.runtime`: the runtime identifier (e.g., `"vitest 4.1.x"`).
- `commands[]`: the ordered list of commands executed. Each entry has `command` (the exact shell command), `exit_code` (integer; 0 = success), `duration_ms` (integer; wall-clock duration).
- `results.tests`: summary string (e.g., `"344 passed / 0 failed"`).
- `results.architecture`: summary string.
- `results.security`: summary string.
- `results.typecheck`: summary string (e.g., `"PASS"` or `"FAIL"`).

### Generation rules

The evidence generator (`scripts/generate-execution-evidence.sh`) MUST:

1. Run only AFTER the Repository Truth Gate has succeeded. The generator refuses to run if the gate has not been invoked or has failed.
2. Capture `commit_sha`, `branch`, `repository`, `timestamp`, and `environment` from the live system at the moment of generation.
3. Re-execute the required validation commands (test suite, architecture tests, security tests, typecheck) and record their actual exit codes and durations — NOT the codes from a prior gate run. This ensures the manifest reflects a real execution, not a stale state.
4. Write the manifest to `docs/verification/latest-execution.json` (overwriting the previous latest).
5. Copy the manifest to `docs/verification/history/<milestone>-<short-sha>-<timestamp>.json` for archival.
6. Exit 0 if all required commands succeeded; exit 1 otherwise (the manifest is still written — a failed manifest is also evidence — but the gate's COMMIT REPORT will note `EXECUTION EVIDENCE STATUS: INVALID`).
7. Refuse to generate a manifest if the worktree is dirty (the manifest's commit_sha must correspond to a real commit, not a working-tree snapshot).

### Verification rules

The evidence verifier (`scripts/verify-execution-evidence.sh`) MUST:

1. Check that `docs/verification/latest-execution.json` exists.
2. Parse it as JSON.
3. Verify all required fields are present and non-empty.
4. Verify `commit_sha` equals `git rev-parse HEAD` (the manifest corresponds to the current commit).
5. Verify `repository` matches the current `origin` URL (credentials stripped).
6. Verify every `commands[].exit_code` is 0 (no failed commands).
7. Verify `timestamp` parses as ISO-8601 and is within the last 30 days (stale manifests are invalid).
8. Verify `results.typecheck` is `"PASS"`.
9. Verify `results.tests`, `results.architecture`, `results.security` each contain `"passed"` with a non-zero count and `"0 failed"`.
10. Exit 0 if all checks pass; exit 1 otherwise (with a specific error message identifying the failed check).

### Invalidation conditions

A previously valid manifest becomes INVALID when any of the following occur:

1. `git rev-parse HEAD` no longer equals `manifest.commit_sha` (the repository advanced past the manifest's commit).
2. `git remote get-url origin` (credentials stripped) no longer equals `manifest.repository` (the remote changed).
3. More than 30 days have elapsed since `manifest.timestamp` (the evidence is stale).
4. Any required command's `exit_code` is non-zero (the manifest records a failure — even if the gate later passed, the manifest is evidence of the failure).
5. Any required field is missing or empty.
6. The manifest fails JSON parsing.
7. The manifest's `milestone` field does not match the milestone ID being claimed in the COMMIT REPORT.

An invalid manifest does NOT invalidate the milestone — the agent can regenerate the manifest by re-running the gate. But the agent MUST NOT report "milestone complete" while the manifest is invalid; the report must disclose `EXECUTION EVIDENCE STATUS: INVALID` and regenerate.

### CI enforcement

A new `execution-evidence` job in `.github/workflows/ci.yml` (S0.2.5) runs on `push: branches: [main]` and `pull_request: branches: [main]`. The job:

1. Depends on the `repo-truth-gate-main` (or `repo-truth-gate-pr`) job having succeeded.
2. Runs `scripts/generate-execution-evidence.sh` to produce `docs/verification/latest-execution.json`.
3. Runs `scripts/verify-execution-evidence.sh` to verify the manifest.
4. Uploads the manifest as a GitHub Actions artifact (`execution-evidence`) with a 30-day retention.
5. Fails the build if evidence generation or verification fails.

The job does NOT weaken existing gates — it runs AFTER them and adds a new required check.

### Commit report extension

The Article XVI COMMIT REPORT is extended with an `EXECUTION EVIDENCE` block:

```
EXECUTION EVIDENCE:
  PATH:   docs/verification/latest-execution.json
  SHA:    <the commit_sha in the manifest>
  STATUS: VALID | INVALID
```

A milestone reported COMPLETE without `EXECUTION EVIDENCE STATUS: VALID` is automatically INVALID per Article XVII.

### History

This article was added in S0.2.5 to close the last gap in the governance chain: Article XVI proved the tested code is identical to the repository code, but did not prove that the test was actually executed in a real environment with real commands. An agent could in principle report "tests passed at SHA X" without ever running them. The execution evidence manifest — generated by a script that re-runs the commands and records their actual exit codes — makes that gap impossible. The manifest is committed to the repository (in `docs/verification/latest-execution.json` and `docs/verification/history/`) so reviewers can independently inspect it.

## Article XVIII — Hardware Boundary Integrity (P4-DESIGN)

Hardware adapters (BLE, Wi-Fi Direct, NFC, USB, LoRa, Wi-Fi Aware, etc.) are pluggable transport implementations. They are NOT a new architectural layer — they implement the same `Transport` interface (Article I.2) as the existing `LoopbackTransport`. A hardware adapter CANNOT redefine any protocol semantic; it can only carry opaque Communication Bundle bytes between nodes.

This article is added in P4-DESIGN (preceding the P4 implementation sprint) to codify the boundary before any hardware adapter is written. Without Article XVIII, a hardware adapter could in principle:
- Reformat bundles to fit transport MTU (changes Article IV — Bundle is the fundamental routable object).
- Look up identities itself (changes Article II — IdentityGraph is the only identity source).
- Bypass verification (changes Article XIV — channel state is independent of caller authorization).
- Skip signatures (changes Article IX — established cryptography only).
- Mark its own delivery state (changes Article VI — delivery is an explicit state machine in `core/delivery/`).

Each of these is a violation of a higher-layer article. Article XVIII makes hardware adapters explicitly subject to ALL of them.

### §1. Hardware adapters implement the `Transport` interface

Every hardware adapter MUST implement the `Transport` interface defined in `src/core/transport/Transport.ts`:

```typescript
interface Transport {
  readonly transport_id: string;
  readonly transport_type: TransportCapabilityType;
  isAvailable(): boolean;
  send(bundle: CommunicationBundle, to_node_id: string): Promise<TransportSendResult>;
  onReceive(handler: (bundle: CommunicationBundle, from_node_id: string) => void): void;
  close?(): Promise<void>;
}
```

Where `TransportSendResult` is the canonical union:

```typescript
type TransportSendResult =
  | { kind: 'OK'; forwarded_at: number }
  | { kind: 'UNAVAILABLE'; reason: string }
  | { kind: 'NO_PEER'; reason: string }
  | { kind: 'ERROR'; reason: string };
```

Hardware adapters MUST NOT introduce new `TransportSendResult` kinds. The 4 kinds are canonical.

### §2. Hardware adapters MUST NOT throw across the interface boundary

`send()` returns `Promise<TransportSendResult>`. Internal exceptions (GATT errors, socket exceptions, permission failures) MUST be caught inside the adapter and translated to `{ kind: 'ERROR'; reason: string }`. An adapter that throws across the `Transport` interface boundary violates the contract — the caller cannot distinguish transport-failure from runtime-exception in a structured way.

### §3. Hardware adapters MUST NOT decrypt or interpret bundle contents

Per THREAT_MODEL §1, "channel adapters do not learn payload contents." The same rule applies to transport adapters. The bundle arrives as opaque bytes; the adapter's job is to deliver those bytes to the peer. The peer decrypts using its X25519 secret key (`core/trust/CryptoEnvelope.ts`).

A hardware adapter that decrypts bundle payloads (e.g., to "optimize" by re-compressing) violates Article IX (no invented cryptography) and THREAT_MODEL §1.

### §4. Hardware adapters MUST NOT touch frozen invariants

The frozen invariants (the things P4 MUST NOT change) are:

| Frozen Invariant | Source |
|---|---|
| Communication Bundle format | Article IV + `core/bundle/types.ts` |
| Universal Identity | Article II + `core/identity/UniversalIdentity.ts` |
| IdentityGraph | Article II + `core/identity/IdentityGraph.ts` |
| VerificationState machine | Article XIV + `core/identity/IdentityLinkStateMachine.ts` |
| Authorization model | Articles XII–XIV + `lib/authorization.ts` |
| Trust model | Article IX + `core/trust/*` |
| Delivery state machine | Article VI + `core/delivery/*` |
| Repository Truth Gate | Article XVI + `scripts/repo-truth-gate.sh` |
| Execution Evidence Gate | Article XVII + `scripts/generate-execution-evidence.sh` |

A hardware adapter that modifies any of these is an automatic architecture-control defect. The implementation MUST be reverted; the design that introduced the modification MUST be revised.

### §5. Hardware adapter implementations live in `src/transport/<name>/`

Per Article I.2, transport implementations live in `src/transport/*`. Hardware adapters are no exception. They MAY import from `@/core/*` (the Transport interface, the Bundle types, the encoding utilities) but MUST NOT import from `@/adapters/*`, `@/matrix/*`, `@/components/*`, `@/app/*`, `@/hooks/*`, `next`, `react`, `@prisma/client`. The architecture boundary tests (`tests/architecture/boundaries-strict.test.ts`) enforce this.

### §6. Hardware adapters MAY implement the duck-typed gossip side-channel

Per ARCH-031, transports MAY implement `gossip()` and `onGossip()` methods (not on the `Transport` interface — duck-typed). The NodeRuntime casts transports to access them. Hardware adapters (BLE, Wi-Fi Direct) MAY implement these methods; if they don't, gossip simply doesn't propagate over them.

This is the SAME pattern as `LoopbackTransport`. P4 does not change the pattern.

### §7. Hardware adapters MAY report resources via the existing `NodeCapabilities.resource` field

Per ARCH-035, the routing layer reads `battery_pct`, `bandwidth_bps`, `storage_bytes`, `compute_units` from `NodeCapabilities.resource` (defined in `core/capabilities/types.ts`). Hardware adapters MAY sample these from the platform (e.g., Android `BatteryManager`) and update the node's `CapabilityAdvertisement`. The gossiped advertisement carries these to peers; the routing layer uses them.

P4 does NOT introduce a new resource-reporting interface. It populates the existing one.

### §8. Hardware adapter pairing / link-layer encryption is INDEPENDENT of bundle end-to-end encryption

The bundle is already end-to-end encrypted via `CryptoEnvelope` (Article IX — established cryptography). Hardware adapters MAY add link-layer encryption (BLE LE Secure Connections, Wi-Fi Direct WPS) for the LINK — but this is INDEPENDENT of the bundle's end-to-end encryption. A compromised link does NOT compromise bundle payloads.

Hardware adapters MUST NOT introduce new cryptographic primitives, new signature algorithms, new key types, or new hash functions (Article IX). All crypto goes through `core/trust/CryptoEnvelope` and `core/trust/Proof`.

### §9. (S0.2.6 — strengthened) Two-layer encryption is a structural property, not a feature

The protocol has TWO cryptographically independent encryption layers (see P4 design §7.2):

- **Layer 1 — Bundle end-to-end encryption** (frozen, Article IX + ARCH-014): X25519 sealed-box, recipient's pubkey, sealed at dispatch, opened only by recipient's X25519 secret key.
- **Layer 2 — Transport session encryption** (P4, link-layer): BLE LE Secure Connections (ECDH + AES-CCM), Wi-Fi Direct WPA2-Personal (AES-CCMP). Per-session, torn down on `close()` / peer disconnect.

A relay MUST be able to forward an opaque bundle without possessing the bundle decryption key. Removing this separation would require redefining the bundle format (Article IV — frozen), sharing the recipient's X25519 secret key with relays (THREAT_MODEL §1 — frozen), and inventing new crypto (Article IX — frozen). The two-layer separation is non-negotiable.

### §10. (S0.2.6 — strengthened) Transport framing is ephemeral, NOT bundle semantics

Hardware adapters MAY add transport framing fields (BLE chunk sequence + flag, Wi-Fi Direct length prefix) to chunk / reassemble bundles across the physical layer. The framing fields exist ONLY in transit. They are:

- NOT serialized into the `CommunicationBundle` (Article IV — frozen).
- NOT persisted in the `BundleStore` (Article VI — frozen).
- NOT visible to the recipient's `parseBundle()`.
- NOT carrying protocol meaning (no delivery state, no authorization, no trust).

A hardware adapter that uses framing fields to encode protocol semantics violates Article IV + Article XVIII §3 (transports do not interpret bundle contents).

### §11. (S0.2.6 — strengthened) Gossip side-channel is constrained to transport/network observations

Per §6 above, hardware adapters MAY implement the duck-typed `gossip()` / `onGossip()` side-channel. The gossip payloads MUST be limited to transport/network observations:

- ✅ Acceptable: `PEER_SEEN`, `PEER_REACHABLE`, `RESOURCE_REPORT`, `CAPABILITY_ADVERTISEMENT`, `FORWARDING_OPPORTUNITY`.
- ❌ Forbidden: `IDENTITY_ASSERTION`, `TRUST_ASSERTION`, `DELIVERY_STATE`, `AUTHZ_GRANT`, `BUNDLE_VARIANT`, `VERIFICATION_ASSERTION`.

A hardware adapter that introduces a forbidden gossip payload kind is an automatic architecture-control defect (§13 below). The architecture boundary tests will be extended in P4.7 with a static AST scan enforcing this.

### §12. (S0.2.6 — strengthened) RELAY_FORWARD proof authority is forwarding evidence ONLY

A `RELAY_FORWARD` proof (ARCH-023) signed by a relay's Ed25519 key proves EXACTLY:

- The relay observed bundle `bundle_id` arriving from `from_node_id` on `transport` at time `ts`.
- The relay attempted to forward it to `to_node_id`.
- The relay's identity (the signing pubkey).

The `RELAY_FORWARD` proof does NOT prove:

- Sender authority (that is `SENDER_SIGNATURE` — separate proof, separate key).
- Recipient verification (that is the `IdentityGraph` + `VerificationState` machine — Articles II, XIV, XV).
- Trust endorsement (that is the `verification` ladder — `UNVERIFIED` / `PEER_CORROBORATED` / `TRUSTED`).
- Authorization grant (that is `authorizeNode` / `authorizeByVisibility` — Articles XII–XIV).
- Bundle content endorsement (the relay cannot decrypt — THREAT_MODEL §1).

The `RELAY_FORWARD` proof is at the BOTTOM of the authority hierarchy:

```
Intent (Article III) → Identity (Article II) → Bundle (Article IV) → Routing (Article V) → Transport (Article I.2) → RELAY_FORWARD proof
```

A hardware adapter that signs `RELAY_FORWARD` proofs asserting higher-layer authority is an automatic architecture-control defect.

### §13. (S0.2.6 — strengthened) StoredBundle contract is ONE protocol contract, many persistence impls

The `BundleStore` interface (defined in `src/server/NodeRuntime.ts`) is the protocol-level contract. Persistence implementations (Prisma/PostgreSQL for web build, Room/SQLite for Android, in-memory for tests) MUST satisfy these cross-impl invariants:

- **P1**: `(bundle_id, node_id)` is the unique key (UPSERT semantics).
- **P2**: `ReceivedBundle` is keyed by `(node_id, bundle_id)`; deduplication is based on `bundle_id` ONLY.
- **P3**: TTL sweeper transitions `QUEUED` → `EXPIRED` idempotently via `DeliveryTracker.transition()`.
- **P4**: Every state change goes through `DeliveryTracker.transition()`; persistence impls MUST NOT write to `state` directly.
- **P5**: When a relay forwards, only `proofs[]` is appended; no other bundle field changes.
- **P6**: Crash mid-write leaves the DB consistent (transactions / WAL).
- **P7**: Schema migrations are forward-only, recorded in `schema_migrations`.

A persistence impl that violates any P-invariant is an automatic architecture-control defect. The Android `AndroidBundleStore` MUST satisfy P1-P7 — it is NOT a "mirror" of the Postgres schema, it is a separate impl of the same contract.

### §14. Violations are architecture-control defects

Any violation of Article XVIII is automatically an architecture-control defect per Article X. The implementation MUST be reverted, the design MUST be revised, and the violation MUST be recorded in the worklog with a root-cause analysis before resuming.

Specifically:
- A hardware adapter that throws across the `Transport` boundary → revert, add internal try/catch.
- A hardware adapter that introduces a 5th `TransportSendResult` kind → revert, use one of the 4 canonical kinds.
- A hardware adapter that decrypts bundle payloads → revert, treat bundles as opaque bytes.
- A hardware adapter that imports from `@/adapters/*` or `@/matrix/*` → revert, restructure.
- A hardware adapter that modifies any frozen invariant in §4 → revert, file an Architecture Change Proposal per `CHANGE_CONTROL.md`.
- A hardware adapter that introduces forbidden gossip payload kinds (§11) → revert, restructure gossip to use acceptable kinds.
- A hardware adapter that uses transport framing to encode protocol semantics (§10) → revert, framing is ephemeral.
- A hardware adapter that signs RELAY_FORWARD proofs asserting higher-layer authority (§12) → revert, RELAY_FORWARD proves forwarding evidence only.
- A persistence impl that violates any P-invariant (§13) → revert, fix the impl to satisfy the protocol contract.

### §15. History

This article is added in P4-DESIGN (commit `7e64db3`), preceding the P4 implementation sprint. S0.2.6 (commit pending) strengthens it with §9-§13 in response to the architecture reviewer's 8-point review of the original P4-DESIGN:

- §9 (two-layer encryption) addresses reviewer point 4.
- §10 (transport framing) addresses reviewer point 3.
- §11 (gossip boundary) addresses reviewer point 6.
- §12 (RELAY_FORWARD authority) addresses reviewer point 5.
- §13 (StoredBundle contract) addresses reviewer point 7.

The motivation: hardware adapters are the first transport-layer code that interacts with platform-specific APIs (BluetoothLeScanner, WifiP2pManager, etc.). Without an explicit hardware-boundary article, an adapter could in principle "optimize" by reformatting bundles, looking up identities, signing on behalf of the sender, etc. — each of which would silently violate a higher-layer article. Article XVIII makes the boundary explicit and the violations detectable by static analysis (architecture boundary tests).

The article was authored before any hardware adapter code was written. P4.1 (BLE adapter) is the first implementation milestone governed by this article.
