# P4 — Edge Transport Architecture

> **Status**: Design (not yet implemented). Awaiting architecture review approval.
>
> **Authors**: Z (principal architect)
>
> **Date**: 2026-08-21
>
> **Governance**: This document is governed by Articles I–XVII of the
> Architecture Constitution. The implementation phase (post-approval) will
> produce a fresh Article XVII COMMIT REPORT with `EXECUTION EVIDENCE
> STATUS: VALID` before merging.
>
> **Scope**: P4 adds two new hardware transport adapters (BLE, Wi-Fi
> Direct) for the Android platform. It does NOT change the Communication
> Bundle format, the IdentityGraph, the VerificationState machine, the
> Authorization model, the Trust model, the Delivery state machine, the
> Repository Truth Gate, or the Execution Evidence Gate.

---

## 0. Mission and Scope

### Mission

Provide Android device-to-device transport for Communication Bundles such
that two Android devices can exchange encrypted bundles offline (no
Internet, no cellular, no Matrix) using BLE and Wi-Fi Direct. The Android
node participates in the existing DTN relay network on equal footing
with the existing in-process LoopbackTransport node — same bundle format,
same identity model, same delivery state machine, same authorization,
same trust model.

### In Scope

- BLE GATT-based bundle transport adapter (`src/transport/ble/`).
- Wi-Fi Direct (Wi-Fi P2P) bundle transport adapter (`src/transport/wifidirect/`).
- Local peer discovery (BLE advertising + scan; Wi-Fi Direct service
  discovery via `WifiP2pManager`).
- Encrypted transport sessions (re-using the existing `CryptoEnvelope`
  from `core/trust/` — no new crypto).
- Offline store-and-forward (re-using the existing `BundleStore`
  interface from `server/NodeRuntime.ts` — Android impl backed by
  SQLite/Room).
- Relay participation (re-using the existing `RELAY_FORWARD` proof
  mechanism from ARCH-023 — Android node signs relays with its Ed25519
  signing key).
- Capability advertisement via the duck-typed `gossip()` / `onGossip()`
  side-channel (ARCH-031) — Android transports implement the same
  pattern as `LoopbackTransport`.

### Out of Scope (deferred to P4.x or later)

- NFC transport (P4.x candidate — same `Transport` interface, different
  physical layer).
- LoRa / LoRaWAN transport (P4.x candidate — long-range, low-bandwidth,
  different MTU constraints).
- iOS support (separate platform, separate sprint).
- Desktop Bluetooth (Windows / macOS / Linux) — separate sprint.
- Wi-Fi Aware (NAN) — `WIFI_AWARE` is already a `TransportCapabilityType`
  but the adapter is deferred.
- BLE mesh (different topology model — deferred to P4.x).
- Cellular SMS as a transport (already covered as a Gateway adapter in
  `src/adapters/sms/`).

### Frozen Invariants (cross-reference)

P4 MUST NOT modify any of these. A violation of any of them is an
architecture-control defect (Article X) and automatically invalidates
the implementation per Article XVIII §9.

| Frozen Invariant | Source | Why P4 cannot touch it |
|---|---|---|
| Communication Bundle format | `core/bundle/types.ts` + Article IV | P4 transports receive opaque bundles; they do not interpret or reformat the bundle. |
| IdentityGraph | `core/identity/IdentityGraph.ts` + Article II + Article XV | P4 transports do not look up identities — that is the routing layer's job. |
| VerificationState machine | `core/identity/IdentityLinkStateMachine.ts` + Article XIV + Article XV | P4 transports are oblivious to channel verification. |
| Authorization model | `lib/authorization.ts` + Articles XII–XIV | P4 transports run AFTER authorization — the dispatch action already authorized the operation. |
| Trust model | `core/trust/*` + Article IX | P4 transports re-use `CryptoEnvelope` / `signProof` / `verifyProof` — no new cryptography. |
| Delivery state machine | `core/delivery/*` + Article VI | P4 transports emit `TransportSendResult`; the NodeRuntime translates that into the delivery state machine, NOT the transport. |
| Repository Truth Gate | `scripts/repo-truth-gate.sh` + Article XVI | P4 implementation commits must satisfy the gate like any other code change. |
| Execution Evidence Gate | `scripts/generate-execution-evidence.sh` + Article XVII | P4 implementation milestone report must include EXECUTION EVIDENCE STATUS: VALID. |

---

## 1. Android System Architecture

### 1.1 Process model

The Android node runs as a single foreground service (`CommOsService`)
hosting the existing `NodeRuntime` from `src/server/NodeRuntime.ts`. The
service runs in the foreground because:

1. Android 14+ requires foreground services for long-running BLE scanning
   (`BLUETOOTH_SCAN` with `neverForLocation`).
2. Wi-Fi Direct discovery requires the app to hold a foreground service
   while `WifiP2pManager.discoverPeers()` is in flight.
3. The DTN sweeper needs to wake up periodically to expire bundles —
   this requires either WorkManager (deferred, not real-time enough for
   DTN) or a foreground service (real-time).

The foreground service displays a persistent notification ("CommOS is
running — managing offline bundles") as required by Android 13+.

### 1.2 Component layout

```
app/src/main/java/io/commos/edge/
├── CommOsService.kt              # Foreground service hosting NodeRuntime
├── NodeRuntimeHost.kt            # Bridge: NodeRuntime (TS) ↔ Android lifecycle
├── transports/
│   ├── ble/
│   │   ├── BleTransport.kt       # Implements core/transport/Transport (via JSI)
│   │   ├── BleCentral.kt         # BluetoothLeScanner wrapper
│   │   ├── BlePeripheral.kt      # BluetoothGattServer wrapper
│   │   ├── BleGattSpec.kt        # Service/Characteristic UUIDs (see §3)
│   │   └── BlePeerRegistry.kt   # Discovered peer → node_id mapping
│   └── wifidirect/
│       ├── WifiDirectTransport.kt
│       ├── WifiP2pController.kt  # WifiP2pManager wrapper
│       ├── GroupOwnerServer.kt   # TCP server on the group owner
│       └── GroupClient.kt         # TCP client to the group owner
├── persistence/
│   ├── AndroidBundleStore.kt     # BundleStore backed by Room/SQLite
│   └── AndroidDeliveryTracker.kt # DeliveryTracker persisted to Room
├── power/
│   ├── PowerPolicy.kt            # Battery-aware scan duty cycle
│   └── ResourceMonitor.kt        # BatteryManager + StorageStatsManager
└── ui/
    ├── MainActivity.kt           # Settings + debug console
    └── NodeControlsFragment.kt  # Start/stop, send test bundle
```

### 1.3 Android runtime boundary (S0.2.6 — strengthened)

> **Architecture review concern (reviewer point 2)**: "Canonical TypeScript is unchanged" is NOT by itself an architectural argument. The design must establish why the existing `NodeRuntime` can safely live inside an Android lifecycle, particularly around process death, background execution, persistence recovery, cryptographic key access, long-lived transport callbacks, concurrency, and deterministic delivery state transitions.

There are three materially different runtime architectures for P4. The design must justify the choice, not assume it.

#### 1.3.1 The three options

| Option | Topology | Pros | Cons |
|---|---|---|---|
| **A. React Native + JSI** | React Native host → JSI bridge → existing TS `NodeRuntime` → Transport impls (Kotlin, exposed via JSI) | Re-uses canonical TS `core/*` unchanged. Re-uses the vitest test suite (436 tests). Smallest implementation surface. | Adds React Native dependency. The TS runtime on-device is a JavaScript engine (Hermes) — JSI bridges must be carefully written to avoid GC stalls. |
| **B. Node.js Mobile + native bridge** | Node.js Mobile host → existing TS `NodeRuntime` (unchanged) → Transport impls (Kotlin, exposed via N-API) | Re-uses canonical TS unchanged. No React Native dependency. Smaller binary than option A. | Node.js Mobile is a community fork (not officially supported by the Node.js project). N-API bindings are more verbose than JSI. Background execution on Android requires extra work (Node.js Mobile wasn't designed for foreground-service life). |
| **C. Native Kotlin port** | Kotlin `NodeRuntime` re-implementation → shared protocol contracts (frozen TS types as Kotlin type aliases) | Smallest binary. No JS runtime on-device. Best battery life (no JIT, no GC pauses). Best integration with Android Keystore / BluetoothLeScanner / WifiP2pManager. | Requires porting `NodeRuntime`, `Router`, `DeliveryTracker`, `IdentityGraph`, `CapabilityCache` to Kotlin. The vitest suite doesn't run against Kotlin — must be re-implemented in Kotlin test framework (JUnit + Robolectric). Risk of TS↔Kotlin semantic drift over time. |

#### 1.3.2 Decision (DEFERRED — architecture review question 1)

**This is the first of the 7 architecture-review open questions in §13.** The P4 implementation MUST NOT begin until this question is resolved. The default choice (Option A — React Native + JSI) is provisional; the reviewer may direct a different choice.

#### 1.3.3 Required runtime-boundary invariants (independent of option chosen)

Regardless of which runtime option is chosen, the Android runtime MUST satisfy the following 7 invariants. These are NOT implementation details — they are architectural properties the implementation must prove in tests.

| # | Invariant | Why it matters |
|---|---|---|
| **R1** | **Process death recovery** — when the Android OS kills the app process (memory pressure, user swipe-away), the in-memory `NodeRuntime` state is lost. On restart, the runtime MUST re-hydrate from the persisted `BundleStore` + `DeliveryTracker`. The `bundle_id` (canonical UUID per ARCH-024) is the deduplication key — a bundle that was mid-send when the process died MUST NOT be re-delivered as a new bundle on restart. | Without this, process death causes duplicate delivery — Article VI (delivery state machine) is silently violated. |
| **R2** | **Background execution** — Android 14+ restricts background work to short windows unless a foreground service is active. The DTN TTL sweeper MUST run as part of a foreground service (§1.1) so it can expire bundles within their TTL. The sweeper MUST NOT be deferred to WorkManager (work is delayed 15+ minutes, which causes bundles to expire past their TTL without the `EXPIRED` transition firing — Article VI violation). | Without this, the `EXPIRED` delivery-state transition is silently skipped, breaking the delivery state machine. |
| **R3** | **Persistence recovery** — the persisted state (`BundleStore`, `DeliveryTracker`, `ReceivedBundle`) MUST be the canonical source of truth on restart. The in-memory state is a cache. On restart, the runtime queries the persisted state and reconstructs the in-memory cache. The reconstruction is deterministic — given the same persisted state, the runtime produces the same in-memory state. | Without this, restart causes non-deterministic delivery state — Article VI is silently violated. |
| **R4** | **Cryptographic key access** — the node's Ed25519 signing secret key MUST live in the Android Keystore (secure enclave). The runtime accesses it via `KeyStore.getInstance("AndroidKeychain")` + a `BiometricPrompt` (or device authentication) for key use. The runtime MUST refuse to sign `RELAY_FORWARD` proofs if the Keystore is locked (advertise `relay: []` until unlocked — §6.4). The runtime MUST NOT cache the signing secret key in process memory beyond the duration of a single signature operation. | Without this, a process compromise (root exploit, debug build leaked) exposes the signing key — Article IX (trust model) is silently violated. |
| **R5** | **Long-lived transport callbacks** — `Transport.onReceive(handler)` registers a handler that fires on bundle arrival. On Android, this can happen on a BLE GATT callback thread OR a Wi-Fi Direct TCP socket thread (NOT the main thread). The runtime MUST serialize handler invocations via a single-threaded queue — concurrent handler calls would race on the in-memory `DeliveryTracker` and corrupt the delivery state machine. | Without this, concurrent bundle arrivals race the delivery state machine — Article VI is silently violated. |
| **R6** | **Concurrency** — the runtime MUST use a single-threaded event loop (e.g., Node.js event loop in Option A/B, or a Kotlin coroutine single-dispatcher in Option C). Concurrent mutations of `IdentityGraph`, `DeliveryTracker`, or `CapabilityCache` are forbidden. The runtime MAY use background threads for I/O (BLE scan, Wi-Fi Direct discovery, SQLite writes) but the results MUST be dispatched back to the single-threaded event loop for state mutation. | Without this, concurrent state mutations cause data races — Articles XIV, XV, VI are silently violated. |
| **R7** | **Deterministic delivery-state transitions** — given the same sequence of inputs (bundle arrival, TTL expiry, peer disconnect, manual revoke), the runtime MUST produce the same sequence of `DeliveryEvent` records. The transitions MUST go through the canonical `transition()` function in `core/delivery/DeliveryTracker.ts` — the runtime MUST NOT mutate the delivery state directly. | Without this, the delivery state machine is silently bypassed — Article VI is violated. |

These 7 invariants are testable:
- R1: kill the app process mid-send; restart; verify no duplicate delivery.
- R2: put the device in Doze; verify the sweeper still runs (foreground service exemption); verify `EXPIRED` transitions fire within TTL.
- R3: persist state, kill, restart; verify the in-memory state matches.
- R4: lock the Keystore; verify the runtime advertises `relay: []` and refuses to sign.
- R5: send 10 bundles concurrently from 2 peers; verify the `DeliveryTracker` records exactly 10 transitions in order.
- R6: stress-test concurrent bundle arrivals + TTL sweeps; verify no data races.
- R7: replay the same input sequence twice; verify identical `DeliveryEvent` records.

A failure of any of these 7 tests is an Article XVIII §9 architecture-control defect.

#### 1.3.4 What "the canonical TypeScript is unchanged" actually means

The phrase from the original P4-DESIGN meant: the source files in `src/core/*`, `src/server/*`, `src/transport/loopback/*` are NOT modified for Android. They are imported (Option A/B) or ported (Option C).

**This is NOT an architectural argument by itself** (reviewer point 2 is correct). The architectural argument is the 7 invariants in §1.3.3 — those are the properties the runtime MUST satisfy, independent of which language hosts the protocol core.

### 1.4 Permissions

```xml
<!-- AndroidManifest.xml (excerpt) -->
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
                 android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />

<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<!-- ACCESS_FINE_LOCATION is required for Wi-Fi Direct peer discovery on
     Android 6+. The P4 manifest documents this in the privacy policy. -->

<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />
<!-- Android 14+ requires the _CONNECTED_DEVICE subtype for BLE/Wi-Fi
     foreground services. -->

<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<!-- Required for the foreground service notification on Android 13+. -->
```

Runtime permission requests are made by `MainActivity.kt` on first launch.
The user MUST grant all permissions before `CommOsService.startService()`
is called. If the user denies, the service refuses to start and surfaces
a clear error.

### 1.5 Lifecycle

```
MainActivity
    │
    ├─ Request permissions (BLE, Wi-Fi, Location, Notifications)
    │
    ├─ startForegroundService(CommOsService)
    │       │
    │       ├─ Create NodeRuntime (TS side, via JSI)
    │       ├─ Create BleTransport + register with NodeRuntime
    │       ├─ Create WifiDirectTransport + register with NodeRuntime
    │       ├─ Start BLE advertising (peripheral mode)
    │       ├─ Start BLE scanning (central mode, duty-cycled)
    │       ├─ Start Wi-Fi Direct discoverPeers() (continuous)
    │       └─ Start TTL sweeper (every 60s)
    │
    └─ Stop foreground service → close() all transports → unbind NodeRuntime
```

The NodeRuntime is unbound when the service is destroyed, but the
`BundleStore` (Room/SQLite) persists. On next start, the NodeRuntime
re-hydrates the in-memory delivery tracker from the persisted state.

---

## 2. Transport Abstraction Boundary

### 2.1 The `Transport` interface contract

Every P4 transport MUST implement the `Transport` interface defined in
`src/core/transport/Transport.ts`:

```typescript
export interface Transport {
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
export type TransportSendResult =
  | { kind: 'OK'; forwarded_at: number }
  | { kind: 'UNAVAILABLE'; reason: string }
  | { kind: 'NO_PEER'; reason: string }
  | { kind: 'ERROR'; reason: string };
```

### 2.4 Transport framing ≠ Bundle semantics (S0.2.6 — strengthened, reviewer point 3)

> **Architecture review concern**: BLE chunking (4-byte sequence + 1-byte flag headers) and the Wi-Fi Direct 4-byte length prefix are acceptable ONLY if those fields are explicitly defined as **transport framing**, not bundle fields. Otherwise the adapter starts redefining the wire protocol.

The P4 transports MUST maintain a strict three-layer separation:

```
┌───────────────────────────────────────────────────────────────┐
│  Communication Bundle (frozen — Article IV)                   │
│  ────────────────────────────────────────────────────────────  │
│  bundle_id / sender / recipient / intent / payload / proofs   │
│  (canonical, opaque, NEVER modified by any transport)         │
└───────────────────────────────────────────────────────────────┘
                              ↓ serializeBundle() — opaque bytes
┌───────────────────────────────────────────────────────────────┐
│  Transport framing (ephemeral, per-transport, NEVER persisted)│
│  ────────────────────────────────────────────────────────────  │
│  BLE:  [4-byte sequence] [1-byte flag] [chunk bytes]          │
│  Wi-Fi: [4-byte length prefix] [bundle bytes]                 │
│  (these fields exist ONLY in transit; they are NOT part of    │
│  the bundle and are NOT visible to the recipient's             │
│  parseBundle())                                               │
└───────────────────────────────────────────────────────────────┘
                              ↓ BLE GATT write / Wi-Fi Direct TCP send
┌───────────────────────────────────────────────────────────────┐
│  Physical transport (BLE ATT / Wi-Fi Direct frames)           │
└───────────────────────────────────────────────────────────────┘
```

**Invariant T1 (transport framing is ephemeral)**: The transport framing fields (BLE chunk header, Wi-Fi length prefix) exist ONLY in transit. They are NOT serialized into the `CommunicationBundle`. They are NOT persisted in the `BundleStore`. They are NOT visible to the recipient's `parseBundle()`. The recipient sees ONLY the canonical bundle bytes — never the framing.

**Invariant T2 (transport framing is per-transport)**: Different transports MAY use different framing. BLE uses chunked-with-sequence. Wi-Fi Direct uses length-prefixed. A future LoRa transport MAY use a different framing still. The framing choice is internal to each transport and does NOT propagate across transports (a bundle arriving via BLE is re-serialized with Wi-Fi Direct's framing when forwarded — the BLE framing is discarded).

**Invariant T3 (transport framing MUST NOT alter bundle semantics)**: The framing fields (sequence number, length prefix, flag byte) carry NO protocol meaning. They do NOT change the bundle's `bundle_id`, `sender`, `recipient`, `intent`, `payload`, or `proofs`. They do NOT encode delivery state, authorization state, or trust state. A transport that uses framing fields to encode protocol semantics violates Article IV (bundle is the fundamental routable object) and Article XVIII §3 (transports do not interpret bundle contents).

**Invariant T4 (transport framing is testable)**: The framing implementation MUST include a test that:
1. Serializes a `CommunicationBundle` to bytes via `serializeBundle()`.
2. Sends the bytes via the transport (BLE chunks / Wi-Fi length-prefixed).
3. Receives the bytes on the other side.
4. Parses them via `parseBundle()`.
5. Asserts the round-tripped bundle is byte-identical to the original.

A failure of this test is an Article XVIII §9 architecture-control defect.

### 2.5 Gossip side-channel (S0.2.6 — tightened, reviewer point 6)

> **Architecture review concern**: A "side-channel" is exactly how architecture drift can enter later. The document needs a hard rule that gossip can communicate transport/network observations, but cannot introduce alternate protocol semantics.

P4 transports MAY implement the duck-typed `gossip()` / `onGossip()` methods (ARCH-031, same pattern as `LoopbackTransport`). The NodeRuntime casts to access them. BUT: the gossip side-channel is constrained by **Invariant G1 (gossip boundary)**.

#### G1.1 Acceptable gossip payloads (transport/network observations only)

The gossip side-channel MAY carry:

| Payload | Example | Why it's acceptable |
|---|---|---|
| Peer observability | `{ kind: 'PEER_SEEN', node_id: 'abc123', transport: 'BLE', at: 1692624000000 }` | The transport observed a peer on its physical layer. This is network topology — already in `CapabilityAdvertisement`. |
| Peer reachability | `{ kind: 'PEER_REACHABLE', node_id: 'abc123', transport: 'BLE', rssi: -67 }` | The transport can currently deliver to this peer. Useful for routing decisions. |
| Resource estimate | `{ kind: 'RESOURCE_REPORT', node_id: 'abc123', battery_pct: 0.42, bandwidth_bps: 125000 }` | The peer's resource state — already in `NodeCapabilities.resource` (ARCH-035). |
| Transport capability | `{ kind: 'CAPABILITY_ADVERTISEMENT', ... }` (the existing `CapabilityAdvertisement` shape) | The canonical capability advertisement. This is what ARCH-031 was designed for. |
| Bundle forwarding opportunity | `{ kind: 'FORWARDING_OPPORTUNITY', bundle_id: '...', next_hop: 'abc123', transport: 'BLE' }` | A hint that a specific bundle can now be forwarded (e.g., peer just reconnected). The NodeRuntime MAY use this to retry QUEUED bundles. |

All acceptable payloads are observations about the transport/network layer. They do NOT assert protocol semantics.

#### G1.2 FORBIDDEN gossip payloads (alternate protocol semantics)

The gossip side-channel MUST NOT carry:

| Payload | Why it's forbidden | Which article it would violate |
|---|---|---|
| Alternate identity assertion | `{ kind: 'IDENTITY_ASSERTION', node_id: 'abc123', channel: 'EMAIL', channel_id: 'alice@example.com' }` | Article II + XIV — identity linking goes through `IdentityGraph.link()` → ASSERTED → challenge → VERIFIED. A transport-side identity assertion bypasses this. |
| Alternate trust state | `{ kind: 'TRUST_ASSERTION', node_id: 'abc123', trust_level: 'TRUSTED' }` | Article IX + `PeerCapabilities.verification` — trust is derived from the existing verification ladder (`UNVERIFIED` / `PEER_CORROBORATED` / `TRUSTED`). A transport-side trust assertion bypasses this. |
| Alternate delivery state | `{ kind: 'DELIVERY_STATE', bundle_id: '...', state: 'DELIVERED' }` | Article VI — delivery state transitions go through `DeliveryTracker.transition()`. A transport-side delivery assertion bypasses this. |
| Alternate authorization | `{ kind: 'AUTHZ_GRANT', node_id: 'abc123', role: 'PLATFORM_ADMIN' }` | Articles XII–XIV — authorization goes through `authorizeNode()` / `authorizeByVisibility()`. A transport-side authorization assertion bypasses this. |
| Alternate bundle format | `{ kind: 'BUNDLE_VARIANT', encoding: 'msgpack', ... }` | Article IV — the bundle format is frozen. A transport-side format variant bypasses this. |
| Alternate verification state | `{ kind: 'VERIFICATION_ASSERTION', channel_id: '...', state: 'VERIFIED' }` | Articles XIV, XV — verification goes through `IdentityLinkStateMachine.transition()`. A transport-side verification assertion bypasses this. |

#### G1.3 Enforcement

The architecture boundary tests (`tests/architecture/boundaries-strict.test.ts`) will be extended in P4.7 with a static AST scan that proves no transport implementation references any of the forbidden gossip payload kinds. Specifically, the scan checks:
- No transport file contains the strings `'IDENTITY_ASSERTION'`, `'TRUST_ASSERTION'`, `'DELIVERY_STATE'`, `'AUTHZ_GRANT'`, `'BUNDLE_VARIANT'`, or `'VERIFICATION_ASSERTION'`.
- Transports MAY reference `'PEER_SEEN'`, `'PEER_REACHABLE'`, `'RESOURCE_REPORT'`, `'CAPABILITY_ADVERTISEMENT'`, `'FORWARDING_OPPORTUNITY'` — these are the acceptable kinds.

A transport that introduces a forbidden gossip payload kind is an Article XVIII §9 architecture-control defect.

#### G1.4 Backward compatibility

The `gossip()` / `onGossip()` methods are duck-typed (not on the `Transport` interface). The NodeRuntime casts transports to access them. The transport MAY choose not to implement them — in that case, gossip simply doesn't propagate over that transport (ARCH-031's "best-effort" semantics). This is the SAME pattern as `LoopbackTransport` — P4 does not change it.

### 2.6 What hardware adapters MAY do (recap)

- Implement the 4 `Transport` methods using platform-specific APIs (BluetoothLeScanner, BluetoothGattServer, WifiP2pManager).
- Add transport framing (§2.4) — ephemeral, per-transport, NOT persisted.
- Add the duck-typed `gossip()` / `onGossip()` side-channel (§2.5) — carrying ONLY acceptable payload kinds (§2.5 G1.1).
- Add internal state (peer registries, GATT connections, scan windows) that is invisible to the `core/*` layer.
- Report `ResourceReport` fields via the existing `NodeCapabilities.resource` field (ARCH-035).

### 2.7 What hardware adapters MUST NOT do (Article XVIII — recap with strengthened invariants)

- MUST NOT redefine the `Transport` interface — only implement it.
- MUST NOT introduce new `TransportSendResult` kinds — the 4 kinds are canonical.
- MUST NOT introduce transport framing that alters bundle semantics (§2.4 T3).
- MUST NOT carry forbidden gossip payloads (§2.5 G1.2).
- MUST NOT decrypt or interpret bundle contents (THREAT_MODEL §1, Article IX).
- MUST NOT bypass the `IdentityGraph` (Article II).
- MUST NOT sign bundles on behalf of the sender (ARCH-023).
- MUST NOT invent new cryptographic primitives (Article IX).
- MUST NOT change the delivery state machine (Article VI).
- MUST NOT throw exceptions across the interface boundary (Article XVIII §2).

---

## 3. BLE Adapter Design

### 3.1 GATT service specification

The BLE adapter exposes a single GATT service:

| Field | UUID (v4, random) | Purpose |
|---|---|---|
| Service | `00000001-7777-7777-7777-777777777700` | CommOS BLE Service |
| Characteristic: Bundle Inbox | `00000002-7777-7777-7777-777777777700` | Write-only — peer writes an opaque bundle chunk here. |
| Characteristic: Bundle Outbox | `00000003-7777-7777-7777-777777777700` | Notify-only — peer subscribes to receive outgoing bundles. |
| Characteristic: Node ID | `00000004-7777-7777-7777-777777777700` | Read-only — exposes the local node_id (used for peer identification). |
| Characteristic: Capability Advertisements | `00000005-7777-7777-7777-777777777700` | Write + Notify — bidirectional `CapabilityAdvertisement` exchange (gossip side-channel). |
| Characteristic: MTU Negotiation Hint | `00000006-7777-7777-7777-777777777700` | Read-only — local preferred MTU (used before `requestMtu()`). |

UUIDs are random v4 to avoid collision with the Bluetooth SIG-assigned
range. The 16-bit short form (e.g. `0x7777`) is reserved at the SIG for
testing; the project uses the full 128-bit form to avoid future conflicts.

### 3.2 Bundle chunking

BLE GATT characteristics have an MTU limit (default 23 bytes; negotiable
up to ~512 bytes for ATT, ~1024 bytes for L2CAP). Communication bundles
can be several KB. The adapter chunks bundles:

- The peer writes chunks to the "Bundle Inbox" characteristic, each chunk
  prefixed with a 4-byte sequence number (uint32 LE) and a 1-byte flag
  (0x01 = more chunks follow, 0x00 = last chunk).
- The receiving side reassembles chunks in order; on the final chunk,
  it parses the bundle via the existing `parseBundle()` in
  `core/bundle/CommunicationBundle.ts` and emits it via `onReceive()`.
- If a chunk arrives out of order or with a gap, the receiver discards
  the partial bundle and logs `BleReassemblyError` (does NOT throw —
  Article XVIII §2 requires no exceptions across the boundary).

### 3.3 Advertising packets

BLE advertising is used for peer discovery. The advertising packet is
small (31 bytes legacy, 254 bytes extended). The adapter advertises:

- **Service UUID** (16-bit form `0x7777` mapped to the full 128-bit
  service above) — lets scanning peers identify this device as a CommOS
  node.
- **Local node_id hash** (8 bytes) — first 8 bytes of
  `pubkeyHash(node.signing_pubkey)`. The full node_id is revealed only
  AFTER GATT connection (over the Node ID characteristic). This avoids
  leaking the full node_id in the advertising packet (privacy).
- **Battery hint** (1 byte) — coarse battery percentage in 4 bands
  (0=≤25%, 1=26-50%, 2=51-75%, 3=76-100%) used by the routing layer
  to prefer high-battery relays (ARCH-035/036).

Advertising interval is duty-cycled (see §8 Battery/Resource Model):
- Plugged in: 100 ms (fast discovery, more power).
- Battery > 50%: 1000 ms (slow discovery, balanced).
- Battery ≤ 50%: 5000 ms (slow, conserve power).
- Battery ≤ 20%: STOP advertising; only scan opportunistically (§8).

### 3.4 Scanning

BLE scanning uses `BluetoothLeScanner.startScan()` with a `ScanFilter`
on the CommOS service UUID. The scan window/interval is duty-cycled
based on battery (see §8).

On discovering a peer, the adapter:
1. Records the peer's advertising hash in `BlePeerRegistry`.
2. Calls `BluetoothDevice.connectGatt()` to establish a connection.
3. Discovers services; verifies the CommOS GATT service is present.
4. Reads the peer's Node ID characteristic → registers `peer_node_id`
   in the registry.
5. Exchanges capability advertisements over the Gossip characteristic.
6. Marks the peer as `connected` and ready for `send()`.

### 3.5 Connection limits

Android enforces a maximum of 7 active GATT connections per central
(typical; varies by device). The adapter enforces a soft cap of 4
concurrent connections to leave headroom for other BLE peripherals the
user may have paired. When the cap is reached, the adapter refuses new
connections with `TransportSendResult = { kind: 'UNAVAILABLE'; reason:
'max GATT connections reached' }`.

### 3.6 Send flow

```
send(bundle, to_node_id):
  1. Look up peer_node_id in BlePeerRegistry.
  2. If not found: return { kind: 'NO_PEER'; reason: '<id> not in registry' }.
  3. If peer is not connected: return { kind: 'UNAVAILABLE'; reason:
     'peer not connected' }.
  4. Serialize bundle to bytes (existing serializeBundle()).
  5. Chunk into MTU-sized pieces.
  6. For each chunk: write to the peer's "Bundle Inbox" characteristic.
     - On GATT failure (e.g., connection drop mid-chunk): abort,
       return { kind: 'ERROR'; reason: 'GATT write failed: <code>' }.
  7. Return { kind: 'OK'; forwarded_at: Date.now() }.
```

### 3.7 Receive flow

```
On GATT characteristic write to local "Bundle Inbox":
  1. Read chunk header (4-byte sequence + 1-byte flag).
  2. Append chunk to reassembly buffer keyed by sequence number.
  3. If flag == 0x00 (last chunk): reassemble in order, parse bundle,
     emit via onReceive(bundle, from_node_id).
  4. If a chunk arrives out of order: discard the partial buffer,
     log BleReassemblyError, do NOT throw.
```

---

## 4. Wi-Fi Direct Adapter Design

### 4.1 Topology

Wi-Fi Direct (Wi-Fi P2P) forms a small group with one Group Owner (GO)
and one or more Group Clients. The GO behaves like an access point
(emits beacons, runs DHCP, accepts TCP connections); clients associate
to the GO like a normal Wi-Fi network.

For P4, each Android device acts as BOTH:
- A potential GO (when it's the device that initiates group formation).
- A potential client (when another device initiates).

The `WifiP2pManager` API handles GO negotiation automatically — the
device that initiates `createGroup()` becomes the GO.

### 4.2 Service discovery

`WifiP2pManager.discoverPeers()` is called continuously (every 10
seconds when battery > 50%; every 30 seconds when battery ≤ 50%; stopped
when battery ≤ 20% — see §8).

The adapter registers a `WifiP2pManager.setServiceResponseListener()`
with a CommOS service request (mDNS-style over Wi-Fi Direct). The
service request includes:
- Service type: `_commos._tcp`.
- Service info: a small TXT record with the local node_id hash (8 bytes
  hex, same as the BLE advertising hash) + battery hint.

On discovering a peer, the adapter:
1. Resolves the peer's service info → records `peer_node_id` hash in
   the Wi-Fi Direct peer registry.
2. If not already in a group with this peer, initiates group formation
   (see §4.3).

### 4.3 Group formation

```
1. WifiP2pManager.connect(channel, config, listener)
   - config is WifiP2pConfig with networkName + passphrase (randomly
     generated per group, stored in EncryptedSharedPreferences).
2. On WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION broadcast:
   - If groupInfo.isGroupOwner == true:
     - Start GroupOwnerServer (TCP server on port 7878 — chosen
       arbitrarily, documented in the manifest).
     - The server accepts connections from clients and exchanges
       CapabilityAdvertisement objects before any bundle traffic.
   - If groupInfo.isGroupOwner == false:
     - Connect to the GO's IP (resolved via
       NetworkInterface.getInterfaceAddresses() on the Wi-Fi P2P
       interface) on port 7878.
     - Exchange CapabilityAdvertisement.
3. Once the GO↔client TCP session is established, mark the peer as
   `connected` in the registry.
```

Group formation has a 30-second timeout. If it doesn't complete, the
adapter logs `WifiDirectGroupFormationTimeout` and retries up to 2 times.
After 3 failures, the peer is marked as `unreachable` for 60 seconds.

### 4.4 Bundle transport over TCP

Once the GO↔client TCP session is established:

```
send(bundle, to_node_id):
  1. Look up peer_node_id in WifiDirectPeerRegistry.
  2. If not found or not connected: return { kind: 'NO_PEER' }.
  3. Serialize bundle to bytes.
  4. Write a 4-byte length prefix (uint32 LE) followed by the bundle
     bytes to the TCP socket.
  5. On success: return { kind: 'OK'; forwarded_at: Date.now() }.
  6. On socket exception (e.g., peer dropped):
     - Catch the exception internally.
     - Return { kind: 'ERROR'; reason: 'socket closed: <message>' }.
```

The receive side reads the 4-byte length prefix, then reads that many
bytes, parses the bundle, and emits via `onReceive()`.

### 4.5 Group teardown

When the adapter calls `close()` or when the peer is dropped (e.g., no
traffic for 60 seconds), the adapter:
1. Closes the TCP socket.
2. Calls `WifiP2pManager.removeGroup()`.
3. Removes the peer from the registry.

---

## 5. Offline Store-and-Forward Flow

### 5.1 StoredBundle contract — one protocol contract, many persistence impls (S0.2.6 — strengthened, reviewer point 7)

> **Architecture review concern**: "Mirroring the Prisma schema" is not enough. There should be ONE protocol-level stored-bundle contract, with separate persistence implementations. Otherwise the edge runtime becomes a subtly different protocol implementation (Postgres semantics ≠ Android Room semantics).

#### 5.1.1 The protocol-level StoredBundle contract (frozen)

The `BundleStore` interface is defined in `src/server/NodeRuntime.ts`. P4 does NOT change this interface. The protocol-level contract for a `StoredBundle` is:

| Field | Type | Semantics (protocol-level, persistence-independent) |
|---|---|---|
| `bundle_id` | `string` | The canonical UUID (per ARCH-024). This is the protocol identity of the bundle — the deduplication key, the routing key, the delivery-tracking key. Two `StoredBundle` records with the same `bundle_id` are the SAME bundle. |
| `node_id` | `string` | The node that owns this stored-bundle record (the relay or the recipient). Same identity space as `UniversalIdentity.id` (Article II). |
| `next_hop` | `string` | The next-hop node_id the bundle is queued for. May change during the bundle's lifetime (re-routing per P9). |
| `bundle_json` | `string` (serialized `CommunicationBundle`) | The canonical bundle bytes — opaque to the persistence layer, never re-interpreted. |
| `priority` | `string` (enum: `BULK` / `NORMAL` / `PRIORITY` / `URGENT` / `EMERGENCY`) | Same priority space as `Intent.priority` (Article III). |
| `expires_at` | `number` (epoch ms) | The TTL expiry timestamp — same as `CommunicationBundle.expires_at`. The TTL sweeper uses this field (not the `bundle_json`'s embedded expiry) to decide when to transition to `EXPIRED`. |
| `queued_at` | `number` (epoch ms) | The timestamp the bundle entered the QUEUED state at THIS node. Used for FIFO ordering within a priority bucket. |
| `state` | `string` (enum, see §5.1.2) | The current delivery state per the canonical state machine (Article VI). |

#### 5.1.2 The protocol-level state enum (frozen)

The `state` field's value space is the Article VI delivery state machine:

```
CREATED → ACCEPTED → QUEUED → RELAYED → GATEWAY_REACHED → EXTERNAL_ACCEPTED → DELIVERED → READ
                                                                                       
Failure states: EXPIRED, REJECTED, POLICY_BLOCKED, NO_ROUTE, CHANNEL_UNAVAILABLE, GATEWAY_UNAVAILABLE, DESTINATION_UNKNOWN
```

Persistence impls MUST use these EXACT state strings. A persistence impl that invents a new state string (e.g., `STORED_LOCALLY` instead of `QUEUED`) violates Article VI.

#### 5.1.3 Persistence invariants (cross-impl)

Regardless of whether the persistence impl is Prisma/PostgreSQL (web build), Room/SQLite (Android), IndexedDB (browser), or in-memory (tests), the impl MUST satisfy these invariants:

| # | Invariant | Why it matters |
|---|---|---|
| **P1** | **Bundle identity** — `(bundle_id, node_id)` is the unique key for `StoredBundle`. Two records with the same `(bundle_id, node_id)` are the same record (UPSERT semantics, NOT insert). | Without this, a re-dispatch of the same bundle to the same node creates duplicate records — Article VI (delivery state machine) is silently forked. |
| **P2** | **Deduplication identity** — the `ReceivedBundle` table (also defined in the Prisma schema) is keyed by `(node_id, bundle_id)`. A bundle arriving at a node that has already received it is silently dropped. The deduplication is based on `bundle_id` ONLY — NOT on the bundle's contents, sender, or arrival time. | Without this, a re-relayed bundle is delivered twice — THREAT_MODEL §16 (identity impersonation via replay). |
| **P3** | **Expiry semantics** — the TTL sweeper transitions `QUEUED` bundles to `EXPIRED` when `expires_at < now`. The transition is IDEMPOTENT (running the sweeper twice on the same expired bundle produces the same final state). The transition goes through the canonical `DeliveryTracker.transition()` (per Article VI + §1.3.3 R7). | Without this, the sweeper's behavior diverges across impls — Postgres might fire `EXPIRED` at second-resolution, Android at minute-resolution (Doze mode), leading to different observable delivery states. |
| **P4** | **Delivery-state transitions** — every state change in `StoredBundle.state` MUST go through the canonical `DeliveryTracker.transition()` function. The persistence impl MUST NOT write to `state` directly. The persistence impl writes only what the canonical state machine tells it to write. | Without this, the persistence impl redefines the delivery state machine — Article VI is silently violated. |
| **P5** | **Forwarding-proof semantics** — when a relay forwards a bundle, the `bundle_json` field is updated to include the new `RELAY_FORWARD` proof (appended to `proofs[]`). The relay's persistence impl MUST NOT modify any other field of the bundle (sender, recipient, intent, payload, encryption_metadata). | Without this, a relay's persistence impl silently rewrites the bundle — Article IV (bundle is the fundamental routable object) is violated. |
| **P6** | **Crash consistency** — a crash mid-write (e.g., power loss during `INSERT INTO stored_bundles`) MUST leave the database in a consistent state. The next startup MUST NOT observe a half-written record. Persistence impls use transactions / WAL to guarantee this. | Without this, crash recovery produces corrupt state — §1.3.3 R1 (process death recovery) is silently violated. |
| **P7** | **Schema migration safety** — when the persistence schema evolves (new column, new index, type change), the migration MUST NOT corrupt existing records. The migration is forward-only (no rollback). The migration is recorded in a `schema_migrations` table. | Without this, schema migrations diverge across impls — the Android impl's schema drifts from the Postgres impl's schema, eventually producing incompatible `StoredBundle` records. |

#### 5.1.4 The Android impl

`AndroidBundleStore` (Room/SQLite-backed) implements the protocol-level contract from §5.1.1:

```kotlin
@Entity(tableName = "stored_bundles", primaryKeys = ["bundle_id", "node_id"])
data class StoredBundleEntity(
    val bundle_id: String,
    val node_id: String,
    val next_hop: String,
    val bundle_json: String,    // serialized CommunicationBundle (opaque)
    val priority: String,       // enum: BULK | NORMAL | PRIORITY | URGENT | EMERGENCY
    val expires_at: Long,       // epoch ms
    val queued_at: Long,        // epoch ms
    val state: String           // Article VI enum: CREATED | ACCEPTED | QUEUED | RELAYED | ... | EXPIRED | ...
)

@Entity(tableName = "received_bundles", primaryKeys = ["node_id", "bundle_id"])
data class ReceivedBundleEntity(
    val bundle_id: String,
    val node_id: String,
    val received_at: Long,       // epoch ms
    val from_node_id: String?
)
```

The Android schema is NOT a "mirror" of the Postgres schema — it's a SEPARATE persistence impl of the SAME protocol contract. The protocol contract is in `src/server/NodeRuntime.ts` (the `BundleStore` interface) and `prisma/schema.prisma` (the canonical Postgres impl). Android's `StoredBundleEntity` MUST satisfy the invariants P1-P7 above.

#### 5.1.5 Test coverage

Each persistence impl (Postgres, Android, in-memory) MUST have a test suite that proves P1-P7 hold. The tests are written against the protocol contract (not the impl-specific schema). A failure of any P-invariant is an Article XVIII §9 architecture-control defect.

### 5.2 Store-and-forward flow

When a bundle is dispatched and the routing layer picks a peer that is
NOT currently reachable:

```
1. NodeRuntime.dispatch(bundle) → router picks a next-hop peer.
2. BleTransport.send(bundle, peer_id) returns { kind: 'UNAVAILABLE' }
   OR { kind: 'NO_PEER' }.
3. NodeRuntime catches the UNAVAILABLE/NO_PEER result and stores the
   bundle via BundleStore.store(bundle, next_hop: peer_id, state: QUEUED).
4. The TTL sweeper periodically re-attempts delivery:
   - For each QUEUED bundle in the store, try the next-hop peer again.
   - If now reachable: send → on success, transition to RELAYED.
   - If still unreachable: leave as QUEUED; the bundle's TTL will
     eventually expire it (transition to EXPIRED).
5. If the bundle's TTL expires: transition to EXPIRED, emit a
   DeliveryEvent (delivery state machine — Article VI), notify the
   user (via a notification) if the bundle was the sender's.
```

This flow re-uses the existing P3 DTN semantics (ARCH-022 — in-memory
delivery tracker is the LIVE source of truth; DB mirror survives
restarts). The Android `AndroidDeliveryTracker` persists the in-memory
state to Room on every transition so a restart re-hydrates the exact
delivery state.

### 5.3 Bundle deduplication

The existing bundle_id deduplication (canonical UUID per ARCH-024) is
preserved. `AndroidBundleStore` enforces `bundle_id` as the primary key;
a duplicate insert is a no-op (Room `OnConflictStrategy.IGNORE`).

The `ReceivedBundle` table (also mirrors the Prisma schema) tracks
which bundles this node has already received, keyed by
`(node_id, bundle_id)`. A bundle arriving twice is silently dropped
on the second arrival.

### 5.4 TTL sweeper

The TTL sweeper runs every 60 seconds (when the foreground service is
active). It queries `StoredBundle WHERE expires_at < now AND state =
'QUEUED'` and transitions each to EXPIRED. The sweeper emits
`DeliveryEvent`s for forensic audit (ARCH-022).

When the device is in Doze mode (Android 6+) and the system has
deferred the foreground service, the sweeper runs as soon as the device
wakes. Bundles that expired during Doze are batch-transitioned on wake.

---

## 6. Relay Node Behavior

### 6.1 Relay participation

An Android node MAY advertise the `RELAY: STORE` and `RELAY: FORWARD`
capabilities (per `NodeCapabilities.relay`). When advertised:

- The node's `CapabilityAdvertisement` includes `relay: ['STORE',
  'FORWARD']`.
- The routing layer treats this node as a candidate relay hop for OTHER
  peers' bundles (P5 multi-hop BFS — ARCH-030).
- The node itself, when receiving a bundle NOT addressed to its own
  identity, attempts to forward it (per the existing `tryForward()`
  logic in `NodeRuntime`).

### 6.2 RELAY_FORWARD proof signing + authority model (S0.2.6 — strengthened, reviewer point 5)

> **Architecture review concern**: A relay signature should prove something such as "I received/forwarded bundle X at time T". It must NOT imply "I am authorized to speak for sender X" or "I have verified recipient X" or "I am trusted by the recipient." Those remain protocol-level concerns.

#### 6.2.1 What the RELAY_FORWARD proof DOES prove

The canonical payload (per ARCH-023):

```
RELAY_FORWARD|bundle_id|relay_node_id|from_node_id|to_node_id|transport|ts
```

Signed with `nacl.sign.detached(payload, relay_node.signing_secret_key)`.

A valid RELAY_FORWARD signature proves EXACTLY:

| Claim | What it means |
|---|---|
| **Forwarding evidence** | "I, `relay_node_id`, observed bundle `bundle_id` arriving from `from_node_id` on `transport` at time `ts`, and I attempted to forward it to `to_node_id`." |
| **Relay identity** | "I am `relay_node_id` (the node identified by the signing public key)." |
| **Transport observation** | "I observed the bundle on transport `transport`." (e.g., `BLE`, `WIFI`, `LAN`, `INTERNET`) |
| **Timing claim** | "The forwarding event happened at time `ts` (epoch milliseconds)." |

#### 6.2.2 What the RELAY_FORWARD proof does NOT prove

| Non-claim | Why it's not implied |
|---|---|
| **Sender authority** | The relay does NOT verify that `from_node_id` is the actual sender of the bundle. The relay only observed the bundle arriving from `from_node_id`. The sender's signature (`SENDER_SIGNATURE` proof, separate from `RELAY_FORWARD`) is the authoritative claim of sender authority. |
| **Recipient verification** | The relay does NOT verify that `to_node_id` is the actual recipient. The relay only ATTEMPTED to forward to `to_node_id`. Whether `to_node_id` actually received the bundle is recorded in the DeliveryTracker (Article VI), NOT in the RELAY_FORWARD proof. |
| **Trust endorsement** | The relay does NOT assert that `from_node_id` or `to_node_id` is trustworthy. The relay's signature proves ONLY the relay's own observation. Trust is derived from the `verification` ladder (`UNVERIFIED` / `PEER_CORROBORATED` / `TRUSTED`) — see `core/capabilities/types.ts` + THREAT_MODEL. |
| **Authorization grant** | The relay does NOT assert that the sender was authorized to send the bundle. Authorization is checked at the sender's server-action boundary (Articles XII–XIV), NOT at the relay. |
| **Bundle content endorsement** | The relay does NOT assert anything about the bundle's payload (the relay cannot decrypt it — THREAT_MODEL §1). The relay's signature proves ONLY that the relay forwarded opaque bytes matching `bundle_id`. |

#### 6.2.3 The authority hierarchy

```
Intent (Article III)
    ↓
Identity (Article II) — sender proves identity via SENDER_SIGNATURE
    ↓
Bundle (Article IV) — bundle is the fundamental routable object
    ↓
Routing (Article V) — router picks hops based on capabilities
    ↓
Transport (Article I.2) — transport carries opaque bytes
    ↓
RELAY_FORWARD proof — relay proves forwarding evidence, NOTHING MORE
```

The RELAY_FORWARD proof is at the BOTTOM of the hierarchy. It cannot assert anything about the layers above it.

#### 6.2.4 Keystore storage

The Android node's signing secret key is stored in the Android Keystore (`KeyStore.getInstance("AndroidKeychain")`) — never leaves the secure enclave. The public key is exported and shared via the IdentityGraph.

The runtime accesses the key via `BiometricPrompt` (or device authentication) for each signature operation. The runtime does NOT cache the signing secret key in process memory beyond the duration of a single signature operation (per §1.3.3 R4).

#### 6.2.5 Verification by the recipient

The recipient verifies the entire proof chain via the existing `verifyProof()` in `core/trust/Proof.ts`:

1. `SENDER_SIGNATURE` — proves the sender's identity and the bundle's integrity.
2. `RELAY_FORWARD` (one per relay hop) — proves each relay observed and forwarded the bundle.
3. The chain is ordered by `ts` — out-of-order chains are rejected.
4. The recipient trusts the chain ONLY to the extent of the `verification` ladder — a chain of `UNVERIFIED` relays is weaker than a chain of `TRUSTED` relays.

The RELAY_FORWARD proof does NOT make the recipient trust the relay. It lets the recipient reconstruct the path the bundle took — useful for forensic audit and for adjusting future routing decisions (P9 resource-aware routing — ARCH-035).

### 6.3 Relay forwarding rules

- A relay MUST NOT decrypt the bundle — it forwards opaque bytes
  (THREAT_MODEL §1).
- A relay MUST NOT modify the bundle — only append to `proofs[]`.
- A relay MUST honor the bundle's `routing_policy.replication_factor`
  (ARCH-024) — fan out to N peers in parallel.
- A relay MUST honor the bundle's TTL — if TTL expired during relay,
  transition to EXPIRED, do NOT forward.
- A relay MUST verify the sender's signature before forwarding —
  invalid signature → reject the bundle, log `SignatureInvalid`, do
  NOT forward (THREAT_MODEL §16: identity impersonation).

### 6.4 Resource-aware relay behavior

The Android node uses `ResourceMonitor` (battery, storage, bandwidth)
to dynamically decide whether to advertise relay capabilities:

- Battery > 50%: advertise `RELAY: STORE` + `RELAY: FORWARD`.
- Battery 20-50%: advertise `RELAY: FORWARD` only (store-carry-forward
  drains battery too quickly).
- Battery ≤ 20%: do NOT advertise relay capabilities. The node still
  receives bundles addressed to itself, but does NOT relay for others.
- Storage < 10 MB free: do NOT advertise `RELAY: STORE` (would fill
  the device).

The routing layer's `computeHopMetrics()` (ARCH-035) reads these
resource reports and adjusts the per-hop reliability/latency/cost
estimates — high-battery relays rank higher than low-battery relays
for DTN delivery.

---

## 7. Security Model

### 7.1 Threat model (cross-reference)

The existing THREAT_MODEL.md already defines:

- §1: Channel adapters do NOT learn payload contents — same applies
  to transports.
- §9: Treat relays, gateways, channel adapters, and external channels
  as potentially malicious.
- §16: Identity impersonation — solved by IdentityGraph + signed
  CHANNEL_OWNERSHIP proofs.

P4 adds no new threats — the threats are the same; only the transport
layer changes.

### 7.2 Two-layer encryption invariant (S0.2.6 — strengthened, reviewer point 4)

> **Architecture review concern**: "Encrypted sessions" needs two-layer separation. The invariant must be explicit: transport/session encryption ≠ Bundle end-to-end encryption. A relay must be able to forward an opaque bundle without possessing the bundle decryption key.

#### 7.2.1 The two layers

The P4 design has TWO cryptographically independent encryption layers. They MUST NOT be conflated.

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: Bundle end-to-end encryption (FROZEN — Article IX)    │
│  ─────────────────────────────────────────────────────────────  │
│  • Algorithm: X25519 sealed-box (libsodium via tweetnacl)        │
│  • Keys: recipient's X25519 encryption pubkey (looked up via    │
│    IdentityGraph.resolveChannelRecipient() — Article XIV §2).  │
│  • Lifecycle: per-bundle, sealed at dispatch, opened only by    │
│    the recipient's X25519 secret key (in the Android Keystore   │
│    for the recipient, or in src/lib/auth.ts for the web build). │
│  • Code path: core/trust/CryptoEnvelope.ts → sealPayload() /    │
│    openSealedPayload().                                          │
│  • Frozen invariant: Article IX + ARCH-014 (established crypto │
│    only).                                                        │
└─────────────────────────────────────────────────────────────────┘

                            (independent — the relay sees opaque
                             ciphertext from Layer 1; Layer 2
                             encrypts the LINK, not the bundle)

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2: Transport session encryption (P4 — link layer)        │
│  ─────────────────────────────────────────────────────────────  │
│  • BLE: LE Secure Connections (ECDH key exchange during        │
│    pairing, AES-CCM link-layer encryption).                     │
│  • Wi-Fi Direct: WPS group passphrase → WPA2-Personal (AES-    │
│    CCMP) link encryption.                                        │
│  • Keys: per-session, established during pairing / group       │
│    formation, rotated on reconnection.                          │
│  • Lifecycle: per-transport-session, torn down on close() /     │
│    peer disconnect.                                             │
│  • Code path: the transport's internal pairing code (BLE) /     │
│    WifiP2pManager group config (Wi-Fi Direct).                   │
│  • Frozen invariant: Article XVIII §8 (link-layer encryption   │
│    INDEPENDENT of bundle e2e encryption).                       │
└─────────────────────────────────────────────────────────────────┘
```

#### 7.2.2 The relay invariant (the architecturally critical property)

A relay MUST be able to forward an opaque bundle without possessing the bundle decryption key. This means:

```
Alice (sender)
    ↓ seals bundle to Bob's X25519 pubkey (Layer 1)
    ↓ Alice's BLE adapter sends opaque ciphertext over BLE session (Layer 2)
Relay (e.g., Android relay node)
    ↓ receives opaque ciphertext (cannot decrypt — does NOT have Bob's secret key)
    ↓ RELAY_FORWARD proof signed by relay's Ed25519 key (proves forwarding evidence only — §6.2)
    ↓ relay's Wi-Fi Direct adapter sends opaque ciphertext over Wi-Fi session (Layer 2)
Bob (recipient)
    ↓ receives opaque ciphertext
    ↓ opens sealed payload with Bob's X25519 secret key (Layer 1) — in Bob's Keystore
    ↓ verifies SENDER_SIGNATURE + all RELAY_FORWARD proofs in the chain
```

The relay participates at Layer 2 only. The relay NEVER possesses Layer 1 keys. A compromised relay learns ONLY: the bundle_id (UUID, not the payload), the routing path (from_node_id, to_node_id, transport), and the timing (ts). The payload remains sealed.

#### 7.2.3 What this means for the Android relay

The Android relay node's `RELAY_FORWARD` proof signing key (Ed25519, in Keystore) is INDEPENDENT of any bundle decryption key. The relay's Keystore contains:
- The Ed25519 signing keypair (for RELAY_FORWARD proofs + capability advertisement signatures).
- (Optional) the relay's own X25519 keypair — used ONLY to RECEIVE bundles addressed to the relay itself, NOT to forward other peers' bundles.

The relay does NOT hold keys for any other identity. A relay that holds Bob's X25519 secret key would be a violation of THREAT_MODEL §1 (channel adapters / transports / relays do NOT learn payload contents). The Android Keystore enforces this — only the identity owner can import their own X25519 key.

#### 7.2.4 Compromise analysis

| Compromise | What the attacker learns | What the attacker does NOT learn |
|---|---|---|
| BLE link compromised (Layer 2 broken) | Opaque bundle ciphertext, bundle_id, relay path, timing. | Bundle payload (still sealed by Layer 1). |
| Wi-Fi Direct link compromised | Same as above. | Bundle payload. |
| Relay node compromised (full disk access) | Relay's Ed25519 signing key (can forge RELAY_FORWARD proofs — but those prove only forwarding evidence, not sender authority per §6.2). Bundle metadata (bundle_id, from, to). Opaque ciphertext for bundles in transit. | Bundle payloads (sealed by Layer 1 to recipients' keys, NOT the relay's key). Other identities' X25519 secret keys. |
| Sender's device compromised | Sender's Ed25519 signing key (can forge SENDER_SIGNATURE — but that's the sender's own authority, not a relay concern). Sender's X25519 secret key (can decrypt bundles addressed to the sender). | Other identities' keys. |
| Recipient's device compromised | Recipient's X25519 secret key (can decrypt bundles addressed to the recipient). | Other identities' keys. |

The architecture defends against the relay compromise by design — the relay never holds the recipient's key.

#### 7.2.5 Why this is a property, not a feature

This two-layer separation is NOT a security feature that could be added later. It is a structural property of the architecture. Removing it would require:
1. Redefining the `CommunicationBundle.encryption_metadata` (Article IV — frozen).
2. Sharing the recipient's X25519 secret key with relays (THREAT_MODEL §1 — frozen).
3. Introducing new cryptographic primitives (Article IX — frozen).

Each of these is a frozen-invariant violation. The two-layer separation is non-negotiable.

### 7.3 Per-transport key exchange (Layer 2 specifics)

#### 7.3.1 BLE — LE Secure Connections

BLE 4.2+ supports LE Secure Connections (Elliptic Curve Diffie-Hellman key exchange). The adapter requires LE Secure Connections for pairing — falls back to Legacy Pairing only if the peer doesn't support it (with `authMethod: 'LEGACY'` flagged in the peer registry, used by the routing layer to penalize the peer's `verification` field).

#### 7.3.2 Wi-Fi Direct — WPS + WPA2-Personal

WPS push-button configuration is used to establish the group passphrase. The group passphrase is generated randomly per group (32 bytes from `SecureRandom`) and stored in `EncryptedSharedPreferences`. The link is encrypted with WPA2-Personal (AES-CCMP) once the group is formed.

#### 7.3.3 Link-layer compromise does NOT compromise bundle payloads

Per §7.2.4 — a compromised BLE link or Wi-Fi Direct group learns opaque ciphertext only. The bundle payload remains sealed until the recipient decrypts it with their X25519 secret key (Layer 1).

### 7.4 Pairing models (BLE)

The BLE adapter supports the four Bluetooth pairing models, in order
of preference:

1. **Numeric Comparison** (BLE 4.2+): both devices display a 6-digit
   code; user confirms match. Most secure for screens.
2. **Passkey Entry**: one device displays a 6-digit code; user enters
   it on the other. Used when only one device has a display.
3. **Out of Band (OOB)**: pairing data exchanged via NFC or QR code.
   Deferred to P4.x (NFC transport).
4. **Just Works**: no user confirmation. Used as a last resort for
   headless devices. Flagged as `authMethod: 'JUST_WORKS'` in the peer
   registry — the routing layer treats these peers as
   `verification: 'UNVERIFIED'` (per the existing `PeerCapabilities`
   type).

### 7.5 Replay protection

The existing bundle's `bundle_id` (canonical UUID per ARCH-024) is the
replay protection at the application layer — a relay that re-sends a
bundle is silently dropped by the recipient's dedup logic.

At the transport layer, the BLE/Wi-Fi Direct adapter adds a
per-connection nonce (4 bytes, monotonic per connection) to each chunk
header. This protects against replay within a single GATT/TCP session.
The nonce resets on reconnection (a new session = new nonce space).

### 7.6 Trust model

The transport layer does NOT modify the existing trust model
(Article IX). All signatures go through `core/trust/Proof.ts` —
`signProof()` for signing, `verifyProof()` for verification. No new
signature algorithms. No new key types. No new hash functions.

The Android Keystore stores the node's Ed25519 signing secret key; the
public key is exported via `IdentityGraph`. This is a deployment
choice (where the key lives), NOT an architecture change.

---

## 8. Battery / Resource Model

### 8.1 Power policy

`PowerPolicy.kt` reads the battery level from `BatteryManager` and
applies the following duty cycles:

| Battery | BLE Advertise Interval | BLE Scan Window | Wi-Fi Direct Discover | Relay Advertise |
|---|---|---|---|---|
| Plugged in | 100 ms | continuous | every 10 s | STORE + FORWARD |
| > 50% | 1000 ms | 60 s on / 60 s off | every 10 s | STORE + FORWARD |
| 20-50% | 5000 ms | 10 s on / 110 s off | every 30 s | FORWARD only |
| ≤ 20% | OFF | 5 s on / 595 s off | OFF | OFF |
| Doze mode | OFF | OFF | OFF | (suspended; resume on wake) |

These thresholds are configurable via `NodeCapabilities.resource` and
the existing `computeHopMetrics()` (ARCH-035) routing logic.

### 8.2 Resource reporting

The Android node reports resources via the existing
`NodeCapabilities.resource` field (defined in
`core/capabilities/types.ts`):

```typescript
{
  bandwidth_bps: <measured BLE/Wi-Fi Direct throughput, running average>,
  storage_bytes: <free bytes on the BundleStore's SQLite volume>,
  battery_pct: <0-100 from BatteryManager>,
  compute_units: <relative; Android uses # CPU cores * clock GHz>,
  sampled_at: <Date.now()>
}
```

`ResourceMonitor.kt` samples these every 30 seconds and updates the
node's `CapabilityAdvertisement`. The gossiped advertisement carries
these to peers, where the routing layer uses them to plan routes that
prefer high-battery / high-bandwidth peers (ARCH-035/036).

### 8.3 Doze mode

Android 6+ Doze mode defers background work. The foreground service
exemption applies only while the service is running. When the device
enters Doze:

- BLE advertising is suspended (the system saves power).
- BLE scanning is suspended.
- Wi-Fi Direct discovery is suspended.
- The TTL sweeper is suspended (will run on the next maintenance
  window or on wake).
- The foreground service notification remains visible to the user.
- On wake (the user picks up the device, or a maintenance window
  opens), all suspended activities resume.

The BundleStore persists all QUEUED bundles across Doze. No bundles are
lost — only delivery is deferred.

### 8.4 Background scan limits

Android 11+ limits background BLE scanning to a few scans per 30
minutes. The P4 adapter uses a foreground service specifically to
exempt itself from this limit. If the foreground service is killed
(e.g., user revokes notification permission), the adapter falls back
to WorkManager-triggered scans (every 15 minutes) — relay
participation is degraded but not lost.

---

## 9. Failure Handling

### 9.1 Failure categories

| Category | Examples | Handling |
|---|---|---|
| Transient transport failure | GATT write failed (code 19); Wi-Fi Direct group formation timeout | Retry up to 3 times with exponential backoff (100 ms, 500 ms, 2 s). If still failing, return `{ kind: 'ERROR'; reason: '...' }`. The NodeRuntime stores the bundle for later retry (§5.2). |
| Peer unreachable | `NO_PEER` from send() | NodeRuntime stores the bundle in BundleStore; TTL sweeper re-attempts. |
| Transport unavailable | Bluetooth radio off; Wi-Fi off; airplane mode | `isAvailable()` returns false. NodeRuntime routes via other transports; if none, stores bundle. |
| Connection drop | Peer disconnected mid-bundle | Abort the in-progress send; return ERROR. The partially-sent chunks are discarded by the receiver (out-of-order detection in §3.7). |
| MTU negotiation failure | Peer refuses MTU > 23 | Fall back to 20-byte chunks (default MTU minus 3 ATT header). Slow but functional. |
| GATT service not found | Peer is not a CommOS node | Disconnect; do NOT add to peer registry. |
| Pairing failure | User rejected pairing dialog | Disconnect; mark peer as `unpairable` for 5 minutes (rate limit). |
| Keystore access failure | Biometric prompt dismissed | Refuse to sign RELAY_FORWARD proofs; advertise `relay: []` until Keystore is unlocked. |
| Storage exhausted | SQLite insert fails (disk full) | Refuse to store new bundles; advertise `relay: ['FORWARD']` only (drop STORE). |
| Permission revoked | User revoked BLUETOOTH_SCAN at runtime | Stop foreground service; show user a dialog explaining the consequence. |
| App killed by OS | System OOM killer | On restart, re-hydrate NodeRuntime state from BundleStore + AndroidDeliveryTracker. No data loss. |
| Device reboot | User rebooted | Boot receiver (`BroadcastReceiver` on `BOOT_COMPLETED`) restarts `CommOsService` if it was running before reboot (preference persisted). |

### 9.2 Exception discipline (Article XVIII §2)

Transports MUST NOT throw exceptions across the `Transport` interface
boundary. Internal exceptions are caught and translated to
`TransportSendResult = { kind: 'ERROR'; reason: string }`.

This is enforced by the TypeScript type system: the `Transport`
interface's `send()` returns `Promise<TransportSendResult>`, NOT
`Promise<TransportSendResult> | never`. A transport implementation
that throws violates the interface contract.

### 9.3 Logging

Transports log via the existing `TransportEventSink` in
`core/transport/TransportEvent.ts`. Events:

- `transport_up` / `transport_down` (radio on/off).
- `bundle_forwarded` / `bundle_received` (per-bundle).
- `peer_connected` / `peer_disconnected` (peer registry changes).
- `error` (with reason string — never the exception object).

Events are observable in the UI debug console (existing in
`src/app/page.tsx`).

### 9.4 Crash recovery

The foreground service runs in the main app process. If the app
crashes:

- The service is restarted by Android (foreground services are
  high-priority).
- `NodeRuntimeHost.kt` re-creates the NodeRuntime.
- `AndroidBundleStore` re-hydrates QUEUED bundles.
- `AndroidDeliveryTracker` re-hydrates delivery state.
- The BLE/Wi-Fi Direct adapters re-establish connections to known
  peers (peer registry is persisted in SharedPreferences).

No bundles are lost on crash. In-flight bundles that were being sent
when the crash occurred are stored as QUEUED and re-attempted.

---

## 10. Testing Strategy

### 10.1 Test pyramid

| Layer | Tests | Tools | Purpose |
|---|---|---|---|
| Unit | Transport interface contract tests | vitest (existing) | Prove the BLE/Wi-Fi Direct adapters conform to the `Transport` interface (4 methods, no exceptions, TransportSendResult union). |
| Unit | Chunking + reassembly | vitest | Prove bundle chunking + reassembly handles all edge cases (out-of-order, gaps, MTU boundaries, multi-bundle interleaving). |
| Unit | Resource policy | vitest | Prove the duty-cycle table in §8 is enforced (battery thresholds, scan windows, relay advertise rules). |
| Integration | Android Robolectric | Robolectric 4.x | Mock BluetoothLeScanner + WifiP2pManager; verify the adapter's lifecycle, peer registry, and send/receive flows. |
| Integration | Two-emulator e2e | Android Emulator + `adb` | Real BLE between two emulators (limited — emulators don't fully support BLE). Wi-Fi Direct between two emulators (limited). Use a physical device pair for full e2e. |
| Hardware-in-the-loop | Two physical Android devices | Manual test plan | Full BLE + Wi-Fi Direct bundle round-trip between two real devices. Required before any P4 release. |
| Failure injection | vitest + Robolectric | MockBluetoothLeScanner that throws on demand | Prove each §9 failure category produces the correct `TransportSendResult` kind + reason. |
| Cold start | vitest + Robolectric | Kill + restart NodeRuntimeHost | Prove BundleStore + DeliveryTracker re-hydrate correctly. |
| Architecture boundary | vitest (existing `boundaries.test.ts`) | Static AST scan | Prove `src/transport/ble/*` and `src/transport/wifidirect/*` do NOT import from `@/adapters/*`, `@/matrix/*`, `@/components/*`, `next`, `react`, `@prisma/client` (Article I). |
| Constitution | vitest (existing + new Article XVIII tests) | Static AST scan | Prove no hardware adapter modifies a frozen invariant (Bundle format, IdentityGraph, VerificationState, Authorization, Trust, Delivery, Truth Gate, Evidence Gate). |

### 10.2 Test fixtures

- A `MockBleTransport` that implements `Transport` and simulates BLE
  behavior (peer registry, chunking, GATT failures on demand) — used
  in unit + integration tests.
- A `MockWifiDirectTransport` with the same shape.
- Both implement the duck-typed `gossip()` / `onGossip()` side-channel
  (ARCH-031) — proven by the existing P5 multi-hop tests.

### 10.3 Acceptance criteria

P4 is COMPLETE when ALL of the following are true:

1. Two physical Android devices can exchange a Communication Bundle over
   BLE with no Internet connectivity.
2. Two physical Android devices can exchange a Communication Bundle over
   Wi-Fi Direct with no Internet connectivity.
3. An Android device can act as a relay for a third device's bundle
   (proven by a 3-device test: A → Android-relay → B).
4. The Android node's RELAY_FORWARD proofs are verifiable by the
   existing `verifyProof()` in `core/trust/Proof.ts`.
5. The Android node's BundleStore persists QUEUED bundles across a
   reboot; on restart, the TTL sweeper continues expiring them.
6. The Android node reports battery/storage/bandwidth via the existing
   `NodeCapabilities.resource` field; the routing layer prefers high-
   battery peers (ARCH-035).
7. The architecture boundary tests (Article I) pass — `src/transport/ble`
   and `src/transport/wifidirect` import ONLY from `@/core/*` and
   `@/transport/loopback` (for shared utilities, if any).
8. Article XVIII acceptance tests pass — no hardware adapter modifies
   any frozen invariant.
9. The Repository Truth Gate (Article XVI) passes at the P4 final
   commit — `local HEAD == origin/main HEAD == tested SHA`.
10. The Execution Evidence Gate (Article XVII) passes — `EXECUTION
    EVIDENCE STATUS: VALID` at the P4 final commit.

### 10.4 Out-of-scope tests

- NFC transport tests (NFC is P4.x).
- iOS support tests (iOS is a separate sprint).
- BLE mesh tests (BLE mesh is P4.x).
- Tests against real Bluetooth hardware on CI (CI does not have
  Bluetooth; physical-device tests are run manually before release).

---

## 11. Frozen Invariants Cross-Reference (final check)

| Frozen Invariant | Article | Touched by P4? | Why not? |
|---|---|---|---|
| CommunicationBundle format | IV | NO | P4 transports receive opaque bundles; they do not interpret or reformat. |
| Universal Identity | II | NO | P4 transports learn `to_node_id` from the routing layer, not the identity layer. |
| Communication Intent | III | NO | P4 transports do not see the intent — it is part of the bundle payload. |
| Routing (capabilities, not device types) | V | NO | P4 transports register capabilities via the existing `NodeCapabilities` type; the router reasons over those. |
| Delivery Semantics | VI | NO | P4 transports return `TransportSendResult`; the NodeRuntime translates to the delivery state machine. |
| DTN / Matrix Roles | VII | NO | P4 transports are DTN — they enable offline operation per Article VII. |
| Channel Adapters | VIII | NO | P4 transports are NOT channel adapters; they are transport adapters. Channel adapters (Email, SMS, WhatsApp) remain unchanged. |
| Security & Trust | IX | NO | P4 transports re-use `CryptoEnvelope` and `Proof` from `core/trust/`. No new crypto. |
| No Fake Implementations | X | NO | P4 transports are REAL — they use real BluetoothLeScanner / WifiP2pManager APIs. The MockBleTransport is clearly named and lives in `tests/`. |
| Hardening Mode | XI | NO | P4 is a feature sprint (new transports), not a hardening sprint. |
| Authentication vs Authorization | XII | NO | P4 transports run AFTER the server-action authorization boundary; the authorization is unchanged. |
| Separate Authorization Dimensions | XIII | NO | P4 does not change resource visibility classes or roles. |
| Authorization State ≠ Resource State | XIV | NO | P4 does not change the IdentityLink state machine. |
| IdentityLink State Machine is Canonical | XV | NO | P4 does not touch the canonical state machine module. |
| Repository Truth Gate | XVI | NO | P4 implementation commits will satisfy the gate like any other change. |
| Execution Evidence Integrity | XVII | NO | P4 implementation milestone report will include EXECUTION EVIDENCE STATUS: VALID. |
| Hardware Boundary Integrity | XVIII (new) | N/A — P4 is the first transport milestone governed by this article. | The article is added in this design doc. |

---

## 12. Implementation Plan (post-approval)

### 12.1 Phases

| Phase | Scope | Estimated tests | Depends on |
|---|---|---|---|
| P4.1 | BLE adapter — GATT service + chunking + reassembly (single device, loopback to self) | ~30 unit tests | This design doc approval. |
| P4.2 | BLE adapter — two-emulator e2e + Robolectric integration | ~15 integration tests | P4.1. |
| P4.3 | Wi-Fi Direct adapter — TCP server + client + group formation | ~25 unit + integration tests | P4.1. |
| P4.4 | AndroidBundleStore + AndroidDeliveryTracker (Room/SQLite) | ~15 unit tests + cold-start tests | P4.1. |
| P4.5 | PowerPolicy + ResourceMonitor + gossiped resource reports | ~10 unit tests | P4.4. |
| P4.6 | Relay participation — RELAY_FORWARD proof signing via Android Keystore | ~10 unit tests + 1 hardware-in-the-loop test | P4.2 + P4.3. |
| P4.7 | Article XVIII acceptance tests + final gate run | ~12 architecture tests | All above. |

### 12.2 Per-phase governance

Each phase ends with:
1. `bash scripts/repo-truth-gate.sh MAIN_MILESTONE P4.<phase>` —
   proving the SHA equality invariant.
2. `bash scripts/generate-execution-evidence.sh P4.<phase>` —
   producing the execution evidence manifest.
3. `bash scripts/verify-execution-evidence.sh` — verifying the
   manifest.
4. The phase's COMMIT REPORT in the worklog, including the EXECUTION
   EVIDENCE STATUS: VALID line.

A phase is NOT complete without all four. (Same governance as S0.x.)

### 12.3 Acceptance gate

P4 is COMPLETE only when the §10.3 acceptance criteria (all 10) are
satisfied AND the final `bash scripts/repo-truth-gate.sh
MAIN_MILESTONE P4` produces MATCH: YES and EXECUTION EVIDENCE STATUS:
VALID.

---

## 13. Open Questions (for architecture review) — S0.2.6 revised

> **Architecture review concern (reviewer point 8)**: The original §13 mixed architecture questions with implementation-detail questions (port 7878, BLE header size, SIG alias). The architecture review should concentrate on invariants and boundaries. Implementation details are P4.1+ questions, NOT architecture-review blockers.

### 13.1 The 7 architecture-level questions (must be resolved before P4.1)

These are the questions the architecture review MUST resolve. Each is an invariant / boundary question, not an implementation-detail question.

#### Q1. What exactly is the Android runtime boundary?

§1.3 lays out three options (React Native + JSI / Node.js Mobile + N-API / Native Kotlin port). The review must pick one AND confirm the 7 runtime-boundary invariants (R1-R7 in §1.3.3) are satisfiable in that choice.

Sub-questions to answer in the review:
- Can the chosen option satisfy R1 (process death recovery)? How?
- Can the chosen option satisfy R2 (background execution with foreground service)? How?
- Can the chosen option satisfy R4 (Android Keystore access for Ed25519 signing)? How?
- Can the chosen option satisfy R6 (single-threaded event loop, no concurrent state mutations)? How?

#### Q2. How is protocol state persisted across process death?

§5.1.3 P6 (crash consistency) requires that a crash mid-write leaves the database in a consistent state. The review must confirm:
- The persistence impl uses transactions / WAL to guarantee P6.
- The re-hydration path on restart (§1.3.3 R3) reads the persisted state and reconstructs the in-memory cache deterministically.
- The re-hydration is tested (R3 test in §1.3.3).

#### Q3. How are bundle encryption and transport encryption separated?

§7.2 codifies the two-layer separation. The review must confirm:
- Layer 1 (bundle e2e via `CryptoEnvelope`) is the ONLY mechanism that encrypts bundle payloads.
- Layer 2 (BLE LE Secure Connections / Wi-Fi Direct WPA2) encrypts the LINK only.
- The relay (§7.2.2) forwards opaque ciphertext without possessing Layer 1 keys.
- The compromise analysis (§7.2.4) is sound.

#### Q4. What exactly may relay/gossip metadata assert?

§6.2 (relay signature authority) + §2.5 (gossip boundary) codify the limits:
- RELAY_FORWARD proves ONLY forwarding evidence (§6.2.1).
- RELAY_FORWARD does NOT prove sender authority, recipient verification, trust endorsement, authorization, or bundle content endorsement (§6.2.2).
- Gossip payloads are limited to acceptable kinds (§2.5 G1.1) — forbidden kinds (§2.5 G1.2) trigger architecture-control defects.

The review must confirm these limits are sufficient AND are enforced by tests.

#### Q5. What guarantees survive offline forwarding?

§5.2 (store-and-forward) + §6.3 (relay forwarding rules) define what survives offline:
- Bundle integrity (the bundle's bytes are NOT modified during offline storage or forwarding).
- Bundle TTL (a bundle past its TTL transitions to EXPIRED, NOT forwarded).
- Bundle deduplication (the recipient drops duplicate deliveries via `bundle_id`).
- RELAY_FORWARD chain (the recipient can reconstruct the path the bundle took).

The review must confirm these guarantees hold even when:
- The relay is offline for hours/days before forwarding.
- The relay's storage is full (P3 in §5.1.3 — relay MUST drop STORE advertise but still forward).
- The relay crashes mid-forward (P6 in §5.1.3 — crash consistency).

#### Q6. What is the authoritative delivery-state transition mechanism?

§1.3.3 R7 + §5.1.3 P4 codify: every state transition goes through `core/delivery/DeliveryTracker.transition()`. The review must confirm:
- No transport, no persistence impl, no relay code mutates the delivery state directly.
- The TTL sweeper uses `transition()`, not a direct DB write.
- The Android `AndroidDeliveryTracker` wraps the same `transition()` (via TS↔Kotlin bridge for Option A/B, or a Kotlin port that calls the same transition logic for Option C).

#### Q7. How does Android resource pressure affect participation without changing protocol semantics?

§6.4 (resource-aware relay behavior) + §8 (battery/resource model) define how the Android node scales participation with resources:
- Battery > 50%: full relay (STORE + FORWARD).
- Battery 20-50%: FORWARD only.
- Battery ≤ 20%: no relay advertise (still receives bundles addressed to itself).
- Storage < 10 MB: drop STORE advertise.

The review must confirm:
- These thresholds are CAPABILITY ADVERTISEMENTS (in `NodeCapabilities.relay` + `NodeCapabilities.resource`), NOT protocol state changes.
- The routing layer (P9 — ARCH-035) uses these advertisements to make routing decisions; it does NOT change protocol semantics.
- A low-battery node is still a valid protocol participant — it just advertises fewer capabilities. The protocol treats it the same as a high-battery node with manually-disabled relay.

### 13.2 Implementation-detail questions (deferred to P4.1, NOT architecture-review blockers)

The following are implementation details that the P4.1 (BLE adapter) implementation team will resolve. They do NOT affect frozen contracts and do NOT require architecture-review approval.

| Question | Why it's an implementation detail |
|---|---|
| Wi-Fi Direct port 7878 vs. another port | Doesn't affect any frozen contract; the port is configurable. |
| BLE chunking header: 4-byte sequence + 1-byte flag vs. 1+1 | Doesn't affect any frozen contract; the framing is internal to the BLE transport per §2.4 T2 (per-transport). The choice is bounded by §2.4 T3 (framing MUST NOT alter bundle semantics). |
| BLE service UUID: random v4 vs. official 16-bit SIG alias | Doesn't affect any frozen contract; the UUID is configurable. Cost-benefit (SIG fee vs. shorter advertising packets) is a deployment decision. |
| Foreground service subtype on Android 14+ (`CONNECTED_DEVICE` vs. `DATA_SYNC`) | Doesn't affect any frozen contract; the Android platform may revise the subtype requirement in a future OS version. |
| `ACCESS_FINE_LOCATION` privacy policy | Doesn't affect any frozen contract; the privacy policy is a deployment artifact. |
| BLE mesh vs. point-to-point | P4.x decision; doesn't affect P4 scope. |

These will be resolved by the P4.1 implementation team and recorded in the worklog. They are NOT blockers for the architecture review.

### 13.3 Resolution process

The 7 architecture-level questions in §13.1 will be resolved by the architecture reviewer's response to this design document. The resolutions will be:
1. Recorded in the worklog under S0.2.7 (Architecture Review Resolutions).
2. Mirrored into the design document (this file) by appending a §13.4 "Resolutions" subsection.
3. Used to update Article XVIII / ARCH-053 if any resolution requires a new invariant.

Only after the 7 questions are resolved may P4.1 (BLE adapter) begin.

---

## 14. References

- Architecture Constitution Articles I–XVII (frozen).
- Article XVIII (new, added in this design doc) — Hardware Boundary
  Integrity.
- ARCH-001..052 (existing) + ARCH-053 (new, added in this design doc).
- THREAT_MODEL.md (existing).
- ROADMAP.md (existing).
- `src/core/transport/Transport.ts` — the Transport interface contract.
- `src/transport/loopback/LoopbackTransport.ts` — the reference impl.
- `src/core/capabilities/types.ts` — `NodeCapabilities`,
  `ResourceReport`, `TransportCapabilityType` (includes `BLE`, `WIFI`,
  `WIFI_AWARE`).
- `src/core/routing/types.ts` — `RouteHop`, `RoutePlan`,
  `PeerCapabilities`.
- `src/server/NodeRuntime.ts` — `BundleStore` interface, TTL sweeper.
- `prisma/schema.prisma` — `StoredBundle`, `ReceivedBundle`,
  `DeliveryEvent` (Android mirrors these in Room/SQLite).
