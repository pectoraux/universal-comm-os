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
