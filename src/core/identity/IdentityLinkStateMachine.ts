/**
 * core/identity/IdentityLinkStateMachine.ts — S0.2.2
 *
 * The canonical IdentityLink state machine (Article XV — IdentityLink State
 * Machine is Canonical).
 *
 * Per Article XIV §1-6, the lifecycle of an IdentityLink is a strict finite
 * state machine:
 *
 *   ASSERTED  ──VERIFY──▶  VERIFIED  ──REVOKE──▶  REVOKED
 *      │
 *      └──EXPIRE──▶  EXPIRED
 *
 *   (terminal: EXPIRED, REVOKED — no further transitions)
 *
 * All transitions go through this module. The module is pure:
 *   - it does not touch the database,
 *   - it does not touch the in-memory IdentityGraph,
 *   - it does not perform cryptographic verification.
 *
 * The module's ONLY job is: "given the current state and an event, is the
 * transition legal? If yes, return the new state. If no, throw LinkStateError."
 *
 * Side-effects (DB writes, in-memory cache updates, audit events) are the
 * CALLER'S responsibility — but the caller MUST call `transition()` first,
 * so that the legality check is centralized and cannot be bypassed.
 *
 * S0.2.2 (this module) was added because the previous implementation in
 * `IdentityGraph.ts` allowed illegal transitions implicitly (e.g., `link()`
 * set state to VERIFIED directly, skipping the ASSERTED→VERIFIED transition;
 * `revoke()` deleted the entry, which silently allowed a re-link to a
 * "fresh" state — both violations of Article XIV §1 and §6).
 *
 * ARCH-049 — IdentityLink state machine is canonical.
 */

import type { IdentityLinkEvent, VerificationState } from './types';

/**
 * Re-export the canonical types so callers can import them from a single
 * module surface. The types themselves live in `./types` per Article II
 * (universal identity is a transport-independent principal).
 */
export type { IdentityLinkEvent, VerificationState };

/**
 * Transition table. `transitionTable[from][event] = to`.
 * Absent entries are illegal transitions.
 */
export const TRANSITION_TABLE: Record<VerificationState, Partial<Record<IdentityLinkEvent, VerificationState>>> = {
  ASSERTED: {
    VERIFY: 'VERIFIED',
    EXPIRE: 'EXPIRED',
    // ASSERT, REVOKE — illegal from ASSERTED
  },
  VERIFIED: {
    REVOKE: 'REVOKED',
    // ASSERT, VERIFY, EXPIRE — illegal from VERIFIED
  },
  EXPIRED: {
    // terminal — no further transitions
  },
  REVOKED: {
    // terminal — no further transitions
  },
};

/**
 * The initial state of a freshly-asserted link.
 */
export const INITIAL_LINK_STATE: VerificationState = 'ASSERTED';

/**
 * Terminal states — once entered, no further transitions are legal.
 */
export const TERMINAL_LINK_STATES: ReadonlySet<VerificationState> = new Set(['EXPIRED', 'REVOKED']);

/**
 * States that count as "not yet usable for dispatch" per Article XIV §7.
 * Only `VERIFIED` permits dispatch; everything else MUST be rejected.
 */
export const DISPATCH_PERMITTED_STATES: ReadonlySet<VerificationState> = new Set(['VERIFIED']);

/**
 * Error thrown when a state transition is illegal.
 * The error message intentionally does NOT reveal the new state — it only
 * reveals (from-state, event) so logs are debuggable without leaking
 * protocol semantics to a potential attacker who controls the inputs.
 */
export class LinkStateError extends Error {
  constructor(
    public readonly fromState: VerificationState,
    public readonly event: IdentityLinkEvent,
  ) {
    super(
      `Illegal IdentityLink transition: event '${event}' is not permitted from state '${fromState}' ` +
      `(Article XV §1, ARCH-049).`,
    );
    this.name = 'LinkStateError';
  }
}

/**
 * Compute the next state given a current state and an event.
 * Throws `LinkStateError` if the transition is illegal.
 *
 * @param from  current state
 * @param event triggering event
 * @returns the new state
 */
export function transition(from: VerificationState, event: IdentityLinkEvent): VerificationState {
  const to = TRANSITION_TABLE[from]?.[event];
  if (!to) {
    throw new LinkStateError(from, event);
  }
  return to;
}

/**
 * Non-throwing variant. Returns `null` if the transition is illegal
 * (useful for callers that want to log + skip rather than throw).
 */
export function tryTransition(from: VerificationState, event: IdentityLinkEvent): VerificationState | null {
  return TRANSITION_TABLE[from]?.[event] ?? null;
}

/**
 * Is the given transition legal? (does not throw)
 */
export function isLegalTransition(from: VerificationState, event: IdentityLinkEvent): boolean {
  return TRANSITION_TABLE[from]?.[event] !== undefined;
}

/**
 * Is the given state terminal (no further transitions legal)?
 */
export function isTerminal(state: VerificationState): boolean {
  return TERMINAL_LINK_STATES.has(state);
}

/**
 * Is the given state permitted for dispatch? (Article XIV §7)
 * Only VERIFIED links can resolve a recipient's encryption pubkey.
 */
export function isDispatchPermitted(state: VerificationState): boolean {
  return DISPATCH_PERMITTED_STATES.has(state);
}

/**
 * Return all events that are legal from the given state.
 * Useful for documentation, debugging, and the UI.
 */
export function legalEventsFrom(state: VerificationState): IdentityLinkEvent[] {
  return Object.keys(TRANSITION_TABLE[state] ?? {}) as IdentityLinkEvent[];
}

/**
 * Format the transition table as a human-readable string for documentation.
 * Used by tests to assert the table matches the constitution.
 */
export function formatTransitionTable(): string {
  const lines: string[] = [];
  for (const from of Object.keys(TRANSITION_TABLE) as VerificationState[]) {
    const events = legalEventsFrom(from);
    if (events.length === 0) {
      lines.push(`  ${from}  (terminal)`);
    } else {
      for (const ev of events) {
        const to = TRANSITION_TABLE[from][ev];
        lines.push(`  ${from}  ──${ev}──▶  ${to}`);
      }
    }
  }
  return lines.join('\n');
}
