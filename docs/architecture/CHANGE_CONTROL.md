# CHANGE CONTROL — Universal Communication OS

## Process

1. Anyone may propose an Architecture Change Proposal (ACP).
2. Create `docs/architecture/changes/ACP-XXXX.md` with the template below.
3. Status starts as `PROPOSED`.
4. While `PROPOSED`, the change MUST NOT be implemented.
5. Approval transitions status to `ACCEPTED` (or `REJECTED`).
6. Once `ACCEPTED`, the change becomes an authoritative architectural decision and is appended to `ARCHITECTURE_LEDGER.md` (or to `ARCHITECTURE_CONSTITUTION.md` for constitutional changes).
7. Rejected proposals remain in the directory for historical traceability.

## ACP Template

```markdown
# ACP-XXXX — <title>

- Status: PROPOSED
- Proposed by: <name>
- Date: <YYYY-MM-DD>
- Supersedes: <ARCH-NNN or none>
- Superseded by: <none>

## Problem
<What problem motivates this change?>

## Current architecture
<What the architecture says today, with references to NORTH_STAR, ARCHITECTURE_CONSTITUTION, ARCHITECTURE_LEDGER, PROTOCOL_SPEC, THREAT_MODEL.>

## Relevant architecture decisions
<ARCH-NNN entries.>

## Why current architecture is insufficient
<Concrete evidence.>

## Proposed change
<The new architectural decision, written as an amendment.>

## Alternatives considered
<At least one alternative, with reasons for rejection.>

## Security impact
<Threat model deltas.>

## Protocol impact
<Spec deltas.>

## Client impact
<Web/Electron/Android/iOS deltas.>

## Server impact
<Runtime deltas.>

## Migration impact
<What existing state or code must change.>

## Roadmap impact
<Roadmap phase deltas.>

## Testing impact
<New/changed architecture tests, conformance tests, unit tests.>

## Recommendation
<Accept / Reject / Defer.>
```

## Status Vocabulary

- `PROPOSED` — submitted, awaiting review. No implementation allowed.
- `ACCEPTED` — approved. Becomes authoritative; ledger entry appended.
- `REJECTED` — explicitly declined. Stays for history.
- `SUPERSEDED` — replaced by a later ACP.
- `DEPRECATED` — obsolete; do not follow.
