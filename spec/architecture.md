# UNIVERSAL COMM OS — FROZEN ARCHITECTURE

**File:** `architecture.md`

**Status:** FROZEN
**Authority:** Principal Architect / Architecture Guardian
**Repository:** `github.com/pectoraux/universal-comm-os`

---

# 1. PURPOSE

Universal Comm OS is a **universal communication operating system**.

It is not:

* a chat application;
* a WhatsApp clone;
* a Matrix replacement;
* a VoIP application;
* a transport-specific messaging system.

Its purpose is to provide a communication substrate through which humans, organizations, software agents, devices, and networks can communicate independently of the underlying transport.

The fundamental abstraction is:

> **Communicate with this identity using this intent.**

The system determines:

* identity;
* authorization;
* trust;
* communication object;
* routing;
* transport;
* relay;
* encryption;
* offline delivery;
* delivery evidence.

The user must not need to reason about:

* BLE;
* Wi-Fi Direct;
* Internet;
* Matrix;
* SMS;
* email;
* cellular;
* relay topology;
* gateway selection.

Those are implementation mechanisms below the universal protocol.

---

# 2. FROZEN SEMANTIC HIERARCHY

The following ordering is fundamental and MUST NOT be inverted:

```text
COMMUNICATION INTENT
        ↓
UNIVERSAL IDENTITY
        ↓
COMMUNICATION BUNDLE
        ↓
AUTHORIZATION / TRUST
        ↓
ROUTING
        ↓
TRANSPORT
        ↓
NETWORK
        ↓
PHYSICAL LINK
```

A lower layer MUST NOT redefine a higher layer.

Examples of forbidden inversion:

```text
BLE packet format
    ↓
changes Bundle semantics
```

```text
Android lifecycle
    ↓
changes protocol Delivery State
```

```text
Matrix identity
    ↓
becomes Universal Identity
```

```text
Relay signature
    ↓
proves sender authorization
```

Correct architecture:

```text
Universal Protocol
       ↓
Transport Adapter
       ↓
BLE / Wi-Fi / Matrix / SMS / Email / etc.
```

---

# 3. ARCHITECTURAL OWNERSHIP

Each concern has one semantic owner.

| Concern                   | Owner                            |
| ------------------------- | -------------------------------- |
| Intent                    | Universal protocol               |
| Universal Identity        | Identity layer                   |
| Identity Link             | Identity layer                   |
| Authorization             | Authorization/policy layer       |
| Trust                     | Trust/security layer             |
| Communication Bundle      | Protocol layer                   |
| Delivery State            | Canonical protocol state machine |
| Routing                   | Routing layer                    |
| Transport behavior        | Transport adapter                |
| Physical/network behavior | Network/transport implementation |
| Android lifecycle         | Android runtime                  |
| Persistence               | Persistence implementation       |
| Execution evidence        | Governance/verification layer    |

Implementation layers may **implement** a contract.

They may not silently **redefine** that contract.

---

# 4. UNIVERSAL IDENTITY

Universal Identity is the protocol-level identity of an entity.

Universal Identity is NOT:

* a phone number;
* an email address;
* a Matrix ID;
* a WhatsApp account;
* a Discord account;
* a device identifier;
* a username.

Those are **identity links**.

Conceptual model:

```text
                  UNIVERSAL IDENTITY
                         |
          +--------------+--------------+
          |              |              |
        Email          Matrix         Phone
          |              |              |
      identity link  identity link  identity link
```

An external channel proves ownership or association with that channel.

It does not automatically redefine Universal Identity.

---

# 5. IDENTITY LINK STATE MACHINE

Identity links use the canonical states:

```text
ASSERTED
VERIFIED
EXPIRED
REVOKED
```

Legal transitions:

```text
ASSERTED
   |
   +---- VERIFIED
   |
   +---- EXPIRED

VERIFIED
   |
   +---- REVOKED
```

Rules:

* links begin as `ASSERTED`;
* verification establishes channel ownership;
* trusted communication MAY require `VERIFIED`;
* expired and revoked states remain meaningful historical states;
* direct database mutation MUST NOT bypass the state machine;
* implementations MUST NOT invent another identity-link vocabulary;
* implementations MUST NOT create shortcut transitions.

The state machine is authoritative.

---

# 6. COMMUNICATION INTENT

Communication is intent-driven.

Examples:

```text
personal_message
business_inquiry
business_request
urgent_alert
verification_request
voice_call
video_call
system_event
```

Intent is protocol semantics, not merely a UI label.

Intent MAY influence:

* priority;
* routing requirements;
* urgency;
* transport selection;
* policy;
* delivery strategy;
* capability requirements;
* trust requirements.

Intent MUST NOT encode a specific transport.

Forbidden:

```text
urgent_alert = BLE
```

Correct:

```text
urgent_alert
    ↓
routing policy
    ↓
appropriate transport(s)
```

---

# 7. COMMUNICATION BUNDLE

The Communication Bundle is the universal protocol communication object.

Everything transported by Universal Comm OS ultimately becomes a Bundle, unless the communication is explicitly defined as a separate real-time Session.

Conceptual Bundle fields include:

```text
sender identity
recipient identity
communication intent
encrypted payload
protocol metadata
routing requirements
delivery state
delivery evidence
```

The exact canonical schema is owned by the protocol implementation and its frozen contracts.

Transport adapters carry Bundles.

Transport adapters MUST NOT redefine:

* Bundle semantics;
* identity semantics;
* authorization;
* trust;
* delivery state;
* protocol intent.

---

# 8. COMMUNICATION SESSIONS

Real-time communications such as voice and video are not ordinary message Bundles.

Future real-time communication is modeled as a separate Session abstraction:

```text
Communication OS
       |
       +---- Bundle communication
       |
       +---- Session communication
```

Examples:

```text
voice session
video session
live collaboration session
```

A calling implementation MUST NOT reinterpret messaging Bundles as calls merely for convenience.

A Session MAY use the same:

* identity;
* authorization;
* trust;
* routing;
* transport architecture;

but remains semantically distinct from asynchronous Bundle communication.

---

# 9. AUTHENTICATION AND AUTHORIZATION

These concepts are permanently distinct.

Authentication asks:

> Who are you?

Authorization asks:

> What may you do?

Never use:

```text
client-provided identity
```

as authority.

Authorization MUST derive from:

```text
authenticated principal
+
server-side policy
+
relevant trust/permission state
```

A UI-visible identifier MUST NOT be treated as authorization.

A transport identifier MUST NOT automatically become authorization.

A relay MUST NOT grant sender authority.

---

# 10. TRUST MODEL

Trust is a protocol/security concern.

The implementation MUST preserve separation between:

```text
identity
authentication
authorization
trust
transport participation
delivery evidence
```

A fact established by one category MUST NOT silently prove another category.

For example:

```text
Relay participation
≠
Sender authorization
```

```text
Transport possession
≠
Universal identity ownership
```

```text
Delivery observation
≠
Sender approval
```

---

# 11. CRYPTOGRAPHY

Security is part of the architecture.

Never introduce:

* invented cryptography;
* home-grown signatures;
* fake encryption;
* placeholder encryption;
* plaintext private-key storage;
* private-key logging;
* fake cryptographic proof.

Canonical signing uses **Ed25519** where the protocol specifies Ed25519.

The canonical TypeScript implementation uses the NaCl/tweetnacl representation:

```text
public key = raw 32-byte Ed25519 public key
signature  = canonical Ed25519 detached signature
```

Android implementations MUST interoperate with the canonical protocol.

Android MUST NOT silently introduce an incompatible public-key encoding.

---

# 12. ANDROID KEY MANAGEMENT

For modern Android versions, Android Keystore is the preferred hardware/platform key boundary.

Rules:

```text
private signing key
        ↓
Android Keystore
```

The private signing key MUST remain non-exportable.

The implementation MUST NOT expose a `getPrivateKey()` API that returns private key material to ordinary application code.

The public key MAY be exported.

If software fallback is required for older Android versions, it MUST still obey the frozen security requirements concerning key lifetime and memory exposure.

In particular:

> The runtime MUST NOT cache signing secret material in process memory beyond the permitted signature-operation lifetime.

---

# 13. PUBLIC-KEY REPRESENTATION

The Universal Comm OS canonical Ed25519 public-key representation is:

```text
RAW 32-BYTE ED25519 PUBLIC KEY
```

This matches the canonical TypeScript/tweetnacl representation.

X.509 SubjectPublicKeyInfo is an encoding/container format and is NOT the canonical protocol representation.

Adapters MAY parse X.509/SPKI internally to recover the canonical raw key, but MUST return the canonical protocol representation at the protocol boundary.

---

# 14. DELIVERY STATE

Delivery state is a protocol concern.

The canonical state machine is authoritative.

The current canonical forward graph includes:

```text
CREATED
   ↓
ACCEPTED
   ↓
QUEUED
   ↓
RELAYED
   ↓
GATEWAY_REACHED
   ↓
EXTERNAL_ACCEPTED
   ↓
DELIVERED
   ↓
READ
```

Permitted branches include the canonical failure states:

```text
EXPIRED
REJECTED
POLICY_BLOCKED
NO_ROUTE
CHANNEL_UNAVAILABLE
GATEWAY_UNAVAILABLE
DESTINATION_UNKNOWN
```

The exact legal transitions are defined by the canonical DeliveryTracker implementation.

Implementations MUST remain semantically equivalent.

---

# 15. DELIVERY STATE AUTHORITY

The authoritative rule is:

```text
REAL PROTOCOL EVENT
        ↓
CANONICAL DELIVERY STATE MACHINE
        ↓
LEGAL STATE TRANSITION
        ↓
PERSIST RESULTING STATE
```

The following pattern is forbidden:

```text
DATABASE ROW
        ↓
defines protocol state
```

The following is also forbidden:

```text
TRANSPORT RECEIPT
        ↓
pretend relay happened
        ↓
pretend delivery happened
```

And:

```text
REHYDRATION
        ↓
fabricate historical events
```

must never occur.

Receiving a Bundle proves receipt.

It does NOT automatically prove:

```text
RELAYED
```

or:

```text
DELIVERED
```

Persistence MUST store the state produced by the canonical state machine.

Persistence MUST NOT manufacture protocol transitions.

---

# 16. REHYDRATION

Rehydration restores durable protocol state after restart.

Rehydration MUST NOT replay synthetic historical events simply to reach the persisted state.

Correct model:

```text
persisted canonical state
        ↓
restore runtime state
```

not:

```text
persisted state
        ↓
invent old events
        ↓
re-run state machine
```

Historical delivery evidence MUST correspond to real events.

---

# 17. TRANSPORT ABSTRACTION

Every transport is an adapter beneath the protocol.

Examples:

```text
BLE
Wi-Fi Direct
Internet
Matrix
SMS
Email
Cellular
VoIP
```

Conceptual transport responsibilities may include:

```text
discover()
connect()
send()
receive()
reportCapabilities()
reportResources()
```

Transport adapters MAY:

* discover peers;
* establish sessions;
* transmit Bundles;
* receive Bundles;
* report capabilities;
* report resources;
* expose connectivity;
* participate in relaying.

Transport adapters MUST NOT:

* redefine Bundle semantics;
* redefine Universal Identity;
* redefine Authorization;
* redefine Trust;
* redefine Delivery State;
* invent transport-specific protocol semantics.

---

# 18. HARDWARE BOUNDARY INTEGRITY

Hardware adapters implement transport.

They do not define protocol meaning.

This rule applies to:

```text
BLE
Wi-Fi Direct
cellular radios
Android hardware
network interfaces
future radio technologies
```

A hardware implementation MAY optimize execution.

It MUST NOT modify the semantic contracts above it.

---

# 19. ANDROID LIFECYCLE BOUNDARY

Android lifecycle belongs to Android runtime architecture.

Protocol lifecycle belongs to the Universal Comm OS protocol.

Therefore:

```text
Activity stopped
```

does NOT automatically mean:

```text
communication session terminated
```

unless the protocol explicitly says so.

Likewise:

```text
Android Service stopped
```

does not automatically redefine Bundle Delivery State.

Android runtime MUST translate platform lifecycle events into appropriate runtime behavior without changing protocol semantics.

---

# 20. ANDROID RUNTIME

The Android runtime is a real native Kotlin implementation.

The implementation MUST be a genuine Android application/runtime.

A webview, TypeScript simulation, or fake Android adapter is not an acceptable replacement.

P4.1-B runtime responsibilities include:

* foreground service;
* lifecycle ownership;
* Android Keystore integration;
* Room persistence;
* runtime bridge;
* resource observations;
* delivery-state integration;
* process-death recovery;
* Android instrumentation.

---

# 21. PERSISTENCE

PostgreSQL remains the canonical server/database architecture.

The canonical Prisma datasource MUST remain:

```text
provider = "postgresql"
```

SQLite MUST NOT replace PostgreSQL for convenience.

Android Room/SQLite is a separate **device-local persistence mechanism** and does not redefine the server database architecture.

Android persistence MUST:

* use durable storage;
* avoid destructive migration shortcuts;
* preserve protocol state;
* preserve required delivery history;
* support restart recovery;
* maintain idempotency where required.

Forbidden:

```text
fallbackToDestructiveMigration()
```

unless a formal architecture amendment explicitly changes the rule.

---

# 22. PROCESS-DEATH RECOVERY

Android runtime state must survive process death where the architecture requires durable recovery.

Required semantic flow:

```text
runtime
   ↓
persist durable state
   ↓
process dies
   ↓
Android recreates runtime
   ↓
hydrate persisted state
   ↓
resume correctly
```

Database close/reopen alone is NOT sufficient evidence of process-death recovery.

A real Android process termination/recreation test is required for acceptance.

---

# 23. RESOURCE SAMPLING

Resource observations include:

```text
battery
storage
network availability
radio state
other runtime resource conditions
```

These are observations.

They MAY inform:

* routing;
* resource policy;
* forwarding policy;
* transport selection.

They MUST NOT silently mutate protocol state.

Example:

```text
battery = low
```

does not itself mean:

```text
DeliveryState = FAILURE
```

unless a canonical policy explicitly causes such a transition.

---

# 24. EDGE TRANSPORT ROADMAP

The edge implementation proceeds in this order:

```text
P4.1-B
REAL ANDROID RUNTIME
        ↓
P4.2
BLE
        ↓
P4.3
WI-FI DIRECT
        ↓
P4.4
OFFLINE STORE-AND-FORWARD
        ↓
P4.5
RELAY NODE
        ↓
P4.6
EDGE SECURITY REVIEW
```

This order MUST NOT be skipped without architectural review.

---

# 25. P4.1-B ACCEPTANCE

P4.1-B is not accepted merely because Kotlin source exists.

P4.1-B acceptance requires all relevant categories below:

```text
REAL ANDROID PROJECT
AND
REAL KOTLIN RUNTIME
AND
FOREGROUND SERVICE
AND
ANDROID LIFECYCLE OWNERSHIP
AND
ANDROID KEYSTORE
AND
ROOM PERSISTENCE
AND
PROCESS-DEATH RECOVERY
AND
RESOURCE SAMPLING
AND
DELIVERY-STATE CONFORMANCE
AND
CROSS-LANGUAGE CRYPTO INTEROPERABILITY
AND
MEANINGFUL JVM TEST COVERAGE
AND
INSTRUMENTATION TESTS
AND
ANDROID BUILD
AND
PROTOCOL INTEROPERABILITY
AND
EXECUTION EVIDENCE
AND
REPOSITORY TRUTH
```

A passing `assembleDebug`, `test`, and `connectedCheck` is necessary but not by itself sufficient.

---

# 26. P4.2 BLE

BLE is a transport adapter.

BLE responsibilities:

```text
peer discovery
advertisement
session establishment
encrypted transport
Bundle framing
Bundle send
Bundle receive
connection lifecycle
retry
disconnect recovery
resource reporting
```

BLE MUST consume existing Bundle semantics.

BLE MUST NOT create:

```text
BLE Bundle
BLE Identity
BLE Delivery State
BLE Authorization
BLE Trust
```

BLE is blocked until P4.1-B is accepted.

---

# 27. BLE IMPLEMENTATION ORDER

Implement in this sequence:

```text
BLE capability model
        ↓
advertisement/discovery
        ↓
peer identity association
        ↓
session establishment
        ↓
cryptographic handshake
        ↓
Bundle framing
        ↓
encrypted transfer
        ↓
receive pipeline
        ↓
Delivery State integration
        ↓
retry
        ↓
disconnect recovery
        ↓
resource reporting
        ↓
adversarial tests
```

Required adversarial tests include:

* duplicate discovery;
* disappearing peer;
* reconnect;
* malformed packets;
* replay;
* oversized packets;
* partial transfer;
* disconnect during transfer;
* retry;
* Bundle integrity;
* identity verification;
* authorization;
* delivery-state correctness.

---

# 28. P4.3 WI-FI DIRECT

Wi-Fi Direct follows BLE.

Intended relationship:

```text
BLE
=
discovery/bootstrap/control

Wi-Fi Direct
=
higher-bandwidth transfer
```

The same Bundle protocol MUST be used.

Wi-Fi Direct MUST NOT duplicate or redefine semantic logic already owned by the protocol.

Implementation order:

```text
peer discovery
↓
session establishment
↓
capability negotiation
↓
Bundle transfer
↓
large payload handling
↓
retry/reconnect
↓
resource reporting
↓
conformance tests
```

---

# 29. P4.4 OFFLINE COMMUNICATION

Offline communication uses store-and-forward.

Example:

```text
Alice
  |
 BLE
  |
Relay
  |
Internet
  |
Gateway
  |
Bob
```

Required components:

```text
durable storage
TTL
expiry
deduplication
forwarding policy
retry
replay protection
resource limits
delivery evidence
```

Important distinction:

```text
FORWARDED
≠
DELIVERED
```

Forwarding proves forwarding participation.

Delivery requires the appropriate protocol event/evidence.

---

# 30. P4.5 RELAY NODE MODE

Relay capabilities may include:

```text
MESH_RELAY
INTERNET_GATEWAY
STORAGE
DISCOVERY
SYNC
```

Relay implementations require:

* capability reporting;
* resource reporting;
* reputation;
* abuse controls;
* quotas;
* battery awareness;
* storage limits;
* forwarding policy.

A relay is infrastructure.

A relay is NOT an identity authority.

Relay evidence MUST NOT prove sender authorization.

---

# 31. P4.6 EDGE SECURITY REVIEW

Before advancing beyond the edge transport foundation, perform adversarial review against:

```text
malicious relay
fake relay
fake advertisement
replay
identity spoofing
session downgrade
BLE abuse
Wi-Fi Direct abuse
battery exhaustion
storage exhaustion
traffic amplification
permission abuse
key extraction
process-restart races
```

Every discovered vulnerability must be:

```text
fixed
```

or:

```text
explicitly accepted by architecture/security decision
```

A known security defect MUST NOT be silently deferred while declaring the milestone accepted.

---

# 32. P5 NETWORK INTELLIGENCE

After real edge transport foundations exist, build network intelligence.

Network intelligence reasons over:

```text
nodes
links
capabilities
resources
reachability
cost
trust
latency
bandwidth
battery
storage
availability
```

It selects among real observed options.

It MUST NOT be based on invented network observations merely to demonstrate a routing algorithm.

Required progression:

```text
real transport
↓
real observations
↓
real capabilities
↓
real resources
↓
network graph
↓
routing
```

---

# 33. P6 ROUTING

Routing is policy-driven and intent-aware.

Conceptually:

```text
Intent
+
Identity
+
Requirements
+
Network graph
+
Capabilities
+
Resources
+
Policy
        ↓
Route selection
```

Examples:

```text
urgent_alert
    ↓
latency-sensitive routing
```

```text
large_file
    ↓
bandwidth-sensitive routing
```

Routing MUST choose among transport/network options.

Routing MUST NOT redefine transport semantics.

---

# 34. P7 INTELLIGENT ROUTING

Higher-level routing may include:

* capability discovery;
* graph routing;
* route scoring;
* adaptive policy;
* transport selection;
* resource-aware routing;
* intent-aware routing;
* failure recovery.

Intelligent routing MUST consume real network observations.

It MUST NOT replace missing lower-layer functionality with simulated topology.

---

# 35. MATRIX INTEGRATION

Matrix is an adapter.

Correct architecture:

```text
Universal Comm OS
       ↓
Matrix Adapter
       ↓
Matrix Network
```

Incorrect:

```text
Universal Comm OS
       ↓
Matrix semantics become core protocol
```

Matrix-specific concepts MUST remain behind the adapter boundary.

Matrix identity is an identity link or adapter-level concept, not Universal Identity itself.

---

# 36. EXTERNAL CHANNEL ADAPTERS

Future adapters may include:

```text
SMS
Email
WhatsApp official APIs
social APIs
other messaging APIs
cellular services
VoIP/SIP/WebRTC integrations
```

They MUST be implemented as adapters.

Platform-specific rules MUST be respected.

Do not:

* scrape unsupported platforms;
* impersonate unsupported clients;
* bypass official API restrictions;
* redefine Universal Comm OS protocol semantics.

---

# 37. REAL-TIME COMMUNICATION

Real-time communications are Sessions, not ordinary Bundles.

Future components may include:

```text
WebRTC
SIP
VoIP
cellular calling
video sessions
```

The real-time layer MUST use the same universal:

```text
Identity
Authorization
Trust
Routing
Transport
```

architecture while preserving the semantic distinction:

```text
Bundle
≠
Session
```

---

# 38. ARCHITECTURE TESTS

Tests under:

```text
tests/architecture/
```

are executable architecture contracts.

Do NOT weaken or delete them merely because implementation is inconvenient.

If an architecture test blocks implementation:

```text
STOP
↓
inspect governing decision
↓
architectural review
↓
formal amendment if genuinely necessary
↓
update invariant intentionally
↓
implement
```

Do not:

```text
weaken test
↓
make code pass
↓
claim architecture preserved
```

---

# 39. SECURITY TESTS

Security tests remain fatal.

Architecture tests remain fatal.

Typecheck/build failures remain fatal where applicable.

Never restore:

```yaml
continue-on-error: true
```

to hide a failure.

A green CI with ignored architecture/security failures is unacceptable.

---

# 40. CI AND REPOSITORY GOVERNANCE

The repository is the source of truth.

A claimed milestone is not complete until:

```text
tested SHA
=
local HEAD
=
origin/main
```

and:

```text
worktree clean
```

Execution evidence MUST bind to the exact tested SHA.

If the repository changes after evidence generation:

```text
rerun validation
regenerate evidence
```

Do not reuse stale evidence.

---

# 41. EXECUTION EVIDENCE

Execution evidence must contain or otherwise establish:

```text
commit SHA
repository
branch
timestamp
environment
commands
exit codes
durations
test results
architecture results
security results
typecheck/build results
overall status
```

Critical invariant:

```text
execution evidence SHA
=
tested SHA
```

The existence of an evidence file does not prove validity unless its SHA and contents are verified.

---

# 42. BRANCH PROTECTION

Main branch protection MUST remain enabled.

Preferred governance:

```text
feature branch
    ↓
PR
    ↓
architecture/security/CI checks
    ↓
review
    ↓
merge
    ↓
main
```

Do not disable branch protection merely for implementation convenience.

If a configuration change requires exceptional administration:

1. identify it;
2. document it;
3. minimize the duration;
4. restore protection immediately;
5. verify final settings from GitHub.

Android CI MUST become a required merge gate only after confirming that the Android checks reliably execute on pull requests.

A required check that never appears on PRs MUST NOT be introduced.

---

# 43. DATABASE GOVERNANCE

Production/server architecture remains PostgreSQL.

The Prisma datasource MUST remain:

```text
provider = "postgresql"
```

No SQLite substitution is permitted for production architecture.

Local environments lacking PostgreSQL MUST use:

* local PostgreSQL;
* Neon development database;
* another approved PostgreSQL-compatible environment.

Do not alter production architecture to accommodate a sandbox limitation.

---

# 44. ENVIRONMENT AND SECRETS

`.env` MUST NOT be committed.

`.env.example` MUST contain placeholders only.

Never commit:

```text
passwords
API keys
tokens
private keys
production credentials
```

`.env.example` is configuration documentation, not a secret store.

---

# 45. IMPLEMENTATION AGENT RULES

Implementation agents, including Z.ai, operate inside a frozen architecture.

Before coding they MUST:

```text
1. inspect repository
2. inspect architecture documents
3. identify frozen contracts
4. inspect existing tests
5. identify exact delta
6. identify drift risks
7. implement narrowly
8. validate
9. inspect diff
10. report exact status
```

Agents MUST stop if:

* a frozen contract must change;
* a required environment is unavailable;
* a security invariant conflicts with implementation;
* a test must be weakened;
* implementation can only be simulated;
* evidence cannot be produced.

Correct response:

```text
BLOCKED
```

not:

```text
COMPLETE
```

---

# 46. NO FAKE COMPLETION

The following are NOT evidence of runtime correctness:

```text
file exists
class exists
method exists
workflow exists
test file exists
source looks correct
architecture test passes
TypeScript test passes
```

For platform/runtime milestones:

```text
source exists
≠
runtime works
```

For Android:

```text
Kotlin compiles
≠
Android runtime works
```

For BLE:

```text
BLE adapter exists
≠
BLE works
```

---

# 47. MILESTONE VOCABULARY

Use only:

```text
DESIGNED
IMPLEMENTED
VALIDATED
ACCEPTED
BLOCKED
REJECTED
```

Use these distinctions precisely:

### DESIGNED

Architecture exists but implementation has not begun.

### IMPLEMENTED

Source implementation exists.

### VALIDATED

Required runtime/test evidence exists for the defined scope.

### ACCEPTED

Architecture, security, validation, evidence, and repository-truth requirements are all satisfied.

### BLOCKED

Required work cannot proceed because an explicit prerequisite or environment is unavailable.

### REJECTED

Implementation violates the architecture or acceptance criteria.

Do NOT use "complete" as a substitute for `ACCEPTED`.

---

# 48. MULTI-SESSION MILESTONE STATE

Every active milestone maintains:

```text
TARGET STATE
CURRENT STATE
COMPLETED
INCOMPLETE
KNOWN DRIFT
BLOCKERS
NEXT ACTION
```

At the beginning of each new implementation session, produce:

```text
ARCHITECT STATUS REPORT

PROJECT:
CURRENT MILESTONE:
TARGET:
CURRENT IMPLEMENTATION:
COMPLETED:
INCOMPLETE:
KNOWN DRIFT:
BLOCKERS:
NEXT IMPLEMENTATION STEP:
```

Never restart architectural reasoning from zero.

---

# 49. CHANGE BUDGET

Major implementation work MUST remain narrowly scoped.

A lower-layer milestone unexpectedly changing:

```text
Bundle
Identity
Authorization
Trust
Delivery State
database architecture
```

is a drift signal.

Stop and investigate.

Do not accept large architectural blast radius without formal review.

---

# 50. REQUIRED ARCHITECTURE CHANGE PROCESS

If a frozen contract genuinely proves insufficient:

```text
architecture problem
        ↓
formal proposal
        ↓
adversarial review
        ↓
ADR / constitution amendment
        ↓
architecture ledger update
        ↓
architecture tests updated intentionally
        ↓
implementation
```

Implementation MUST NOT precede the architectural decision when the frozen contract itself must change.

---

# 51. CURRENT P4.1-B KNOWN GAPS

At the current architecture state, the following remain tracked until independently resolved and accepted:

```text
1. Delivery-state authority defects D1/D2/D3
2. Android ↔ TypeScript Ed25519 interoperability
3. True Android process-death recovery
4. Android lifecycle instrumentation
5. Resource-sampling instrumentation
6. Room migration validation
7. Meaningful Android JVM/Robolectric tests
8. ARCH-056 software-key lifetime compliance
9. Android CI required-status governance
10. Stray production-only CI stub cleanup
```

These are distinct tasks.

Do not bundle them into uncontrolled implementation passes.

---

# 52. CURRENT ROADMAP

The required implementation order is:

```text
FOUNDATION
    ↓
S0–S0.2.6
    ↓
P4.0 Edge Architecture
    ↓
P4.1-A Android Runtime Contracts
    ↓
P4.1-B Real Android Runtime
    ↓
P4.1-B Validation / Hardening
    ↓
P4.2 BLE
    ↓
P4.3 Wi-Fi Direct
    ↓
P4.4 Offline Store-and-Forward
    ↓
P4.5 Relay Node
    ↓
P4.6 Edge Security Review
    ↓
P5 Network Intelligence
    ↓
P6 Routing
    ↓
P7 Intelligent Routing
    ↓
Matrix Adapter
    ↓
External Channel Adapters
    ↓
Real-Time Sessions
```

Do not reorder this roadmap without architectural review.

---

# 53. DEFINITION OF ACCEPTED

A milestone is accepted only when:

```text
Implementation exists
AND
required tests exist
AND
required tests pass
AND
architecture tests pass
AND
security tests pass
AND
typecheck/build passes
AND
runtime validation passes
AND
known milestone-specific defects are resolved
AND
documentation is accurate
AND
execution evidence is valid
AND
GitHub contains the implementation
AND
LOCAL HEAD == origin/main == TESTED SHA
AND
worktree is clean
```

Any missing requirement means:

```text
NOT ACCEPTED
```

---

# 54. ARTICLE XVII COMMIT REPORT

Every accepted milestone ends with:

```text
ARTICLE XVII COMMIT REPORT

MILESTONE:
MODE:

LOCAL HEAD:
GITHUB MAIN:
TESTED SHA:
MATCH:

WORKTREE CLEAN:

TEST RESULT:

ARCHITECTURE:

SECURITY:

TYPECHECK:

BUILD:

RUNTIME VALIDATION:

EXECUTION EVIDENCE:

STATUS:
```

Then:

```text
FILES CHANGED

ARCHITECTURAL DECISIONS

SECURITY DECISIONS

TESTS ADDED

KNOWN LIMITATIONS

BLOCKERS

NEXT MILESTONE
```

Failed validations MUST NOT be hidden.

---

# 55. PRINCIPAL ARCHITECT RULES

When forced to choose between:

```text
fast progress
```

and:

```text
architecturally trustworthy progress
```

choose:

```text
architecturally trustworthy progress
```

A blocked milestone is acceptable.

A falsely completed milestone is not.

A slower implementation is acceptable.

A frozen contract silently changed for convenience is not.

A failed CI build is acceptable.

A green build achieved by weakening architecture/security tests is not.

A source implementation without runtime evidence is not accepted.

A local commit without GitHub verification is not repository truth.

---

# 56. FINAL ARCHITECTURE

The intended Universal Comm OS remains:

```text
                    UNIVERSAL COMM OS
                           |
                    COMMUNICATION INTENT
                           |
                    UNIVERSAL IDENTITY
                           |
                  COMMUNICATION BUNDLE
                           |
                 AUTHORIZATION / TRUST
                           |
                       ROUTING
                           |
                NETWORK INTELLIGENCE
                           |
          +----------------+----------------+
          |                |                |
         BLE          Wi-Fi Direct       Internet
          |                |                |
        Device           Device          Gateway
          |                |                |
          +----------------+----------------+
                           |
                         Relay
                           |
                  External Networks
                           |
             +-------------+-------------+
             |             |             |
           Matrix         SMS          Email
             |             |             |
             +-------------+-------------+
                           |
                      Destination
```

The semantic hierarchy remains:

```text
INTENT
  ↓
IDENTITY
  ↓
BUNDLE
  ↓
AUTHORIZATION / TRUST
  ↓
ROUTING
  ↓
TRANSPORT
  ↓
NETWORK
  ↓
PHYSICAL LINK
```

**That hierarchy is the architecture.**

Everything below the protocol is an implementation mechanism.

Everything above the transport must remain transport-independent.

Everything implemented on a platform must conform to the frozen protocol.

Everything claimed as complete must be supported by executable evidence.

