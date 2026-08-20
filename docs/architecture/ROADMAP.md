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

## P5 — Multi-hop Edge  (DONE in this iteration)
- [x] Capability gossip protocol: nodes periodically broadcast `CapabilityAdvertisement` to direct peers; peers cache + rebroadcast (bounded by hop_count, loop-detected via path)
- [x] `CapabilityCache` interface in core (in-memory impl; Prisma-backed for production future)
- [x] LoopbackTransport gains a duck-typed `gossip()` / `onGossip()` side-channel (Transport interface UNCHANGED — no architecture change)
- [x] NodeRuntime accepts optional `capabilityCache` dep; registers onGossip handler; has `gossipCapabilities()` method
- [x] Router extends `RoutingContext` with `known_network` (deep cache); BFS-based multi-hop planning (A → B → C → D)
- [x] Epidemic-routing fallback (ARCH-027) now conditional: only fires when NO multi-hop plan with a GATEWAY hop was found
- [x] Proven in test: A → B → C → D with proactive route planning from gossiped capabilities

## P6 — Internet Gateway  (DONE in this iteration)
- [x] Gateway runtime (`src/gateway/GatewayRuntime.ts`) bridges DTN bundles to ChannelAdapters when `recipient.kind === 'CHANNEL'`
- [x] EmailAdapter (`src/adapters/email/EmailAdapter.ts`) — EXPERIMENTAL in-process transcript, packages opaque ciphertext into email body
- [x] ChannelAdapter interface fixed: takes opaque bytes only (THREAT_MODEL §1: channel adapters do NOT learn payload contents)
- [x] Prove offline user → Internet gateway: Alice (offline) → Relay → Gateway → EmailAdapter (logged to transcript)
- [x] Epidemic-routing fallback in `tryForward`: relays replicate CHANNEL-recipient bundles to all non-sender peers (necessary without P5 capability gossip)

## P7 — Matrix Fabric
- [ ] Matrix client adapter
- [ ] Federation as a fabric implementation
- [ ] Matrix destination resolution
- Matrix remains an adapter/fabric implementation, NOT the core protocol.

## P8 — External Channels
- [ ] EmailAdapter, SmsAdapter, WhatsAppAdapter (initial three)
- [ ] RCS, Telegram, Instagram, Messenger (later)
- Adapters are added AFTER the adapter abstraction is stable.

## P9 — Intelligent Routing  (DONE in this iteration)
- [x] `computeHopMetrics()` derives reliability/latency/cost/privacy/delivery_probability from peer's resource report (battery, bandwidth, storage, compute) + verification state + intent constraints
- [x] Router's `rankRoute` updated to weigh all factors: reliability + delivery_probability (primary), latency (secondary), cost (tertiary), privacy_score (quaternary), priority adjustments (EMERGENCY double-counts reliability, BULK inverts cost)
- [x] Fixed the P3-P8 peerCaps bug: each immediate peer's ACTUAL caps are now looked up from the capability cache (was using the local node's caps for all peers — ARCH-037)
- [x] `evaluatePlan` aggregates per-hop metrics into plan-level estimates; route plan rationale now shows `reliability=X% delivery_prob=Y% latency=Zms cost=C privacy=P`
- [x] Privacy constraint enforcement: STRICT/FORWARD_SECRECY intents penalize UNVERIFIED peers heavily
- [x] Tests proving: TRUSTED > UNVERIFIED, low battery penalizes, low storage penalizes RELAY hops, high bandwidth → low latency, EMERGENCY reduces cost, STRICT privacy penalizes UNVERIFIED, router picks better peer, NO_ROUTE when min_reliability can't be met

## P10 — Universal Identity Graph  (DONE in this iteration)
- [x] Identity linking protocol: `linkChannelIdentity()` requires a signed `CHANNEL_OWNERSHIP` proof; the verifier checks the signature against the identity's signing pubkey
- [x] `IdentityGraph` interface in core (in-memory impl; Prisma-backed for production future)
- [x] `resolveChannelRecipient(channel, channel_id)` returns the linked identity's REAL encryption pubkey (or undefined if no verified link)
- [x] Replaced the synthesized channel-identity keypair hack (P6) with real graph lookups; backward-compat fallback retained
- [x] Demo pre-links all 4 nodes' emails; UI shows the graph + a "Link a new identity" form
- [ ] Consent + preferences (deferred — not needed for the demo's send path)
- [ ] Federated identity propagation via identity-gossip (deferred — demo uses a shared singleton graph)

## P11 — Consumer Application  (DONE in this iteration)
- [x] Unified inbox: `RecipientInbox` in CommOS auto-decrypts bundles on DELIVERED using the node's X25519 secret key
- [x] Conversations: messages grouped by `conversation_id`, sorted by most recent, with unread counts
- [x] `onDelivered` callback in NodeRuntimeDeps — CommOS registers it for each node, auto-decrypts + adds to inbox
- [x] Contacts: identity graph (P10) provides the contact directory
- [x] Offline queue: DTN store-and-forward queue (P3) + queue UI
- [x] Network state: capability cache (P5) + topology view
- [x] Delivery status: per-node delivery state machine (P3) + timeline UI
- [x] Gateway visibility: email transcript (P6) + gateway state transitions
- [x] Identity management: identity graph (P10) + link/unlink UI
- [x] Mark conversation as read: transitions delivery state to READ

## P12 — Business Platform  (DONE in this iteration — analytics + routing policy management)
- [x] Analytics: delivery statistics (dispatched, delivered, expired, no_route, relayed, queued, delivery_rate, per-node breakdown, hop distribution) — computed from delivery tracker + dispatched bundles
- [x] Routing policy management: editable at runtime via `setPolicy()` on NodeRuntime + `updateRoutingPolicy()` on CommOS; affects subsequent dispatches only
- [x] UI: AnalyticsCard (stat blocks + per-node breakdown + hop distribution bar chart) + RoutingPolicyCard (max_hops, replication_factor, require_e2e, emergency_only, forbidden_transports editor with live JSON preview)
- [ ] Organizations + teams + shared inboxes (deferred — the identity graph P10 + inbox P11 provide the foundation; organization grouping is an application-level concern)
- [ ] CRM + customer profiles (deferred — application-level, not protocol-level)
- [ ] Automation + templates (deferred)
- [ ] Billing (deferred — per ARCH-020, no premature complexity)

## P13 — Community Network
- [ ] Relay participation
- [ ] Gateway participation
- [ ] Reputation
- [ ] Verified contribution measurement
- [ ] Resource accounting
- (No token economy until verified contribution measurement is real.)

## P14 — AI  (DONE in this iteration — intent interpretation + conversation summarization)
- [x] AI intent interpretation: `aiInterpretIntentAction(plaintext)` uses z-ai-web-dev-sdk to analyze the user's natural-language message and suggest a structured Intent (type, priority, TTL, privacy). The AI SUGGESTS; the user CONFIRMS before dispatch.
- [x] AI conversation summarization: `aiSummarizeConversationAction(messages)` uses z-ai-web-dev-sdk to summarize a conversation thread in 2-3 sentences. Focuses on key topics, action items, tone. No sensitive details.
- [x] UI: "AI Interpret Intent" button near dispatch + "AI Summarize" button on inbox conversations. Suggestion display with accept/dismiss.
- [x] Per master prompt: AI MUST NOT become authority for cryptography, identity verification, authorization, protocol semantics, delivery truth, security invariants. The AI operates above the deterministic protocol; it assists but does not govern.
- [ ] Automation + agents (deferred — requires multi-turn LLM conversation management)

## The First Technical Milestone (target)
```text
ANDROID A → ANDROID B → ANDROID C → GATEWAY → MATRIX → WEB/ELECTRON
```
Encrypted Communication Bundle must traverse this path; destination must distinguish created → accepted → relayed → gateway reached → delivered → read.
