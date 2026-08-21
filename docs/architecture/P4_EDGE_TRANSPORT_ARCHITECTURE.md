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

### 1.3 TypeScript ↔ Kotlin bridge

The existing `NodeRuntime` is TypeScript (runs under Node.js / Bun in the
web build). For Android, two options:

1. **React Native + JSI** — reuse the existing TS code unchanged; expose
   BLE/Wi-Fi Direct via JSI native modules. Fastest path, reuses test
   suite, but adds React Native dependency.
2. **Native Kotlin port** — re-implement `NodeRuntime` in Kotlin. More
   work, but no Node.js runtime on-device (smaller binary, no JIT).

**Decision**: Option 1 (React Native + JSI). Rationale: the existing
TypeScript `core/*` is boundary-tested; a port would risk divergence.
The TS code is the canonical implementation; the Android port is a
deployment choice, not an architecture change. The JSI native modules
implement `Transport` in Kotlin and expose it to TS as a JavaScript
object that conforms to the `Transport` interface.

The TS-side code remains unchanged: `createNodeRuntime({ transports:
[bleTransport, wifiDirectTransport] })` works exactly as it does for
LoopbackTransport.

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

### 2.2 What hardware adapters MAY do

- Implement the 4 `Transport` methods using platform-specific APIs
  (BluetoothLeScanner, BluetoothGattServer, WifiP2pManager).
- Add the duck-typed `gossip()` / `onGossip()` side-channel methods
  (ARCH-031) — the NodeRuntime casts to access them.
- Add internal state (peer registries, GATT connections, scan windows)
  that is invisible to the `core/*` layer.
- Report `ResourceReport` fields (`battery_pct`, `bandwidth_bps`,
  `storage_bytes`) via the existing `NodeCapabilities.resource` field —
  the routing layer already consumes these (ARCH-035).

### 2.3 What hardware adapters MUST NOT do (Article XVIII)

- MUST NOT redefine the `Transport` interface — only implement it.
- MUST NOT introduce new `TransportSendResult` kinds — the 4 kinds are
  canonical.
- MUST NOT decrypt or interpret bundle contents — bundles are opaque
  bytes (THREAT_MODEL §1: channel adapters do NOT learn payload
  contents; same rule applies to transports).
- MUST NOT bypass the `IdentityGraph` — transports learn `to_node_id`
  from the routing layer, not from the channel identity.
- MUST NOT sign bundles on behalf of the sender — the sender's signing
  key is never shared with transports (ARCH-023).
- MUST NOT invent new cryptographic primitives (Article IX). All crypto
  goes through `core/trust/CryptoEnvelope` and `core/trust/Proof`.
- MUST NOT change the delivery state machine — transports return
  `TransportSendResult`; the `NodeRuntime` translates that into
  `CREATED → ACCEPTED → QUEUED → RELAYED → ...` (Article VI), NOT the
  transport.
- MUST NOT throw exceptions across the interface boundary —
  `send()` returns `{ kind: 'ERROR'; reason: string }`, never throws.
  Internal exceptions are caught inside the transport and surfaced as
  `ERROR`.

### 2.4 Gossip side-channel

P4 transports implement the duck-typed `gossip()` / `onGossip()`
methods (same pattern as `LoopbackTransport`). The NodeRuntime uses
these to push `CapabilityAdvertisement` objects to direct peers.

For BLE, gossip piggybacks on the GATT connection — when a peer connects,
the transport exchanges capability advertisements before any bundle
traffic. For Wi-Fi Direct, gossip runs on the group owner's TCP server
as a small JSON message before the bundle stream.

The Transport interface in `core/transport/Transport.ts` is UNCHANGED
(ARCH-031).

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

### 5.1 BundleStore on Android

The existing `BundleStore` interface (defined in `server/NodeRuntime.ts`)
is implemented for Android by `AndroidBundleStore` (Room/SQLite-backed).

```kotlin
@Entity(tableName = "stored_bundles")
data class StoredBundleEntity(
    @PrimaryKey val bundle_id: String,
    val node_id: String,
    val next_hop: String,
    val bundle_json: String,    // serialized CommunicationBundle
    val priority: String,
    val expires_at: Long,        // epoch milliseconds
    val queued_at: Long,
    val state: String            // "QUEUED" | "RELAYED" | "EXPIRED" | ...
)
```

The schema mirrors the existing Prisma `StoredBundle` model in
`prisma/schema.prisma` — Android uses a local SQLite database (NOT the
Neon PostgreSQL backend, because the device is offline).

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

### 6.2 RELAY_FORWARD proof signing

When the Android node relays a bundle, it signs a RELAY_FORWARD proof
(ARCH-023) using its Ed25519 signing secret key:

```
canonical payload: RELAY_FORWARD|bundle_id|relay_node_id|from_node_id|to_node_id|transport|ts
signature: nacl.sign.detached(payload, relay_node.signing_secret_key)
```

The proof is appended to `bundle.proofs[]` and forwarded to the next
hop. The recipient verifies the entire proof chain via the existing
`verifyProof()` in `core/trust/Proof.ts`.

The Android node's signing secret key is stored in the Android Keystore
(`KeyStore.getInstance("AndroidKeychain")`) — never leaves the secure
enclave. The public key is exported and shared via the IdentityGraph.

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

### 7.2 Per-transport key exchange

Bundle payloads are ALREADY end-to-end encrypted via `CryptoEnvelope`
(`sealPayload()` in `core/trust/CryptoEnvelope.ts`). The transport
layer does NOT need to provide additional encryption — the bundle is
opaque ciphertext at the transport layer.

However, the BLE/Wi-Fi Direct LINK itself is not end-to-end encrypted
by default. The transport layer adds link-layer encryption:

- **BLE**: BLE 4.2+ supports LE Secure Connections (Elliptic Curve
  Diffie-Hellman key exchange). The adapter requires LE Secure
  Connections for pairing — falls back to Legacy Pairing only if the
  peer doesn't support it (with `authMethod: 'LEGACY'` flagged in the
  peer registry, used by the routing layer to penalize the peer's
  `verification` field).
- **Wi-Fi Direct**: WPS push-button configuration is used to establish
  the group passphrase. The group passphrase is generated randomly
  per group (32 bytes from `SecureRandom`) and stored in
  `EncryptedSharedPreferences`.

Link-layer encryption is INDEPENDENT of the bundle's end-to-end
encryption. A compromised BLE link does NOT compromise bundle payloads
(they remain sealed until the recipient decrypts them with their X25519
secret key).

### 7.3 Pairing models (BLE)

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

### 7.4 Replay protection

The existing bundle's `bundle_id` (canonical UUID per ARCH-024) is the
replay protection at the application layer — a relay that re-sends a
bundle is silently dropped by the recipient's dedup logic.

At the transport layer, the BLE/Wi-Fi Direct adapter adds a
per-connection nonce (4 bytes, monotonic per connection) to each chunk
header. This protects against replay within a single GATT/TCP session.
The nonce resets on reconnection (a new session = new nonce space).

### 7.5 Trust model

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

## 13. Open Questions (for architecture review)

1. **React Native vs. native Kotlin**: §1.3 picks React Native + JSI.
   Is the React Native dependency acceptable? Alternative: a Kotlin
   port of `NodeRuntime` (cost: ~2 sprints of porting work; benefit:
   no Node.js runtime on-device, smaller binary, no JIT).
2. **BLE service UUID namespace**: §3.1 uses random v4 UUIDs. Should
   the project register an official 16-bit alias with the Bluetooth
   SIG? (Cost: $${SIG fee}; benefit: shorter advertising packets.)
3. **Wi-Fi Direct port 7878**: §4.3 uses port 7878 arbitrarily. Should
   the project register an official IANA port? (Cost: free; benefit:
   no collision risk.)
4. **Foreground service on Android 14+**: §1.1 uses
   `FOREGROUND_SERVICE_CONNECTED_DEVICE`. Is this the correct subtype
   for BLE + Wi-Fi Direct, or should it be
   `FOREGROUND_SERVICE_DATA_SYNC`? Need legal review.
5. **Privacy: ACCESS_FINE_LOCATION**: §1.4 requires
   `ACCESS_FINE_LOCATION` for Wi-Fi Direct peer discovery. The user
   will see this permission request. Is the privacy policy clear
   enough about why?
6. **BLE mesh vs. point-to-point**: §0 defers BLE mesh to P4.x. Is
   point-to-point sufficient for the P4 use cases (e.g., 3-device
   relay test in §10.3 #3)? Yes, because multi-hop routing (P5) handles
   the topology — BLE mesh is a hardware-level optimization, not a
   routing requirement.
7. **Bundle chunking over BLE**: §3.2 uses 4-byte sequence + 1-byte
   flag headers. Should the header be smaller (e.g., 1-byte sequence
   + 1-byte flag, accepting ≤256 chunks per bundle)? Trade-off:
   smaller header = more payload per chunk, but limits to 256 chunks
   = ~256 × 508 = 130 KB max bundle. The current 4-byte sequence
   allows ~4 billion chunks — overkill but safe.

These questions are for the architecture review. Resolutions will be
recorded in the worklog before P4.1 begins.

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
