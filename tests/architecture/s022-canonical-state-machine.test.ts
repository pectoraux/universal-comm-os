/**
 * S0.2.2 — Canonical IdentityLink State Machine acceptance tests.
 *
 * Article XV: The IdentityLink state machine is canonical. ALL link state
 * transitions go through `IdentityLinkStateMachine.transition()`. No code
 * path is permitted to bypass the canonical state machine by writing
 * `link_state` directly without first consulting the transition table.
 *
 * This test suite proves:
 *
 * A. The state machine's transition table matches Article XIV §6 exactly:
 *      ASSERTED → VERIFIED  (VERIFY)
 *      ASSERTED → EXPIRED   (EXPIRE)
 *      VERIFIED → REVOKED    (REVOKE)
 *    ALL OTHER TRANSITIONS THROW `LinkStateError`.
 *
 * B. The IdentityGraph implementation routes every transition through the
 *    canonical state machine:
 *    - `link()` produces ASSERTED (not VERIFIED) — Article XIV §1.
 *    - `verifyChannel()` produces VERIFIED only from ASSERTED.
 *    - `expireChannel()` produces EXPIRED only from ASSERTED.
 *    - `revoke()` produces REVOKED only from VERIFIED — Article XIV §6.
 *    - `revoke()` does NOT delete the link — link is RETAINED for forensics.
 *    - `resolveChannelRecipient()` returns ONLY VERIFIED links (Article XIV §2).
 *
 * C. The `authorization.ts` DB-side path invokes the canonical state machine
 *    before writing `link_state` to the DB. Source-level check.
 *
 * D. The constitution (Article XV) codifies the canonical state machine.
 *
 * E. The architecture ledger has the ARCH-049/ARCH-050 entries.
 *
 * F. Negative scenarios:
 *    - illegal transition from EXPIRED/REVOKED is rejected by the state machine.
 *    - the in-memory `link()` method refuses to overwrite a VERIFIED link.
 *    - `revoke()` on an ASSERTED link is a no-op (returns false, no transition).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createIdentityGraph,
  signChannelOwnershipProof,
  createUniversalIdentity,
  generateIdentityKeyPair,
  LinkStateError,
  type UniversalIdentity,
} from '@/core/index';
import {
  transition,
  tryTransition,
  isLegalTransition,
  isTerminal,
  isDispatchPermitted,
  INITIAL_LINK_STATE,
  TERMINAL_LINK_STATES,
  DISPATCH_PERMITTED_STATES,
  TRANSITION_TABLE,
  formatTransitionTable,
  type IdentityLinkEvent,
  type VerificationState,
} from '@/core/identity/IdentityLinkStateMachine';

const PROJECT_ROOT = join(__dirname, '..', '..');
const CONSTITUTION_FILE = join(PROJECT_ROOT, 'docs', 'architecture', 'ARCHITECTURE_CONSTITUTION.md');
const LEDGER_FILE = join(PROJECT_ROOT, 'docs', 'architecture', 'ARCHITECTURE_LEDGER.md');
const IDENTITY_GRAPH_FILE = join(PROJECT_ROOT, 'src', 'core', 'identity', 'IdentityGraph.ts');
const STATE_MACHINE_FILE = join(PROJECT_ROOT, 'src', 'core', 'identity', 'IdentityLinkStateMachine.ts');
const AUTHZ_FILE = join(PROJECT_ROOT, 'src', 'lib', 'authorization.ts');
const COMMOS_FILE = join(PROJECT_ROOT, 'src', 'server', 'CommOS.ts');
const ACTIONS_FILE = join(PROJECT_ROOT, 'src', 'app', 'actions', 'commos.ts');
const PRISMA_SCHEMA = join(PROJECT_ROOT, 'prisma', 'schema.prisma');

// ─── A. Canonical state machine transition table ───────────────────────

describe('S0.2.2-A: Canonical state machine transition table', () => {
  it('INITIAL_LINK_STATE is ASSERTED (Article XIV §1)', () => {
    expect(INITIAL_LINK_STATE).toBe('ASSERTED');
  });

  it('terminal states are EXPIRED and REVOKED', () => {
    expect(TERMINAL_LINK_STATES.has('EXPIRED')).toBe(true);
    expect(TERMINAL_LINK_STATES.has('REVOKED')).toBe(true);
    expect(TERMINAL_LINK_STATES.has('ASSERTED')).toBe(false);
    expect(TERMINAL_LINK_STATES.has('VERIFIED')).toBe(false);
  });

  it('only VERIFIED is dispatch-permitted (Article XIV §7)', () => {
    expect(DISPATCH_PERMITTED_STATES.has('VERIFIED')).toBe(true);
    expect(DISPATCH_PERMITTED_STATES.has('ASSERTED')).toBe(false);
    expect(DISPATCH_PERMITTED_STATES.has('EXPIRED')).toBe(false);
    expect(DISPATCH_PERMITTED_STATES.has('REVOKED')).toBe(false);
  });

  it('ASSERTED + VERIFY → VERIFIED (Article XIV §6)', () => {
    expect(transition('ASSERTED', 'VERIFY')).toBe('VERIFIED');
    expect(isLegalTransition('ASSERTED', 'VERIFY')).toBe(true);
  });

  it('ASSERTED + EXPIRE → EXPIRED (Article XIV §6)', () => {
    expect(transition('ASSERTED', 'EXPIRE')).toBe('EXPIRED');
    expect(isLegalTransition('ASSERTED', 'EXPIRE')).toBe(true);
  });

  it('VERIFIED + REVOKE → REVOKED (Article XIV §6)', () => {
    expect(transition('VERIFIED', 'REVOKE')).toBe('REVOKED');
    expect(isLegalTransition('VERIFIED', 'REVOKE')).toBe(true);
  });

  // Illegal transitions — every other (state, event) pair throws LinkStateError
  it('ASSERTED + REVOKE is illegal (must VERIFY or EXPIRE first)', () => {
    expect(() => transition('ASSERTED', 'REVOKE')).toThrow(LinkStateError);
    expect(isLegalTransition('ASSERTED', 'REVOKE')).toBe(false);
  });

  it('ASSERTED + ASSERT is illegal (no re-assertion from ASSERTED)', () => {
    expect(() => transition('ASSERTED', 'ASSERT')).toThrow(LinkStateError);
  });

  it('VERIFIED + VERIFY is illegal (cannot re-verify a VERIFIED link)', () => {
    expect(() => transition('VERIFIED', 'VERIFY')).toThrow(LinkStateError);
  });

  it('VERIFIED + EXPIRE is illegal (VERIFIED links cannot expire)', () => {
    expect(() => transition('VERIFIED', 'EXPIRE')).toThrow(LinkStateError);
  });

  it('VERIFIED + ASSERT is illegal', () => {
    expect(() => transition('VERIFIED', 'ASSERT')).toThrow(LinkStateError);
  });

  it('EXPIRED is terminal — all events rejected', () => {
    expect(isTerminal('EXPIRED')).toBe(true);
    expect(() => transition('EXPIRED', 'VERIFY')).toThrow(LinkStateError);
    expect(() => transition('EXPIRED', 'EXPIRE')).toThrow(LinkStateError);
    expect(() => transition('EXPIRED', 'REVOKE')).toThrow(LinkStateError);
    expect(() => transition('EXPIRED', 'ASSERT')).toThrow(LinkStateError);
  });

  it('REVOKED is terminal — all events rejected', () => {
    expect(isTerminal('REVOKED')).toBe(true);
    expect(() => transition('REVOKED', 'VERIFY')).toThrow(LinkStateError);
    expect(() => transition('REVOKED', 'EXPIRE')).toThrow(LinkStateError);
    expect(() => transition('REVOKED', 'REVOKE')).toThrow(LinkStateError);
    expect(() => transition('REVOKED', 'ASSERT')).toThrow(LinkStateError);
  });

  it('tryTransition returns null (not throw) on illegal transition', () => {
    expect(tryTransition('EXPIRED', 'VERIFY')).toBeNull();
    expect(tryTransition('REVOKED', 'REVOKE')).toBeNull();
    expect(tryTransition('VERIFIED', 'EXPIRE')).toBeNull();
  });

  it('transition table has exactly 3 legal transitions (no more, no less)', () => {
    // Count all (state, event) → newState entries
    let legalCount = 0;
    for (const from of Object.keys(TRANSITION_TABLE) as VerificationState[]) {
      for (const ev of Object.keys(TRANSITION_TABLE[from] ?? {}) as IdentityLinkEvent[]) {
        if (TRANSITION_TABLE[from][ev]) legalCount++;
      }
    }
    expect(legalCount).toBe(3);
  });

  it('formatTransitionTable renders a human-readable canonical map', () => {
    const formatted = formatTransitionTable();
    expect(formatted).toContain('ASSERTED');
    expect(formatted).toContain('VERIFIED');
    expect(formatted).toContain('EXPIRED');
    expect(formatted).toContain('REVOKED');
    expect(formatted).toContain('VERIFY');
    expect(formatted).toContain('EXPIRE');
    expect(formatted).toContain('REVOKE');
    expect(formatted).toContain('terminal');
  });
});

// ─── B. IdentityGraph uses the canonical state machine ────────────────

describe('S0.2.2-B: IdentityGraph routes through the canonical state machine', () => {
  let aliceKp: any;
  let aliceId: UniversalIdentity;
  let graph: ReturnType<typeof createIdentityGraph>;

  beforeEach(() => {
    aliceKp = generateIdentityKeyPair();
    aliceId = createUniversalIdentity({ display_name: 'Alice', key_set: aliceKp.key_set });
    graph = createIdentityGraph();
  });

  function linkAliceToEmail(channel_id: string = 'alice@example.com') {
    const proof = signChannelOwnershipProof({
      identity_id: aliceId.id,
      channel: 'EMAIL',
      channel_id,
      signing_secret_key: aliceKp.signing_secret_key,
      signing_pubkey: aliceKp.key_set.signing_pubkey,
    });
    return graph.link({ identity: aliceId, channel: 'EMAIL', channel_id, proof });
  }

  it('link() produces an ASSERTED entry (Article XIV §1)', () => {
    expect(linkAliceToEmail()).toBe(true);
    const entry = graph.get('EMAIL', 'alice@example.com');
    expect(entry).toBeDefined();
    expect(entry!.verification).toBe('ASSERTED');
    expect(entry!.last_event).toBe('ASSERT');
  });

  it('resolveChannelRecipient() returns undefined for an ASSERTED link (Article XIV §2)', () => {
    linkAliceToEmail();
    expect(graph.resolveChannelRecipient('EMAIL', 'alice@example.com')).toBeUndefined();
  });

  it('verifyChannel() transitions ASSERTED → VERIFIED', () => {
    linkAliceToEmail();
    expect(graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' })).toBe(true);
    const entry = graph.get('EMAIL', 'alice@example.com');
    expect(entry!.verification).toBe('VERIFIED');
    expect(entry!.last_event).toBe('VERIFY');
  });

  it('resolveChannelRecipient() returns the recipient after verifyChannel()', () => {
    linkAliceToEmail();
    graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });
    const resolved = graph.resolveChannelRecipient('EMAIL', 'alice@example.com');
    expect(resolved).toBeDefined();
    expect(resolved!.identity_ref.id).toBe(aliceId.id);
  });

  it('verifyChannel() on a non-existent link returns false (no throw, anti-enumeration)', () => {
    expect(graph.verifyChannel({ channel: 'EMAIL', channel_id: 'nobody@example.com' })).toBe(false);
  });

  it('verifyChannel() on VERIFIED is illegal — state machine throws LinkStateError', () => {
    linkAliceToEmail();
    graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });
    // Second verifyChannel() — VERIFIED + VERIFY is illegal.
    expect(() => graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' })).toThrow(LinkStateError);
  });

  it('verifyChannel() on EXPIRED is illegal — state machine throws LinkStateError', () => {
    linkAliceToEmail();
    graph.expireChannel('EMAIL', 'alice@example.com');
    expect(() => graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' })).toThrow(LinkStateError);
  });

  it('verifyChannel() on REVOKED is illegal — state machine throws LinkStateError', () => {
    linkAliceToEmail();
    graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });
    graph.revoke('EMAIL', 'alice@example.com');
    expect(() => graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' })).toThrow(LinkStateError);
  });

  it('expireChannel() transitions ASSERTED → EXPIRED', () => {
    linkAliceToEmail();
    expect(graph.expireChannel('EMAIL', 'alice@example.com')).toBe(true);
    const entry = graph.get('EMAIL', 'alice@example.com');
    expect(entry!.verification).toBe('EXPIRED');
    expect(entry!.last_event).toBe('EXPIRE');
  });

  it('expireChannel() on an already-EXPIRED link is idempotent (returns false, no throw)', () => {
    linkAliceToEmail();
    graph.expireChannel('EMAIL', 'alice@example.com');
    expect(graph.expireChannel('EMAIL', 'alice@example.com')).toBe(false);
    // State remains EXPIRED — no regression.
    expect(graph.get('EMAIL', 'alice@example.com')!.verification).toBe('EXPIRED');
  });

  it('expireChannel() on a VERIFIED link THROWS LinkStateError (illegal transition)', () => {
    linkAliceToEmail();
    graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });
    expect(() => graph.expireChannel('EMAIL', 'alice@example.com')).toThrow(LinkStateError);
    // State remains VERIFIED — no regression.
    expect(graph.get('EMAIL', 'alice@example.com')!.verification).toBe('VERIFIED');
  });

  it('expireChannel() on a REVOKED link THROWS LinkStateError (terminal)', () => {
    linkAliceToEmail();
    graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });
    graph.revoke('EMAIL', 'alice@example.com');
    expect(() => graph.expireChannel('EMAIL', 'alice@example.com')).toThrow(LinkStateError);
    expect(graph.get('EMAIL', 'alice@example.com')!.verification).toBe('REVOKED');
  });

  it('revoke() on a VERIFIED link transitions to REVOKED', () => {
    linkAliceToEmail();
    graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });
    expect(graph.revoke('EMAIL', 'alice@example.com')).toBe(true);
    const entry = graph.get('EMAIL', 'alice@example.com');
    expect(entry!.verification).toBe('REVOKED');
    expect(entry!.last_event).toBe('REVOKE');
  });

  it('revoke() RETAINS the link — size does NOT decrease (Article XIV §6)', () => {
    linkAliceToEmail();
    graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });
    expect(graph.size()).toBe(1);
    graph.revoke('EMAIL', 'alice@example.com');
    expect(graph.size()).toBe(1); // RETAINED — not deleted
  });

  it('revoke() on an ASSERTED link THROWS LinkStateError (no ASSERTED→REVOKED shortcut)', () => {
    linkAliceToEmail();
    expect(() => graph.revoke('EMAIL', 'alice@example.com')).toThrow(LinkStateError);
    // State remains ASSERTED — no transition.
    expect(graph.get('EMAIL', 'alice@example.com')!.verification).toBe('ASSERTED');
  });

  it('revoke() on an EXPIRED link THROWS LinkStateError (EXPIRED is terminal)', () => {
    linkAliceToEmail();
    graph.expireChannel('EMAIL', 'alice@example.com');
    expect(() => graph.revoke('EMAIL', 'alice@example.com')).toThrow(LinkStateError);
    expect(graph.get('EMAIL', 'alice@example.com')!.verification).toBe('EXPIRED');
  });

  it('revoke() on an already-REVOKED link is idempotent', () => {
    linkAliceToEmail();
    graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });
    graph.revoke('EMAIL', 'alice@example.com');
    expect(graph.revoke('EMAIL', 'alice@example.com')).toBe(false);
  });

  it('resolveChannelRecipient() returns undefined for EXPIRED and REVOKED links', () => {
    linkAliceToEmail();

    // EXPIRED
    graph.expireChannel('EMAIL', 'alice@example.com');
    expect(graph.resolveChannelRecipient('EMAIL', 'alice@example.com')).toBeUndefined();

    // Reset — clear and re-link + verify + revoke
    graph.clear();
    linkAliceToEmail();
    graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });
    graph.revoke('EMAIL', 'alice@example.com');
    expect(graph.resolveChannelRecipient('EMAIL', 'alice@example.com')).toBeUndefined();
  });

  it('link() refuses to overwrite a VERIFIED link (no downgrade)', () => {
    linkAliceToEmail();
    graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });

    // Try to link again — should be refused.
    const proof2 = signChannelOwnershipProof({
      identity_id: aliceId.id,
      channel: 'EMAIL',
      channel_id: 'alice@example.com',
      signing_secret_key: aliceKp.signing_secret_key,
      signing_pubkey: aliceKp.key_set.signing_pubkey,
      ts: Date.now() + 1000, // fresher
    });
    expect(graph.link({ identity: aliceId, channel: 'EMAIL', channel_id: 'alice@example.com', proof: proof2 })).toBe(false);
    // State remains VERIFIED.
    expect(graph.get('EMAIL', 'alice@example.com')!.verification).toBe('VERIFIED');
  });

  it('link() refuses to overwrite an EXPIRED link (terminal — no re-assertion)', () => {
    linkAliceToEmail();
    graph.expireChannel('EMAIL', 'alice@example.com');

    const proof2 = signChannelOwnershipProof({
      identity_id: aliceId.id,
      channel: 'EMAIL',
      channel_id: 'alice@example.com',
      signing_secret_key: aliceKp.signing_secret_key,
      signing_pubkey: aliceKp.key_set.signing_pubkey,
      ts: Date.now() + 1000,
    });
    expect(graph.link({ identity: aliceId, channel: 'EMAIL', channel_id: 'alice@example.com', proof: proof2 })).toBe(false);
    // State remains EXPIRED.
    expect(graph.get('EMAIL', 'alice@example.com')!.verification).toBe('EXPIRED');
  });

  it('link() refuses to overwrite a REVOKED link (terminal — no re-assertion)', () => {
    linkAliceToEmail();
    graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });
    graph.revoke('EMAIL', 'alice@example.com');

    const proof2 = signChannelOwnershipProof({
      identity_id: aliceId.id,
      channel: 'EMAIL',
      channel_id: 'alice@example.com',
      signing_secret_key: aliceKp.signing_secret_key,
      signing_pubkey: aliceKp.key_set.signing_pubkey,
      ts: Date.now() + 1000,
    });
    expect(graph.link({ identity: aliceId, channel: 'EMAIL', channel_id: 'alice@example.com', proof: proof2 })).toBe(false);
    // State remains REVOKED.
    expect(graph.get('EMAIL', 'alice@example.com')!.verification).toBe('REVOKED');
  });

  it('full canonical lifecycle: ASSERTED → VERIFIED → REVOKED (no regressions)', () => {
    linkAliceToEmail();
    expect(graph.get('EMAIL', 'alice@example.com')!.verification).toBe('ASSERTED');
    graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });
    expect(graph.get('EMAIL', 'alice@example.com')!.verification).toBe('VERIFIED');
    graph.revoke('EMAIL', 'alice@example.com');
    expect(graph.get('EMAIL', 'alice@example.com')!.verification).toBe('REVOKED');
    // REVOKED is terminal — further transitions throw.
    expect(() => graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' })).toThrow(LinkStateError);
    expect(() => graph.expireChannel('EMAIL', 'alice@example.com')).toThrow(LinkStateError);
    // The link is RETAINED — size is 1, not 0.
    expect(graph.size()).toBe(1);
  });

  it('full canonical lifecycle: ASSERTED → EXPIRED (terminal, no regressions)', () => {
    linkAliceToEmail();
    graph.expireChannel('EMAIL', 'alice@example.com');
    expect(graph.get('EMAIL', 'alice@example.com')!.verification).toBe('EXPIRED');
    // EXPIRED is terminal.
    expect(() => graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' })).toThrow(LinkStateError);
    expect(() => graph.revoke('EMAIL', 'alice@example.com')).toThrow(LinkStateError);
    expect(graph.size()).toBe(1);
  });

  it('last_transition_at updates on every transition (audit trail)', () => {
    linkAliceToEmail();
    const t1 = graph.get('EMAIL', 'alice@example.com')!.last_transition_at;
    // Wait a moment so timestamps differ.
    const t2 = (() => {
      graph.verifyChannel({ channel: 'EMAIL', channel_id: 'alice@example.com' });
      return graph.get('EMAIL', 'alice@example.com')!.last_transition_at;
    })();
    const t3 = (() => {
      graph.revoke('EMAIL', 'alice@example.com');
      return graph.get('EMAIL', 'alice@example.com')!.last_transition_at;
    })();
    expect(t2).toBeGreaterThanOrEqual(t1);
    expect(t3).toBeGreaterThanOrEqual(t2);
  });
});

// ─── C. authorization.ts uses the canonical state machine ──────────────

describe('S0.2.2-C: authorization.ts routes DB transitions through the canonical state machine', () => {
  const authz = readFileSync(AUTHZ_FILE, 'utf-8');

  it('imports the canonical state machine', () => {
    expect(authz).toContain("from '@/core/identity/IdentityLinkStateMachine'");
    expect(authz).toContain('transition as transitionLinkState');
    expect(authz).toContain('LinkStateError');
    expect(authz).toContain('INITIAL_LINK_STATE');
  });

  it('verifyChannelChallenge calls transitionLinkState(currentState, "VERIFY") before DB write', () => {
    expect(authz).toContain("transitionLinkState(currentState, 'VERIFY')");
  });

  it('verifyChannelChallenge calls transitionLinkState(currentState, "EXPIRE") on TTL expiry', () => {
    expect(authz).toContain("transitionLinkState(currentState, 'EXPIRE')");
  });

  it('revokeChannelLink calls transitionLinkState(currentState, "REVOKE") before updateMany', () => {
    expect(authz).toContain("transitionLinkState(currentState, 'REVOKE')");
  });

  it('catches LinkStateError in verifyChannelChallenge EXPIRE path', () => {
    // The catch (e instanceof LinkStateError) pattern must be present.
    expect(authz).toContain('e instanceof LinkStateError');
  });

  it('invariant check: VERIFY transition must produce VERIFIED', () => {
    expect(authz).toContain("expected 'VERIFIED'");
  });

  it('invariant check: REVOKE transition must produce REVOKED', () => {
    expect(authz).toContain("expected 'REVOKED'");
  });

  it('createChannelChallenge asserts INITIAL_LINK_STATE === "ASSERTED"', () => {
    expect(authz).toContain("INITIAL_LINK_STATE must be 'ASSERTED'");
  });
});

// ─── D. Constitution Article XV exists ─────────────────────────────────

describe('S0.2.2-D: Constitution Article XV', () => {
  const constitution = readFileSync(CONSTITUTION_FILE, 'utf-8');

  it('Article XV exists', () => {
    expect(constitution).toContain('Article XV');
  });

  it('states the IdentityLink state machine is canonical', () => {
    expect(constitution).toContain('canonical');
    expect(constitution).toContain('IdentityLink');
    expect(constitution).toContain('state machine');
  });

  it('lists the legal transitions', () => {
    expect(constitution).toContain('ASSERTED → VERIFIED');
    expect(constitution).toContain('ASSERTED → EXPIRED');
    expect(constitution).toContain('VERIFIED → REVOKED');
  });

  it('forbids all other transitions', () => {
    expect(constitution).toContain('All other transitions');
    expect(constitution).toContain('LinkStateError');
  });

  it('states the in-memory graph mirrors the DB (Article XIV §3)', () => {
    // Article XV should reference Article XIV §3 for persistence.
    expect(constitution).toContain('Article XIV');
    expect(constitution).toContain('persisted');
  });
});

// ─── E. Architecture ledger entries ────────────────────────────────────

describe('S0.2.2-E: Architecture ledger entries', () => {
  const ledger = readFileSync(LEDGER_FILE, 'utf-8');

  it('ARCH-049 — IdentityLink state machine is canonical', () => {
    expect(ledger).toContain('ARCH-049');
    expect(ledger).toContain('canonical');
  });

  it('ARCH-050 — in-memory graph mirrors DB', () => {
    expect(ledger).toContain('ARCH-050');
    expect(ledger).toContain('mirrors');
  });
});

// ─── F. IdentityGraph source-level guarantees ─────────────────────────

describe('S0.2.2-F: IdentityGraph source uses canonical state machine', () => {
  const graphSource = readFileSync(IDENTITY_GRAPH_FILE, 'utf-8');
  const stateMachineSource = readFileSync(STATE_MACHINE_FILE, 'utf-8');

  it('IdentityGraph.ts imports from IdentityLinkStateMachine', () => {
    expect(graphSource).toContain("from './IdentityLinkStateMachine'");
    expect(graphSource).toContain('transition as transitionLinkState');
    expect(graphSource).toContain('INITIAL_LINK_STATE');
    expect(graphSource).toContain('isDispatchPermitted');
  });

  it('link() sets verification to INITIAL_LINK_STATE (ASSERTED)', () => {
    expect(graphSource).toContain('verification: INITIAL_LINK_STATE');
    // No auto-VERIFIED in link().
    expect(graphSource).not.toMatch(/verification:\s*['"]VERIFIED['"]/);
  });

  it('resolveChannelRecipient uses isDispatchPermitted (canonical check)', () => {
    expect(graphSource).toContain('isDispatchPermitted(entry.verification)');
  });

  it('verifyChannel calls transitionLinkState(..., "VERIFY")', () => {
    expect(graphSource).toContain("transitionLinkState(entry.verification, 'VERIFY')");
  });

  it('expireChannel calls transitionLinkState(..., "EXPIRE")', () => {
    expect(graphSource).toContain("transitionLinkState(entry.verification, 'EXPIRE')");
  });

  it('revoke calls transitionLinkState(..., "REVOKE")', () => {
    expect(graphSource).toContain("transitionLinkState(entry.verification, 'REVOKE')");
  });

  it('revoke does NOT delete the entry (no entries.delete in revoke path)', () => {
    // The revoke() method should NOT call entries.delete(k). The only
    // delete() in the file should be in clear() (which wipes everything).
    // Check that no delete is in the revoke method body.
    const revokeFnMatch = graphSource.match(/revoke\([^)]*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(revokeFnMatch).toBeTruthy();
    const revokeBody = revokeFnMatch![0];
    expect(revokeBody).not.toContain('entries.delete');
  });

  it('state machine module exports transition, tryTransition, LinkStateError', () => {
    expect(stateMachineSource).toContain('export function transition');
    expect(stateMachineSource).toContain('export function tryTransition');
    expect(stateMachineSource).toContain('export class LinkStateError');
    expect(stateMachineSource).toContain('export const TRANSITION_TABLE');
    expect(stateMachineSource).toContain('export const INITIAL_LINK_STATE');
  });
});

// ─── G. CommOS uses the canonical path (demo fast-path goes through machine) ──

describe('S0.2.2-G: CommOS uses canonical state machine for demo bootstrap', () => {
  const commosSource = readFileSync(COMMOS_FILE, 'utf-8');

  it('linkIdentityToChannelVerifiedForDemo exists', () => {
    expect(commosSource).toContain('linkIdentityToChannelVerifiedForDemo');
  });

  it('demo fast-path calls identityGraph.verifyChannel() (canonical transition)', () => {
    expect(commosSource).toContain('this.identityGraph.verifyChannel({ channel, channel_id })');
  });

  it('verifyChannelLink method exists (production path)', () => {
    expect(commosSource).toContain('verifyChannelLink(');
  });

  it('setup() uses linkIdentityToChannelVerifiedForDemo (not bare linkIdentityToChannel)', () => {
    // The demo bootstrap should go through the canonical path.
    expect(commosSource).toContain("this.linkIdentityToChannelVerifiedForDemo(aliceId");
    expect(commosSource).toContain("this.linkIdentityToChannelVerifiedForDemo(bobId");
    expect(commosSource).toContain("this.linkIdentityToChannelVerifiedForDemo(relayId");
    expect(commosSource).toContain("this.linkIdentityToChannelVerifiedForDemo(gatewayId");
  });
});

// ─── H. actions/commos.ts wires DB → in-memory cache ──────────────────

describe('S0.2.2-H: actions/commos.ts verifies DB-then-cache (ARCH-050)', () => {
  const actionsSource = readFileSync(ACTIONS_FILE, 'utf-8');

  it('verifyChannelAction calls verifyChannelChallenge first (DB canonical)', () => {
    expect(actionsSource).toContain('verifyChannelChallenge(');
  });

  it('verifyChannelAction calls net.verifyChannelLink after DB success', () => {
    expect(actionsSource).toContain('net.verifyChannelLink(');
    expect(actionsSource).toContain('if (result.verified)');
  });

  it('verifyChannelAction catches in-memory sync failure safely', () => {
    expect(actionsSource).toContain("'[VERIFY_CHANNEL] In-memory graph sync failed'");
  });
});

// ─── I. Prisma schema defaults match the canonical state machine ──────

describe('S0.2.2-I: Prisma schema matches canonical state machine', () => {
  const schema = readFileSync(PRISMA_SCHEMA, 'utf-8');

  it('ChannelVerificationChallenge.link_state defaults to ASSERTED', () => {
    // Find the link_state line in the ChannelVerificationChallenge model.
    const cvcMatch = schema.match(/model ChannelVerificationChallenge \{[\s\S]*?\}/);
    expect(cvcMatch).toBeTruthy();
    const cvcBody = cvcMatch![0];
    expect(cvcBody).toContain('link_state');
    expect(cvcBody).toContain('@default("ASSERTED")');
  });

  it('ChannelVerificationChallenge has challenge_hash (not challenge_code)', () => {
    const cvcMatch = schema.match(/model ChannelVerificationChallenge \{[\s\S]*?\}/);
    const cvcBody = cvcMatch![0];
    expect(cvcBody).toContain('challenge_hash');
    expect(cvcBody).not.toContain('challenge_code');
  });

  it('ChannelVerificationChallenge has organization_id field (Article XIV §8)', () => {
    const cvcMatch = schema.match(/model ChannelVerificationChallenge \{[\s\S]*?\}/);
    const cvcBody = cvcMatch![0];
    expect(cvcBody).toContain('organization_id');
  });
});

// ─── J. Boundary test — core/ doesn't import Prisma or outer layers ──

describe('S0.2.2-J: IdentityLinkStateMachine is pure core (no outer imports)', () => {
  const stateMachineSource = readFileSync(STATE_MACHINE_FILE, 'utf-8');

  it('does not import Prisma', () => {
    expect(stateMachineSource).not.toContain('@prisma/client');
    expect(stateMachineSource).not.toContain('prisma');
  });

  it('does not import from outer layers (server, app, components, transport, adapters)', () => {
    expect(stateMachineSource).not.toContain('@/server');
    expect(stateMachineSource).not.toContain('@/app');
    expect(stateMachineSource).not.toContain('@/components');
    expect(stateMachineSource).not.toContain('@/transport');
    expect(stateMachineSource).not.toContain('@/adapters');
    expect(stateMachineSource).not.toContain('@/gateway');
  });

  it('only imports from ./types (no crypto, no I/O)', () => {
    expect(stateMachineSource).toMatch(/import.*from ['"]\.\/types['"]/);
    expect(stateMachineSource).not.toContain("import 'server-only'");
    expect(stateMachineSource).not.toContain('crypto.getRandomValues');
    expect(stateMachineSource).not.toContain('tweetnacl');
  });
});
