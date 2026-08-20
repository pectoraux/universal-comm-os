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
