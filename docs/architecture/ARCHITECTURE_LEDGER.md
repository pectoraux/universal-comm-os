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
