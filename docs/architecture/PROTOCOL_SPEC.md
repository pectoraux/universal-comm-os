# PROTOCOL SPEC — Universal Communication OS

Normative protocol semantics. Implementations MUST conform.

## 1. Universal Identity

```text
UniversalIdentity
  id: string                     // opaque, canonical, server-assigned OR self-sovereign DID
  display_name?: string
  channel_identities: ChannelIdentity[]
  public_keys: KeySet           // signing + encryption public keys
  created_at: timestamp
```

```text
ChannelIdentity
  channel: ChannelType           // MATRIX | WHATSAPP | SMS | EMAIL | TELEGRAM | INSTAGRAM | MESSENGER | RCS | DEVICE | ...
  channel_id: string             // channel-specific identifier
  verified: VerificationState    // UNVERIFIED | VERIFIED | REVOKED
  linked_at: timestamp
  proof?: VerificationProof
```

Identity resolution is explicit, authenticated, privacy-aware, and policy-controlled.

## 2. Communication Intent

```text
Intent
  type: IntentType
    // SEND_MESSAGE | NOTIFY | REQUEST_RESPONSE | DELIVER_DOCUMENT
    // SEND_MEDIA | EMERGENCY_ALERT | SYNC_CONVERSATION
  priority: Priority              // BULK | NORMAL | PRIORITY | URGENT | EMERGENCY
  ttl_ms?: number
  max_cost?: number
  max_latency_ms?: number
  min_reliability?: number       // 0..1
  min_privacy?: PrivacyClass      // PUBLIC | STANDARD | STRICT | FORWARD_SECRECY
  delivery_requirement: DeliveryRequirement
    // BEST_EFFORT | AT_LEAST_ONCE | EXACTLY_ONCE
  payload_constraints?: PayloadConstraints
    // max_bytes, allowed_media_types, ...
  preferred_transports?: TransportCapability[]
  fallback_policy: FallbackPolicy
    // STRICT | CASCADE | EMERGENCY_ONLY
```

The application expresses the intent; it does not pick the channel.

## 3. Communication Bundle

```text
CommunicationBundle
  bundle_id: string              // UUID v4
  sender: UniversalIdentityRef
  recipient: Recipient
    // UniversalIdentityRef | ChannelIdentityRef | ConversationRef
  conversation_id: string
  intent: Intent
  created_at: timestamp
  expires_at: timestamp          // created_at + ttl
  priority: Priority
  routing_policy: RoutingPolicyRef
  encryption_metadata: EncryptionMetadata
  payload: EncryptedPayload
  delivery_requirements: DeliveryRequirement
  proofs: Proof[]
    // sender_signature, optional relay_chain, optional delivery_receipt_request
```

A bundle is the smallest unit the routing layer may inspect (modulo envelope headers). The payload is opaque to relays.

## 4. Node Capabilities

```text
NodeCapabilities
  messaging: Set<MESSAGING>      // SEND, RECEIVE
  transport: Set<TRANSPORT>      // INTERNET, WIFI, BLE, LAN, WIFI_AWARE
  relay: Set<RELAY>              // STORE, FORWARD
  gateway: Set<GATEWAY>          // MATRIX, SMS, EMAIL, WHATSAPP, TELEGRAM, ...
  resource: ResourceReport
    // bandwidth_bps, storage_bytes, battery_pct, compute_units
```

Capabilities are advertised and policy-controlled. A node is NOT a gateway merely because it has Internet.

## 5. Routing

Routing consumes:
- destination
- sender capabilities
- peer/neighbor capabilities (when known)
- intent constraints (priority, ttl, latency, reliability, privacy, payload)
- routing policy
- trust scores (when available)
- resource availability

Routing emits an ordered route plan, e.g.:

```text
[Bluetooth → Relay B → Wi-Fi → Internet Gateway → Matrix → Recipient]
```

A single-hop route is valid (`[ Matrix ]`).

A no-route outcome is a legitimate, explicit result: `NO_ROUTE`.

## 6. Delivery State Machine

```text
CREATED
  ↓
ACCEPTED       // local node has accepted the bundle into its outbound store
  ↓
QUEUED         // assigned to a transport / waiting for opportunity
  ↓
RELAYED        // bundle has left the originating node via a transport
  ↓
GATEWAY_REACHED // reached a node that advertises a GATEWAY capability
  ↓
EXTERNAL_ACCEPTED // the external channel has accepted the bundle
  ↓
DELIVERED      // recipient's device or mailbox has the bundle
  ↓
READ           // recipient has opened / consumed the bundle
```

Failure transitions:
- `EXPIRED` (TTL elapsed)
- `REJECTED` (policy/permission)
- `POLICY_BLOCKED`
- `NO_ROUTE`
- `CHANNEL_UNAVAILABLE`
- `GATEWAY_UNAVAILABLE`
- `DESTINATION_UNKNOWN`

The model MUST distinguish "left my device" (`RELAYED`) from "reached the recipient" (`DELIVERED`).

## 7. Offline Operation Modes

```text
ONLINE      -- prefer appropriate Internet paths
DEGRADED    -- reduce payload requirements, prefer efficient/reliable transports
OFFLINE     -- use local transports and store-and-forward
PARTITIONED -- queue until connectivity opportunities appear
EMERGENCY   -- prioritize small urgent traffic, suppress nonessential
```

The system picks a mode based on observed connectivity, not on a user toggle.

## 8. Encryption Envelope

A bundle's payload is end-to-end encrypted to the recipient's identity key (or a derived conversation key). Relays see only the envelope headers required for forwarding:

```text
EncryptionMetadata
  algorithm: 'nacl-box-sealed' | 'nacl-box' | 'xchacha20-poly1305'
  recipient_pubkey_hash: string      // opaque to relay
  sender_pubkey_hash?: string
  nonce: string
  additional_data: string             // bundle_id + intent.type + expires_at
```

Relays MUST be able to forward without decrypting.

## 9. Proofs

```text
Proof
  kind: SENDER_SIGNATURE | RELAY_FORWARD | DELIVERY_RECEIPT | GATEWAY_TRANSCRIPT
  signer: IdentityRef
  signature: bytes
  payload_hash: string
  ts: timestamp
```

## 10. Failure & Retry Semantics

- Bundle TTL is authoritative. After expiry, the bundle MUST NOT be re-forwarded.
- Deduplication is mandatory: a bundle received twice is forwarded at most once.
- Replication policy may permit a bundle to be carried by N independent relays simultaneously; delivery is whichever path arrives first.

## 11. Observability

Bundles, route decisions, transport selections, relay events, gateway events, delivery transitions, adapter errors, identity resolutions, and resource usage MAY be observed. Observability MUST NOT expose private message contents or sensitive metadata.
