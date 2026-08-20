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

## Article XVI — Repository Truth Gate (S0.2.3)

An agent's report that a milestone is "complete" is not verifiable unless the implementation that produced the test results is identical to the implementation in the authoritative repository branch. Local-only implementation that passes tests is not "complete" — it is "unpushed work" and counts as a governance failure.

Before declaring ANY milestone (S0.X, Pn) COMPLETE, the agent MUST execute the Repository Truth Gate in this exact order:

1. **Run the full acceptance suite** (`bun run vitest --run`). Record pass count.
2. **Record the tested commit SHA** = `git rev-parse HEAD` of the working tree at test time.
3. **Verify the worktree is clean** = `git status --porcelain` returns empty. If dirty, the test results do not correspond to a specific commit — STOP and either commit or stash before re-running tests.
4. **Commit all changes** if any uncommitted work exists. Commit messages must reference the milestone ID (e.g., `S0.2.2 — canonical state machine`).
5. **Push to GitHub** = `git push origin main` (or the milestone's target branch). The push must succeed without rejection.
6. **Fetch GitHub main HEAD** = `git fetch origin` then `git rev-parse origin/main`.
7. **Assert** `local HEAD == origin/main HEAD == tested commit SHA`. All three must be equal. If any pair differs, the milestone is NOT complete.
8. **Produce the COMMIT REPORT** in the milestone completion message:

```
MILESTONE: <id>
LOCAL HEAD:     <sha>
GITHUB main:    <sha>
TESTED SHA:     <sha>
MATCH:          YES | NO
WORKTREE CLEAN: YES | NO
TEST RESULT:    <N> passed / <N> failed
ARCHITECTURE:   <N> passed / <N> failed
BUILD/CHECK:    PASS | FAIL
FILES ADDED:    <list>
FILES MODIFIED: <list>
```

9. **Independent verification**: the human reviewer may run `git ls-tree -r origin/main --name-only` and `git show origin/main:<path>` to confirm each claimed file is actually present at the claimed SHA on GitHub. The agent MUST NOT claim a file is on main unless `git show origin/main:<path>` succeeds for that path.

10. **CI enforcement (when GitHub Actions is enabled)**: a workflow on `push` and `pull_request` MUST emit `BUILD_AT_SHA`, `TESTED_AT_SHA`, and `ARCHITECTURE_AT_SHA` as outputs, and fail the build if `git status --porcelain` is non-empty or if the three SHAs do not all equal `github.sha`. This makes the gate machine-enforced, not agent-reported.

A milestone reported COMPLETE without satisfying Article XVI is automatically INVALID — the report counts as an architecture-control defect, not a milestone completion. The reviewer MUST NOT accept such a report.

This article was added in response to the S0.2.2 governance failure: the agent reported "All 259 tests pass / S0.2.2 is complete" while the implementation existed only in the local working tree and had not been pushed to GitHub `main`. The reviewer's independent check of the authoritative branch proved the claimed `IdentityLinkStateMachine.ts` returned 404 and the claimed `VerificationState` vocabulary was still the old 3-state `UNVERIFIED | VERIFIED | REVOKED`. The fix is not merely pushing the work — it is preventing the asymmetry from recurring.
