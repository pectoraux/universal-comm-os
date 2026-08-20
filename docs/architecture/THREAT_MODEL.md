# THREAT MODEL — Universal Communication OS

## Adversaries

| Adversary        | Capability                                                                  |
|------------------|-----------------------------------------------------------------------------|
| Malicious relay  | Can read envelope headers; cannot decrypt payload (sealed-box). May drop, replay, or duplicate bundles. May attempt traffic analysis. |
| Malicious gateway| Can read envelope headers + may try to inject into external channel. Cannot forge end-to-end encryption. |
| Compromised device | Full control of one node's secrets and state. Cannot forge OTHER identities' signatures. |
| Passive network observer | Can read envelope bytes on the wire; cannot decrypt. May do traffic analysis. |
| Active network attacker (DTN) | Can drop, replay, delay, inject bundles; cannot forge signatures. |
| Sybil nodes      | Can create many identities cheaply to flood or de-anonymize. |
| Spam originator  | Can attempt to send bulk unsolicited bundles. |
| Routing manipulator | Can advertise false capabilities to attract or divert bundles. |
| Malicious channel adapter | Can attempt to inject channel-specific semantics into core. |
| Compromised channel provider | Can read whatever the channel's threat model allows (often plaintext at rest). End-to-end encryption still protects against this for the bundle payload. |

## Invariants

1. **Payload confidentiality**: bundle payloads are end-to-end encrypted. Relays, gateways, and channel adapters do not learn payload contents.
2. **Sender authenticity**: every bundle carries a sender signature over (bundle_id + intent + recipient + conversation_id + created_at + expires_at + payload_hash). Relays verify the signature before forwarding.
3. **Replay resistance**: bundle_id is unique and deduplicated. `created_at` + `expires_at` bound validity.
4. **Integrity**: signature covers all envelope fields. Any tampering invalidates the signature.
5. **Capability honesty (goal)**: capability advertisements SHOULD be cross-verified by neighbors. Self-reported capability is treated as UNVERIFIED until corroborated. (Routing MUST degrade gracefully when capability claims are unverifiable.)
6. **Resource protection**: rate-limit inbound per-peer, per-channel, and per-intent-type. Bound queue sizes. Bound bundle TTL. Bound bundle payload size per transport.
7. **Metadata minimization**: envelope headers expose only what is necessary for routing. Conversation_id may be opaque. Sender/recipient identities are referenced by hash unless policy allows otherwise.

## Failure Modes to Test

- No Internet, no Matrix, only local transports.
- Intermittent connectivity (wholesale network flaps).
- High latency, packet loss, node disappearance, node reappearance.
- Duplicate bundles (replay, retransmission).
- Expired bundles arriving at relays.
- Storage exhaustion.
- Battery constraints forcing lower-priority queue flush.
- Gateway disappearance mid-route.
- Network partition followed by partial synchronization.
- Malicious relay dropping or duplicating bundles.
- Sybil nodes flooding a relay.
- Routing manipulation (false capability advertisements).

## Out of Scope (until later phases)

- Token/credit economy (P13). Do not build it prematurely.
- AI-driven routing authority (P14). AI assists; deterministic routing governs.
- Cross-device key sync across a user's devices (P10). Defer until identity graph is real.

## Cryptographic Material Boundaries

| Secret                | Lives in                         | Used by                          |
|-----------------------|----------------------------------|----------------------------------|
| Identity signing key  | Device secure storage            | Signing bundles & proofs         |
| Identity encryption key (private) | Device secure storage   | Decrypting incoming bundles      |
| Conversation key (derived) | In-memory + ephemeral cache   | Conversation-scoped AEAD         |
| Transport auth key    | Per-transport config             | Transport-level channel auth (NOT e2e) |
| Relay forwarding key  | Relay's own storage              | Authenticated forwarding hops   |

A transport-level secret is NEVER treated as an end-to-end confidentiality boundary.
