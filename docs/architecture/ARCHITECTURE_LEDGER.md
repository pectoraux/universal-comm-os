# ARCHITECTURE LEDGER — Universal Communication OS

Numbered architectural decisions. Append-only. Each entry: ID, decision, rationale, status, supersedes/superseded-by.

| ID      | Decision                                                              | Status  |
|---------|-----------------------------------------------------------------------|---------|
| ARCH-001 | Universal Identity is transport-independent.                       | ACTIVE  |
| ARCH-002 | Intent is transport-independent.                                   | ACTIVE  |
| ARCH-003 | Bundle is the fundamental routable object.                         | ACTIVE  |
| ARCH-004 | Matrix is the global communications fabric.                       | ACTIVE  |
| ARCH-005 | DTN is the offline/edge fabric.                                   | ACTIVE  |
| ARCH-006 | Matrix is NOT the offline routing layer.                          | ACTIVE  |
| ARCH-007 | External networks are adapters.                                   | ACTIVE  |
| ARCH-008 | Routing operates over capabilities and policy.                    | ACTIVE  |
| ARCH-009 | Applications MUST NOT directly depend on channel APIs.            | ACTIVE  |
| ARCH-010 | Mobile clients consume canonical protocol semantics.              | ACTIVE  |
| ARCH-011 | Repository layer boundaries enforced by architecture tests.       | ACTIVE  |
| ARCH-012 | Delivery is an explicit multi-state machine; `sent=true` forbidden | ACTIVE  |
| ARCH-013 | TypeScript monorepo layout: core / transport / matrix / adapters / gateway / server / web (Next.js). | ACTIVE  |
| ARCH-014 | Cryptography uses established libraries (libsodium via `@noble/*` or `tweetnacl`); no invented primitives. | ACTIVE  |
| ARCH-015 | Loopback transport is the first transport (P2) to prove Bundle → transport → destination without Internet. | ACTIVE  |
| ARCH-016 | Architecture tests run in CI via vitest with `@/` import boundary enforcement. | ACTIVE  |
| ARCH-017 | UI is a consumer of the Communication OS API. UI MUST NOT contain channel-specific branching. | ACTIVE  |
| ARCH-018 | Capability advertisement is explicit; a node is NOT a gateway merely because it has Internet. | ACTIVE  |
| ARCH-019 | Self-reported contribution is never trusted. Contribution accounting requires verifiable evidence (deferred to P13). | ACTIVE  |
| ARCH-020 | No premature complexity: no token economy, no advanced AI routing, no speculative blockchain, no unnecessary microservices before foundational protocol semantics are correct. | ACTIVE  |
| ARCH-021 | BundleStore is an interface; both in-memory (tests) and Prisma-backed (production) implementations conform. Switching is a deployment choice, not an architecture change. | ACTIVE  |
| ARCH-022 | Per-node delivery state machine lives in-memory (live source of truth) AND is mirrored to the DB for forensics/restart. The in-memory tracker is authoritative for ARCH-012 conformance. | ACTIVE  |
| ARCH-023 | RELAY_FORWARD proofs are signed by relays using their Ed25519 signing key and appended to the bundle's `proofs[]`. The recipient verifies the entire chain. Relays do NOT need the sender's signing key. | ACTIVE  |
| ARCH-024 | Replication fan-out sends the same bundle_id to N independent peers in parallel. Deduplication at the recipient (canonical bundle_id) makes the first-arrival-wins semantics automatic. | ACTIVE  |
| ARCH-025 | ChannelAdapter interface takes opaque bundle bytes only (THREAT_MODEL §1: channel adapters do NOT learn payload contents). Corrected from the previous interface that took plaintext. | ACTIVE  |
| ARCH-026 | Gateway runtime lives in `src/gateway/` and is owned by NodeRuntime as an optional dep. When `recipient.kind === 'CHANNEL'` AND the node advertises the matching GATEWAY capability, the bundle is delegated to the gateway runtime. | ACTIVE  |
| ARCH-027 | Epidemic-routing fallback: relays replicate CHANNEL-recipient bundles to all non-sender peers when capability gossip (P5) is unavailable. Bundle_id dedup ensures correctness; one copy reaches the gateway. This is a legitimate DTN pattern, not a workaround. | ACTIVE  |
| ARCH-028 | EmailAdapter is EXPERIMENTAL — in-process transcript only, not real SMTP. Clearly marked per Article X (no fake implementations: option 2 — experimental behind a boundary). The ChannelAdapter interface is the production boundary. | ACTIVE  |
| ARCH-029 | CapabilityCache is an interface in core; in-memory impl for tests, Prisma-backed for production (future). Each node has its own cache populated by gossiped CapabilityAdvertisement objects. | ACTIVE  |
| ARCH-030 | Router plans multi-hop routes proactively via BFS over the gossiped `known_network` (deep cache). When the cache is healthy, the router picks a specific first-hop peer instead of replicating to all peers. | ACTIVE  |
| ARCH-031 | Capability gossip uses a duck-typed side-channel on transports (`gossip()` / `onGossip()` methods on LoopbackTransport). The Transport interface in core is UNCHANGED — no architecture change. Real edge transports (P4: Android BLE/Wi-Fi) MAY implement the same methods; if they don't, gossip simply doesn't propagate over them. | ACTIVE  |
| ARCH-032 | IdentityGraph is an interface in core. In-memory impl for tests; Prisma-backed for production (future). Each node has its own graph (per-node view, like CapabilityCache). In production, identity links are propagated via a separate identity-gossip protocol OR a federated identity directory. | ACTIVE  |
| ARCH-033 | The CHANNEL_OWNERSHIP verification proof format is a signed Ed25519 signature over the canonical string `CHANNEL_OWNERSHIP|identity_id|channel|channel_id|ts`. The verifier checks the signature against the identity's signing pubkey AND that the proof's identity_id matches the identity being linked. | ACTIVE  |
| ARCH-034 | Contact resolution is `resolveChannelRecipient(channel, channel_id) → { identity_ref, encryption_pubkey, proof } | undefined`. Returns undefined if no VERIFIED link exists. The caller MUST NOT encrypt to an unverified recipient (THREAT_MODEL §16: identity impersonation). | ACTIVE  |
| ARCH-035 | Resource-aware routing (P9): `computeHopMetrics()` derives reliability/latency/cost/privacy/delivery_probability from the peer's resource report (battery, bandwidth, storage, compute) + verification state + intent constraints. Static est_* values from P3-P8 are replaced by these computed values. | ACTIVE  |
| ARCH-036 | Delivery probability estimation (P9): `delivery_probability = reliability × resource_availability_factor`. The resource availability factor captures whether the peer has the resources to actually deliver (low battery, low storage reduce it). Distinct from reliability (which is the per-hop probability of successful forwarding). | ACTIVE  |
| ARCH-037 | Peer-caps-from-cache fix (P9): the `peerCaps` array for immediate peers now looks up each peer's ACTUAL capabilities from the capability cache (was using the local node's caps for all peers — a P3-P8 bug). When the cache doesn't have an entry (cold start), falls back to a minimal PeerCapabilities with the local node's transport types. | ACTIVE  |
| ARCH-038 | Recipient inbox (P11): when a bundle reaches DELIVERED at a node, CommOS auto-decrypts it using the node's X25519 secret key and stores it in a per-node inbox. The inbox is the user-facing view of received messages — the consumer application's unified inbox. | ACTIVE  |
| ARCH-039 | Auto-decrypt on delivery (P11): the `onDelivered` callback in NodeRuntimeDeps fires when a bundle transitions to DELIVERED. CommOS registers this callback for each node; it decrypts the bundle (if the node is the recipient identity) and adds the plaintext to the inbox. No manual "Try Decrypt" needed — the inbox is always populated. | ACTIVE  |
| ARCH-040 | Conversation grouping (P11): the inbox groups messages by `conversation_id`. Each conversation shows: message count, unread count, last message preview. Expanding a conversation shows the full thread (sender, timestamp, delivery state, plaintext). Marking a conversation as read transitions all its bundles to READ in the delivery state machine. | ACTIVE  |
| ARCH-041 | Analytics (P12): delivery statistics are computed from the delivery tracker + dispatched bundles. Per THREAT_MODEL §11: observability MUST NOT expose private message contents — only aggregate counts (dispatched, delivered, expired, no_route, relayed, queued, delivery_rate, per-node breakdown, hop distribution). | ACTIVE  |
| ARCH-042 | Routing policy management (P12): the active routing policy is editable at runtime via `setPolicy()` on NodeRuntime + `updateRoutingPolicy()` on CommOS. Changes affect subsequent dispatches only — existing bundles keep their original routing_policy inline (immutable per ARCH-003). | ACTIVE  |
| ARCH-043 | AI assistive layer (P14): AI (z-ai-web-dev-sdk) operates ABOVE the deterministic communication protocol. It assists with intent interpretation, routing recommendations, and conversation summarization. The AI SUGGESTS; the user CONFIRMS. The AI never signs bundles, verifies identities, makes routing decisions, or governs delivery truth. | ACTIVE  |
| ARCH-044 | AI must not govern security invariants (P14): per the master prompt, AI MUST NOT become authority for cryptography, identity verification, authorization, protocol semantics, delivery truth, or security invariants. The AI's output is advisory only — the deterministic protocol governs. The z-ai-web-dev-sdk is used in backend code only (server actions). | ACTIVE  |
| ARCH-045 | Multi-channel adapter pattern (P8): the gateway runtime registers multiple ChannelAdapters (Email, SMS, WhatsApp). Each adapter packages opaque bundle bytes into its channel-native format. The same ChannelAdapter interface + GatewayRuntime work for all channels — adding a new adapter is a pure addition (no core protocol changes). | ACTIVE  |

---

## Detailed Entries

### ARCH-001 — Universal Identity is transport-independent
- **Rationale**: A person is not a phone number, email, Matrix ID, or WhatsApp ID. Those are channel identities attached to a universal identity. Coupling identity to a channel forces the entire stack to depend on that channel's lifecycle.
- **Implications**: `UniversalIdentity` is the primary principal type. `ChannelIdentity` is a sub-type bound to a `UniversalIdentity` through an explicit, verified linking protocol.

### ARCH-002 — Intent is transport-independent
- **Rationale**: The application should express *what* it wants, not *how* to deliver it. Channel selection is a routing concern, not an application concern.
- **Implications**: `Intent` carries delivery/payload/privacy constraints. Routing consumes these constraints to pick transports. The application never imports an adapter.

### ARCH-003 — Bundle is the fundamental routable object
- **Rationale**: A bundle is a self-contained, persistable, forwardable, encrypted unit. It survives intermittent connectivity, multi-hop relays, and partitioned operation.
- **Implications**: All transports operate on bundles. All delivery state is tracked against bundles. All routing decisions consume bundles.

### ARCH-004 / ARCH-005 / ARCH-006 — Matrix and DTN roles
- **Rationale**: Matrix provides federated, persistent, Internet-based communication. DTN provides store-carry-forward over local/constrained transports. Each fabric has different operational assumptions; conflating them collapses the architecture.
- **Implications**: `core/*` defines a `Fabric` interface. `matrix/*` and `transport/dtn/*` are independent implementations.

### ARCH-007 / ARCH-008 — Adapters and capability routing
- **Rationale**: Hard-coding `if whatsapp` in core prevents the architecture from adapting to new channels or removing failing ones. Routing by device type (`if android`) prevents the architecture from adapting to new platforms.
- **Implications**: Adapters implement `ChannelAdapter`. Routing consumes `NodeCapabilities`.

### ARCH-011 — Architecture tests in CI
- **Rationale**: Documents drift. The only way to enforce boundaries is to make CI fail when they are violated.
- **Implications**: `tests/architecture/*.test.ts` asserts forbidden-import rules using AST scanning and dependency assertions.

### ARCH-013 — TypeScript monorepo layout
- **Rationale**: The master prompt prescribes a conceptual repository structure. We adapt it to a single Next.js + TypeScript app while preserving conceptual boundaries through directory + import rules.
- **Implications**:
  ```
  src/
    core/          -- protocol primitives (NO imports from outer layers)
    transport/     -- Transport implementations (loopback, lan, internet, dtn)
    matrix/        -- Matrix fabric (adapter, NOT core dependency)
    adapters/      -- Channel adapters (whatsapp, sms, email, rcs, telegram, ...)
    gateway/       -- Gateway runtime (DTN -> Internet, etc.)
    server/        -- Communication OS API surface (Next.js server actions / routes)
    app/           -- Web client (Next.js App Router, the only user-visible route)
    components/    -- shadcn/ui components (UI primitives only)
    lib/           -- shared utilities
  tests/
    architecture/  -- boundary enforcement tests
    unit/          -- per-subsystem unit tests
    protocol/      -- protocol conformance tests
  docs/architecture/  -- constitutional documents
  ```

### ARCH-014 — Established cryptography only
- **Rationale**: "Never invent cryptography." Use audited primitives.
- **Implications**: We use `tweetnacl` (NaCl-box for end-to-end sealed bundles, ed25519 for signatures, XSalsa20-Poly1305 / XChaCha20-Poly1305 for symmetric envelopes). All cryptographic operations are isolated behind a `core/trust` boundary so that algorithms can be swapped via ACP if needed.

### ARCH-015 — Loopback transport first
- **Rationale**: The P2 milestone requires proving Bundle → transport → destination. A loopback transport running entirely in-process lets us prove the protocol without depending on physical radios or sockets.
- **Implications**: `src/transport/loopback/LoopbackTransport.ts` ships before any other transport.

### ARCH-016 — Architecture tests run via vitest
- **Rationale**: vitest is already part of the Next.js TypeScript toolchain; using it for boundary tests keeps the test runner unified.
- **Implications**: `bun run test:arch` executes `tests/architecture/*.test.ts`.

### ARCH-020 — No premature complexity
- **Rationale**: Premature token economics, AI routing, dozens of adapters, and speculative distributed databases corrupt the foundational protocol before it is correct.
- **Implications**: Out-of-scope items remain unimplemented (not faked) until their roadmap phase.

### ARCH-021 — BundleStore is an interface (P3.1)
- **Rationale**: Tests need an in-memory store (no I/O, fast); production needs persistence (Prisma-backed). Both must conform to the same protocol so that the NodeRuntime is unaware of the storage choice.
- **Implications**: `BundleStore` interface lives in `server/NodeRuntime.ts`. `createInMemoryBundleStore()` for tests; `createPrismaBundleStore()` for production. Switch is per-node at construction time.

### ARCH-022 — Per-node delivery tracker dual-locates (P3.2)
- **Rationale**: The in-memory tracker is the LIVE source of truth for ARCH-012 (state machine legality, transitions, errors). The DB mirror survives restarts and supports forensic queries (TTL sweeper writes EXPIRED transitions, ops can replay history).
- **Implications**: `createDeliveryTracker()` (in-memory) is the canonical tracker per NodeRuntime. The TTL sweeper writes EXPIRED transitions to BOTH the DB (`StoredBundle.state` + `DeliveryEvent`) AND the in-memory tracker of the relevant node (via the runtime's `delivery.transition()`).

### ARCH-023 — RELAY_FORWARD proofs (P3.6)
- **Rationale**: Recipients must be able to verify which relays touched a bundle. Relays sign over (bundle_id, relay_node_id, from_node_id, to_node_id, transport, ts) using their own Ed25519 key. The sender's signing key is never shared with relays.
- **Implications**: `NodeRuntime` accepts an optional `signing_secret_key` in its deps. A relay without a signing key skips the proof-append step (the bundle still forwards, but without the proof — observability loss, not a security loss).

### ARCH-024 — Replication fan-out semantics (P3.4)
- **Rationale**: In a DTN, the same bundle may be carried by N independent relays simultaneously. Whichever path arrives first wins; the recipient's dedup logic (canonical bundle_id) makes the second arrival a no-op.
- **Implications**: `dispatch({replicate: true})` sends the same bundle_id to up to `policy.replication_factor` peers in parallel. The router's `pickReplicas()` returns the primary hop + other reachable peers, capped at the factor. Cost vs. reliability trade-off is policy, not architecture.

### ARCH-025 — ChannelAdapter takes opaque bytes only (P6)
- **Rationale**: THREAT_MODEL §1 states "channel adapters do not learn payload contents." The previous interface took `plaintext: Uint8Array` — a contradiction. The interface now takes only the opaque bundle (ciphertext + envelope metadata). The adapter packages opaque bytes into the channel-native format (email body, SMS payload, etc.) and the recipient decrypts on the other side.
- **Implications**: This is a protocol-level correction, not an architecture change. THREAT_MODEL was already authoritative; the interface was speculative and is now aligned.

### ARCH-026 — Gateway runtime ownership (P6)
- **Rationale**: The gateway runtime is the bridge between DTN bundles and external ChannelAdapters. It must live in its own layer (`src/gateway/`) and be owned by NodeRuntime as an optional dep — when absent, CHANNEL-recipient bundles fall through to DTN forwarding (P3 behavior). When present AND the node advertises the matching GATEWAY capability, the runtime delegates to the adapter.
- **Implications**: `NodeRuntimeDeps.gatewayRuntime?: GatewayRuntime`. The check `isChannelGateway = recipient.kind === 'CHANNEL' && deps.gatewayRuntime && deps.capabilities.gateway.has(recipient.channel)` enforces ARCH-018 ("a node is NOT a gateway merely because it has Internet").

### ARCH-027 — Epidemic-routing fallback (P6)
- **Rationale**: Without capability gossip (P5 territory), a relay cannot know which peer is the gateway for a given channel. The router's opportunistic branch picks ONE peer, which may be the wrong one (e.g., the original sender). To make P6 provable today, relays replicate CHANNEL-recipient bundles to ALL non-sender peers simultaneously. Bundle_id dedup at each peer ensures correctness; the gateway handles it, others silently drop.
- **Implications**: This is a legitimate DTN "epidemic routing" pattern (RFC 7567-style). When P5 capability gossip is implemented, the router will pick a specific peer and replication becomes unnecessary (a routing optimization, not a correctness change).

### ARCH-028 — EmailAdapter is EXPERIMENTAL (P6)
- **Rationale**: Article X forbids fake implementations. A real EmailAdapter requires SMTP credentials, an email server, and the recipient's email client to decrypt — none of which exist in a sandbox. The EmailAdapter is therefore clearly marked EXPERIMENTAL — in-process transcript only. The ChannelAdapter interface is the production boundary; a real SMTP adapter can be dropped in without touching the core protocol.
- **Implications**: `EmailAdapter.display_name = 'Email Adapter (EXPERIMENTAL — in-process transcript)'`. The transcript is observable in the UI as a list of "sent" emails with their opaque ciphertext bodies. Production deployment would swap in a real SMTP adapter implementing the same interface.

### ARCH-029 — CapabilityCache interface (P5)
- **Rationale**: Each node needs a deep view of the network (not just immediate peers) to plan multi-hop routes proactively. The cache stores `CapabilityAdvertisement` objects keyed by `origin_node_id`, with TTL-based expiry. In-memory impl for tests; Prisma-backed for production (future) — same interface, deployment choice.
- **Implications**: `createCapabilityCache()` returns a `CapabilityCache` with `upsert`/`get`/`snapshot`/`prune`/`clear`/`size`. Advertisements carry a `ts` field set to `Date.now()` at each gossip round so TTL refreshes on every round; stale entries (older than TTL) are silently dropped by `get`/`snapshot`.

### ARCH-030 — Multi-hop BFS route planning (P5)
- **Rationale**: Without a deep network view, the router can only plan single-hop routes; multi-hop delivery relies on each relay re-routing on receipt (reactive, P3.5) or epidemic replication (ARCH-027, wasteful). With the gossiped `known_network`, the router can plan the full path proactively.
- **Implications**: `RoutingContext.known_network?: Map<node_id, PeerCapabilities>`. The router's `planMultiHopViaKnownNetwork` runs BFS from each immediate peer, looking for a target node (the destNodeId, OR any node with the matching GATEWAY capability for destChannel). The first hop MUST be an immediate peer (verified via `ctx.known_peers`); subsequent hops are RELAY hops. Reliability degrades per hop. The opportunistic branch (branch 5) only fires when NO multi-hop plan was found.

### ARCH-031 — Capability gossip side-channel (P5)
- **Rationale**: Capability gossip needs to propagate over transports, but extending the `Transport` interface in `core/transport/Transport.ts` would be an architecture change (ACP). Instead, `LoopbackTransport` adds duck-typed `gossip()` and `onGossip()` methods. The NodeRuntime casts transports to access them — same pattern as `listReachablePeers` casts to access `peers`. Real edge transports (P4: Android BLE/Wi-Fi) MAY implement the same methods; if they don't, gossip simply doesn't propagate over them.
- **Implications**: No ACP needed. The Transport interface stays at 4 methods (`isAvailable`/`send`/`onReceive`/`close?`). Gossip is "best effort" — nodes without gossip-capable transports still participate in the network via bundle routing, just without the deep view. The epidemic-routing fallback (ARCH-027) covers cold-start scenarios where gossip hasn't propagated yet.

### ARCH-032 — IdentityGraph interface (P10)
- **Rationale**: Senders need to resolve "who owns bob@example.com?" before encrypting a bundle to that channel recipient. Without a graph, the demo synthesized a deterministic keypair from the channel_id — a hack that breaks if the recipient doesn't know the derivation. The IdentityGraph maps `(channel, channel_id) → { identity_ref, encryption_pubkey, verification, proof }` and is queryable in O(1).
- **Implications**: `createIdentityGraph()` returns an `IdentityGraph` with `link`/`resolveChannelRecipient`/`snapshot`/`get`/`revoke`/`clear`/`size`. In-memory impl for tests; Prisma-backed for production (future). In the demo, the graph is a shared singleton (all 4 nodes see the same view). In production, each node has its own graph populated by a separate identity-gossip protocol OR a federated identity directory.

### ARCH-033 — CHANNEL_OWNERSHIP proof format (P10)
- **Rationale**: Per master prompt §18, "Identity linking must not be based on unverified assumptions." A link requires proof that the identity actually owns the channel_id. The simplest cryptographically-verifiable proof: the identity's signing key signs a canonical payload `(identity_id, channel, channel_id, ts)`. The verifier checks the signature against the identity's signing pubkey.
- **Implications**: `signChannelOwnershipProof(input)` produces a `SignedChannelOwnershipProof` with `identity_id`, `channel`, `channel_id`, `ts`, `signature` (b64url), `signing_pubkey` (b64url). `verifyChannelOwnershipProof(proof, signing_pubkey)` checks the signature AND that the proof's pubkey matches. Tampering with any field invalidates the signature. The proof's `identity_id` MUST match the identity being linked (or the link is rejected).

### ARCH-034 — Contact resolution (P10)
- **Rationale**: When Alice dispatches a bundle to `EMAIL:bob@example.com`, the runtime needs the recipient's encryption pubkey. `resolveChannelRecipient(channel, channel_id)` returns `{ identity_ref, encryption_pubkey, proof }` if a VERIFIED link exists, or `undefined` otherwise. The caller MUST NOT encrypt to an unverified recipient — an unverified link could be a malicious impersonator (THREAT_MODEL §16: identity impersonation).
- **Implications**: The dispatcher in `CommOS.ts` calls `resolveChannelRecipient` before sealing the bundle. If undefined, it falls back to the synthesized keypair (a backward-compat hack retained for the demo's pre-link bootstrap). In production, the dispatcher would refuse to send and surface the error to the user.

### ARCH-035 — Resource-aware routing (P9)
- **Rationale**: Per master prompt §13, routing should consider cost, latency, reliability, availability, battery, bandwidth, storage, trust, delivery probability, privacy, TTL, priority, capabilities. The static est_* values from P3-P8 didn't reflect the peer's actual resource state. `computeHopMetrics()` derives these dynamically from the peer's resource report + verification state + intent constraints.
- **Implications**: Baseline reliability per hop kind (TRANSPORT 0.92, RELAY 0.75, GATEWAY 0.85) is adjusted by: verification multiplier (TRUSTED 1.0, PEER_CORROBORATED 0.9, UNVERIFIED 0.7), battery (<20% → ×0.5, <50% → ×0.85), bandwidth (latency scales inversely), storage (RELAY hops with <10 MB → ×0.6), compute (GATEWAY hops with low compute → ×0.8). Intent priority adjusts cost (EMERGENCY ×0.5, BULK latency ×1.5). Privacy constraints (STRICT/FORWARD_SECRECY) penalize UNVERIFIED peers heavily.

### ARCH-036 — Delivery probability estimation (P9)
- **Rationale**: Reliability is the per-hop probability of successful forwarding. But a peer might be "reliable" in forwarding yet lack the resources to actually deliver (low battery means it might die before forwarding; low storage means it can't queue). Delivery probability captures this: `delivery_probability = reliability × resource_availability_factor`.
- **Implications**: `resource_availability_factor` starts at 1.0 and is reduced by: low battery (<20% → ×0.6), low storage (<10 MB → ×0.7). The router's rankRoute formula weighs both reliability AND delivery_probability (×1000 each). This means a high-reliability peer with low battery ranks lower than a slightly-less-reliable peer with full battery — which is the correct behavior for DTN.

### ARCH-037 — Peer-caps-from-cache fix (P9)
- **Rationale**: The `peerCaps` array (immediate peers' capabilities) was using the LOCAL node's caps for ALL peers — a bug present since P3. This meant Alice's peerCaps for Bob showed Alice's relay/gateway capabilities (empty), not Bob's actual capabilities. The router's branch 2 (direct GATEWAY hop) never fired because no peer appeared to have gateway capabilities. The bug was masked by the epidemic-routing fallback (ARCH-027) and the multi-hop BFS (ARCH-030, which used the cache correctly).
- **Implications**: New `buildPeerCaps()` helper looks up each peer's actual caps from the capability cache. When the cache doesn't have an entry (cold start, gossip not yet propagated), falls back to a minimal PeerCapabilities with the local node's transport types as a best-effort guess. Both `dispatch()` and `tryForward()` now use `buildPeerCaps()` instead of the inline `peers.map(...)` that used local caps. This is a bug fix, not an architecture change.
