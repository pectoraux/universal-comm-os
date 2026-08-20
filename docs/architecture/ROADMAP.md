# ROADMAP — Universal Communication OS

Implementation sequencing per the master prompt. Vertical from the protocol outward. No channel integrations until P8.

## P0 — Constitutional Foundation  (DONE in this iteration)
- [x] Repository structure with architectural boundaries
- [x] NORTH_STAR.md, ARCHITECTURE_CONSTITUTION.md, ARCHITECTURE_LEDGER.md
- [x] PROTOCOL_SPEC.md, THREAT_MODEL.md, CHANGE_CONTROL.md
- [x] ROADMAP.md / ROADMAP.yaml
- [x] Architecture test runner (vitest) with boundary enforcement
- [x] Coding conventions documented
- No channel integrations.

## P1 — Universal Protocol  (DONE in this iteration)
- [x] UniversalIdentity + ChannelIdentity
- [x] Intent + IntentType + constraints
- [x] CommunicationBundle + EncryptionMetadata + Proofs
- [x] Conversation
- [x] DeliveryState machine + DeliveryTracker
- [x] NodeCapabilities + Capability advertisement
- [x] RoutingPolicy + DeliveryPolicy
- [x] Cryptographic envelope (NaCl sealed-box / signed)
- [x] Router (capability- and policy-based, single-hop + multi-hop DTN)
- Proves the protocol independently of Matrix.

## P2 — Local Transport  (DONE in this iteration)
- [x] Transport interface
- [x] LoopbackTransport (in-process)
- [x] In-memory bundle store (store-and-forward semantics)
- [x] Basic transport negotiation via capabilities
- Proves `Bundle → transport → destination` without Internet.

## P3 — DTN  (DONE in this iteration)
- [x] Persistent bundle store (Prisma-backed: `StoredBundle`, `ReceivedBundle`, `DeliveryEvent` tables)
- [x] TTL expiry sweeper (background task; protocol-level `isExpired()` check)
- [x] Deduplication index (unique (node_id, bundle_id) constraint + in-memory Set fallback)
- [x] Replication policy (`replicate=true` flag → fan-out to N peers; first OK wins; canonical bundle_id dedup at recipient)
- [x] Multi-hop forwarding (relay runs its own router, picks transport that reaches the next peer)
- [x] Routing metadata propagation (relay signs `RELAY_FORWARD` proof and appends to bundle's `proofs[]`)

## P4 — Android Edge
- [ ] Bluetooth / BLE / Wi-Fi transport implementations (Android)
- [ ] Background lifecycle
- [ ] Foreground notifications
- [ ] Opportunistic relay
- (Implemented by Gemini agent through Android Studio; consumes canonical protocol.)

## P5 — Multi-hop Edge
- [ ] A → B → C → D with mixed connectivity
- [ ] Capability gossip over local transports

## P6 — Internet Gateway
- [ ] DTN → Internet gateway runtime
- [ ] Bundle ingress from edge fabric to gateway
- [ ] Gateway egress to global fabric

## P7 — Matrix Fabric
- [ ] Matrix client adapter
- [ ] Federation as a fabric implementation
- [ ] Matrix destination resolution
- Matrix remains an adapter/fabric implementation, NOT the core protocol.

## P8 — External Channels
- [ ] EmailAdapter, SmsAdapter, WhatsAppAdapter (initial three)
- [ ] RCS, Telegram, Instagram, Messenger (later)
- Adapters are added AFTER the adapter abstraction is stable.

## P9 — Intelligent Routing
- [ ] Cost / latency / reliability / battery / bandwidth / storage / trust / privacy routing weights
- [ ] Delivery probability estimation

## P10 — Universal Identity Graph
- [ ] Identity linking protocol
- [ ] Channel identity verification
- [ ] Contact resolution + consent + preferences

## P11 — Consumer Application
- [ ] Unified inbox
- [ ] Conversations
- [ ] Contacts
- [ ] Offline queue UI
- [ ] Network state UI
- [ ] Delivery status UI
- [ ] Gateway visibility
- [ ] Identity management UI

## P12 — Business Platform
- [ ] Organizations, teams, shared inboxes
- [ ] CRM, customer profiles, automation
- [ ] Routing policies UI, templates, analytics, billing

## P13 — Community Network
- [ ] Relay participation
- [ ] Gateway participation
- [ ] Reputation
- [ ] Verified contribution measurement
- [ ] Resource accounting
- (No token economy until verified contribution measurement is real.)

## P14 — AI
- [ ] Intent interpretation assist
- [ ] Routing recommendations
- [ ] Conversation summarization
- [ ] Automation, agents
- AI assists; AI MUST NOT become authority for crypto / identity verification / authorization / protocol semantics / delivery truth / security invariants.

## The First Technical Milestone (target)
```text
ANDROID A → ANDROID B → ANDROID C → GATEWAY → MATRIX → WEB/ELECTRON
```
Encrypted Communication Bundle must traverse this path; destination must distinguish created → accepted → relayed → gateway reached → delivered → read.
