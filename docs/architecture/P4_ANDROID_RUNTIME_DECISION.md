# P4 Android Runtime Decision

> **Status**: Architecture decision (H1 blocker resolution).
>
> **Date**: 2026-08-21
>
> **Governance**: ARCH-058 (this decision), Article XVIII, P4-DESIGN §1.3.

---

## A. Which runtime architecture is being adopted?

**Decision: Option C — Native Kotlin port of the protocol core contracts.**

The Android runtime will be a native Kotlin implementation that re-implements the protocol-level contracts (BundleStore, DeliveryTracker, Transport, IdentityGraph, CapabilityCache) using Kotlin + Room + Android Keystore. The TypeScript `core/*` remains the canonical REFERENCE implementation for the web build; the Kotlin port is a CONFORMANCE-TARGETED re-implementation.

This is NOT "the TypeScript runtime remains canonical and Android just wraps it." The Android runtime is a real, independent implementation that must produce semantically identical behavior to the TypeScript runtime. Conformance is verified by:

1. The TransportConformanceSuite (ARCH-055) — runs against both TS and Kotlin transports.
2. Cross-implementation persistence contract tests (P1-P7) — run against both Prisma and Room.
3. Crypto interoperability tests (H2) — Ed25519 signatures produced by Android are verifiable by the TS `verifyProof()`, and vice versa.

**Why not React Native + JSI (Option A)?**
- React Native adds a 40MB+ runtime dependency (Hermes + RN framework).
- The JSI bridge introduces GC stalls that can miss BLE GATT callback deadlines.
- The TypeScript runtime was not designed for Android lifecycle constraints (process death, background limits).
- A JSI bridge that crashes can take down the entire protocol runtime.

**Why not Node.js Mobile (Option B)?**
- Node.js Mobile is a community fork, not officially supported.
- Node.js was not designed for foreground-service lifecycle.
- Memory pressure on Android would kill the Node.js process, losing in-memory protocol state.

**Why Option C (Kotlin port)?**
- Smallest binary, best battery life, best Android Keystore integration.
- Room/SQLite is the natural persistence layer for Android.
- Kotlin coroutines provide the single-threaded event loop (R6) naturally.
- The port is bounded: only the protocol contracts need porting (~6 interfaces). The transport implementations (BLE, Wi-Fi Direct) are new Android code anyway.

---

## B. Why?

The frozen protocol contracts are INTERFACE-level, not implementation-level:
- `Transport` interface → 4 methods, 4 result kinds.
- `BundleStore` interface → push/pop/peek/remove/has.
- `DeliveryTracker` → init/transition/get/snapshot/reset + `canTransition()`.
- `IdentityGraph` → link/resolveChannelRecipient/snapshot/get/revoke/clear/size.
- `CapabilityCache` → upsert/get/snapshot/prune/clear/size.
- `Proof` → signProof/verifyProof.

A Kotlin port that implements these interfaces with identical semantics is NOT a protocol change — it's a deployment choice. The protocol is the CONTRACT, not the language.

---

## C. How does the chosen runtime preserve protocol semantics?

| Protocol contract | TypeScript canonical | Kotlin port | Conformance mechanism |
|---|---|---|---|
| CommunicationBundle | `core/bundle/types.ts` | Kotlin data class with identical fields | JSON round-trip test: TS serializes → Kotlin deserializes → byte-identical |
| UniversalIdentity | `core/identity/types.ts` | Kotlin data class | Same |
| DeliveryTracker | `core/delivery/DeliveryTracker.ts` (FORWARD_GRAPH + canTransition) | Kotlin object with identical transition graph | Cross-impl test: same input sequence → same DeliveryEvent records |
| IdentityGraph | `core/identity/IdentityGraph.ts` + IdentityLinkStateMachine | Kotlin class with identical transition table | Cross-impl test: same link/verify/revoke sequence → same VerificationState |
| Transport | `core/transport/Transport.ts` (4 methods, 4 kinds) | Kotlin interface with identical methods | TransportConformanceSuite (ARCH-055) |
| Proof | `core/trust/Proof.ts` (Ed25519 sign/verify) | Kotlin using Bouncy Castle Ed25519 | H2 crypto interoperability test |
| BundleStore | `src/server/NodeRuntime.ts` (BundleStore interface) | RoomBundleStore.kt implementing same interface | P1-P7 persistence contract tests |
| CapabilityCache | `core/capabilities/CapabilityCache.ts` | Kotlin class with identical TTL/ prune semantics | Cross-impl gossip test |

---

## D. How are protocol contracts shared?

The contracts are shared via:
1. **Frozen TypeScript source** (`src/core/*`) — the authoritative reference.
2. **Kotlin source** (`android/app/src/main/java/io/commos/edge/`) — the port.
3. **Conformance test suites** — verify semantic equivalence.

There is no code generation step. The Kotlin port is hand-written against the TypeScript interfaces, guided by the conformance tests. If the TypeScript contracts change (via ACP), the Kotlin port must be updated to match, and the conformance tests must still pass.

---

## E. How are cross-language semantic mismatches detected?

| Detection mechanism | What it catches |
|---|---|
| TransportConformanceSuite (ARCH-055) | Transport interface violations (framing, opaque bundles, no identity mutation) |
| P1-P7 persistence contract tests | Persistence divergence (dedup, TTL, state transitions, crash consistency) |
| H2 crypto interoperability test | Signature incompatibility (Ed25519 EC P-256 mismatch) |
| DeliveryTracker cross-impl test | State machine divergence (illegal transitions accepted/rejected differently) |
| Architecture enforcement tests (Article XVIII) | Protocol semantic violations (Android-specific types, forbidden gossip, framing in bundle) |

A mismatch in any of these is an Article XVIII §14 architecture-control defect.

---

## F. What is the authoritative runtime?

**For the web build**: the TypeScript runtime in `src/server/NodeRuntime.ts` is authoritative.

**For the Android build**: the Kotlin runtime in `android/app/src/main/java/io/commos/edge/` is authoritative.

Both are authoritative for their respective platforms. Neither can override the other's semantics — both must conform to the frozen protocol contracts. If they disagree on behavior, the conformance tests catch it, and the disagreement is resolved by fixing the non-conforming implementation to match the frozen contract.

There is NO "one true runtime." There is one true PROTOCOL, implemented in two languages, verified by cross-implementation conformance tests.
