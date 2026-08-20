/**
 * core/identity/IdentityGraph.ts
 *
 * Universal Identity Graph (ROADMAP P10, hardened by S0.2.2).
 *
 * Per the master prompt:
 *   "P10 — Universal Identity Graph: identity linking, channel identities,
 *    verification, contact resolution, consent, preferences."
 *
 *   "## 18. IDENTITY GRAPH — Identity linking must not be based on unverified
 *    assumptions. Do not automatically merge accounts merely because:
 *    same name, same avatar, same phone number — unless the protocol has an
 *    appropriate verification mechanism."
 *
 * The IdentityGraph maps (channel, channel_id) → linked UniversalIdentityRef
 * with a verification state and a signed proof. A node queries the graph to
 * resolve "who owns bob@example.com?" before encrypting a bundle to that
 * recipient.
 *
 * ARCH-032 (P10): IdentityGraph is an interface in core. In-memory impl for
 * tests; Prisma-backed for production (future). Each node has its own graph
 * (per-node view, like CapabilityCache). In production, identity links are
 * propagated via a separate identity-gossip protocol OR a federated identity
 * directory.
 *
 * ARCH-033 (P10): the verification proof format is a signed Ed25519
 * signature over the canonical string
 *   `CHANNEL_OWNERSHIP|identity_id|channel|channel_id|ts`
 * using the channel owner's signing secret key. The verifier checks the
 * signature against the identity's signing pubkey.
 *
 * ARCH-034 (P10): contact resolution is `resolveChannelRecipient(
 * channel, channel_id) → { identity_ref, encryption_pubkey } | undefined`.
 * Returns undefined if no VERIFIED link exists — the caller MUST NOT encrypt
 * to an unverified recipient (THREAT_MODEL §16: identity impersonation).
 *
 * ARCH-049 (S0.2.2): all link state transitions go through the canonical
 * `IdentityLinkStateMachine`. The previous implementation auto-marked
 * `link()` output as `VERIFIED` (a direct violation of Article XIV §1 —
 * "New IdentityGraph links default to ASSERTED") and `revoke()` deleted
 * the entry (a direct violation of Article XIV §6 — REVOKED links MUST be
 * retained for forensics). Both defects are corrected here.
 *
 * ARCH-050 (S0.2.2): the in-memory IdentityGraph is a CACHE of the
 * persisted state in `ChannelVerificationChallenge` (Prisma). The DB is
 * canonical per Article XIV §3 ("Verification state is persisted in the
 * database, not in-memory. It survives restarts."). The in-memory graph
 * transitions mirror the DB transitions; they MUST go through the same
 * canonical state machine. Production callers MUST update the DB first;
 * only on DB success do they call the in-memory transition.
 *
 * S0.2.2 canonical lifecycle (see `IdentityLinkStateMachine.ts`):
 *   link()           → ASSERTED    (initial state, signed proof attests assertion)
 *   verifyChannel()  → ASSERTED → VERIFIED   (DB verified challenge-response)
 *   expireChannel()  → ASSERTED → EXPIRED    (TTL sweep, idempotent)
 *   revoke()         → VERIFIED → REVOKED    (link RETAINED — no deletion)
 *   resolveChannelRecipient()  → returns ONLY VERIFIED links
 */

import nacl from 'tweetnacl';
import { utf8Encode, b64urlEncode, b64urlDecode } from '@/core/util/encoding';
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  ChannelType,
  UniversalIdentity,
  UniversalIdentityRef,
  VerificationState,
  IdentityLinkEvent,
} from './types';
import {
  transition as transitionLinkState,
  isDispatchPermitted,
  INITIAL_LINK_STATE,
  LinkStateError,
} from './IdentityLinkStateMachine';

/** A linked channel identity in the graph. */
export interface LinkedChannelIdentity {
  readonly channel: ChannelType;
  readonly channel_id: string;
  readonly identity_ref: UniversalIdentityRef;
  /** The recipient's X25519 encryption pubkey (for sealing bundles to them). */
  readonly encryption_pubkey: Uint8Array;
  readonly verification: VerificationState;
  readonly linked_at: number;
  readonly proof: SignedChannelOwnershipProof;
  /**
   * S0.2.2 (ARCH-049) — when this link last transitioned states (auditable trail).
   * Set on `link()` (ASSERTED), updated on every `verifyChannel()` /
   * `expireChannel()` / `revoke()` transition.
   */
  readonly last_transition_at: number;
  /**
   * S0.2.2 (ARCH-049) — the most recent transition event applied to this link
   * (ASSERT | VERIFY | EXPIRE | REVOKE). Undefined until first transition
   * applied.
   */
  readonly last_event?: IdentityLinkEvent;
}

/** A signed proof that the identity owns the channel_id. */
export interface SignedChannelOwnershipProof {
  readonly kind: 'CHANNEL_OWNERSHIP';
  readonly identity_id: string;
  readonly channel: ChannelType;
  readonly channel_id: string;
  readonly ts: number;
  /** Ed25519 signature over the canonical payload, base64url-encoded. */
  readonly signature: string;
  /** The signer's Ed25519 public key, base64url-encoded. */
  readonly signing_pubkey: string;
}

export interface IdentityGraph {
  /**
   * Link a channel identity to a UniversalIdentity. Requires a valid signed
   * CHANNEL_OWNERSHIP proof; the proof is verified against the identity's
   * signing pubkey.
   *
   * S0.2.2 (Article XIV §1, ARCH-049): new links are created in state
   * `ASSERTED`. The signed proof only attests that the identity claims
   * ownership — it does NOT prove the identity actually controls the
   * channel_id (that requires an in-band challenge, see `verifyChannel()`).
   *
   * Returns true if a new ASSERTED link was created (or an existing ASSERTED
   * link was re-asserted with a strictly fresher proof). Returns false if:
   *  - the proof signature is invalid
   *  - the proof's identity_id/channel/channel_id don't match the input
   *  - a non-ASSERTED link already exists (no downgrades allowed)
   *  - an ASSERTED link exists with a proof at least as fresh (no-op)
   */
  link(input: {
    identity: UniversalIdentity;
    channel: ChannelType;
    channel_id: string;
    proof: SignedChannelOwnershipProof;
  }): boolean;

  /**
   * S0.2.2 (Article XIV §6, ARCH-049): transition a link from
   * ASSERTED → VERIFIED.
   *
   * Per ARCH-050, the in-memory graph is a CACHE of the DB state. The DB
   * has already verified the challenge hash (in `verifyChannelChallenge()`).
   * This method is called ONLY AFTER the DB transition succeeded; it
   * applies the canonical state machine to the in-memory cache.
   *
   * Throws `LinkStateError` if the link is in EXPIRED or REVOKED (no
   * regression to VERIFIED is possible — those states are terminal).
   * Returns false (no throw) if no link exists for the given (channel,
   * channel_id) — caller cannot distinguish "no link" from "wrong state",
   * matching the anti-enumeration policy of the DB path.
   */
  verifyChannel(input: {
    channel: ChannelType;
    channel_id: string;
  }): boolean;

  /**
   * S0.2.2 (Article XIV §6, ARCH-049): transition a link from
   * ASSERTED → EXPIRED when the challenge TTL has elapsed.
   *
   * Idempotent — calling on an EXPIRED link is a no-op (returns false without
   * throwing, so TTL sweepers can re-sweep safely). Calling on a VERIFIED or
   * REVOKED link THROWS `LinkStateError` (illegal transition — VERIFIED links
   * cannot expire; REVOKED is terminal). Callers that prefer silent denial
   * should wrap the call in try/catch.
   *
   * Returns true if the link was actually transitioned ASSERTED→EXPIRED.
   */
  expireChannel(channel: ChannelType, channel_id: string): boolean;

  /**
   * Resolve a channel recipient to their UniversalIdentityRef + encryption
   * pubkey. Returns undefined if no VERIFIED link exists.
   *
   * Per ARCH-034 and Article XIV §2: the caller MUST NOT encrypt to an
   * unverified recipient. ASSERTED, EXPIRED, and REVOKED links are
   * invisible to the dispatch path.
   */
  resolveChannelRecipient(channel: ChannelType, channel_id: string): {
    identity_ref: UniversalIdentityRef;
    encryption_pubkey: Uint8Array;
    proof: SignedChannelOwnershipProof;
  } | undefined;

  /** List all linked channel identities (for UI / observability). */
  snapshot(): LinkedChannelIdentity[];

  /** Get a specific link (regardless of verification state, for forensics). */
  get(channel: ChannelType, channel_id: string): LinkedChannelIdentity | undefined;

  /**
   * S0.2.2 (Article XIV §6, ARCH-049): revoke a link.
   *
   * Transitions VERIFIED → REVOKED via the canonical state machine. The
   * link is RETAINED in the graph (for forensics) — it is NOT deleted.
   * A REVOKED link is invisible to `resolveChannelRecipient()` (per §2).
   *
   * Idempotent — calling on an already-REVOKED link is a no-op (returns false
   * without throwing). Calling on an ASSERTED link THROWS `LinkStateError`
   * (illegal — ASSERTED links cannot transition directly to REVOKED; the
   * caller must VERIFY them first or EXPIRE them). Calling on an EXPIRED
   * link THROWS `LinkStateError` (terminal — cannot regress to REVOKED).
   * Callers that prefer silent denial should wrap the call in try/catch.
   *
   * Returns true only when the transition VERIFIED → REVOKED actually occurs.
   */
  revoke(channel: ChannelType, channel_id: string): boolean;

  /** Clear all entries. Test-only — wipes the graph entirely. */
  clear(): void;

  /** Number of entries (in any state, including EXPIRED and REVOKED). */
  size(): number;
}

// ──────────────────────────────────────────────────────────────────────
// Internal entry type
// ──────────────────────────────────────────────────────────────────────

interface InternalEntry {
  readonly channel: ChannelType;
  readonly channel_id: string;
  readonly identity_ref: UniversalIdentityRef;
  readonly encryption_pubkey: Uint8Array;
  verification: VerificationState;
  linked_at: number;
  last_transition_at: number;
  last_event?: IdentityLinkEvent;
  proof: SignedChannelOwnershipProof;
}

export function createIdentityGraph(): IdentityGraph {
  const entries = new Map<string, InternalEntry>(); // key = `${channel}|${channel_id}`

  const key = (channel: ChannelType, channel_id: string) => `${channel}|${channel_id}`;

  return {
    link({ identity, channel, channel_id, proof }) {
      // Verify the proof against the identity's signing pubkey.
      if (!verifyChannelOwnershipProof(proof, identity.public_keys.signing_pubkey)) {
        return false;
      }
      // The proof's identity_id and channel must match.
      if (proof.identity_id !== identity.id) return false;
      if (proof.channel !== channel) return false;
      if (proof.channel_id !== channel_id) return false;

      const k = key(channel, channel_id);
      const existing = entries.get(k);

      // S0.2.2 — no downgrades. If an entry already exists:
      //  - If it's ASSERTED, allow re-assertion with a strictly fresher proof.
      //  - If it's VERIFIED, EXPIRED, or REVOKED, refuse (caller must clear()
      //    first in test fixtures, or revoke first in production).
      if (existing) {
        if (existing.verification !== 'ASSERTED') {
          return false;
        }
        if (existing.proof.ts >= proof.ts) {
          return false;
        }
      }

      const now = Date.now();
      entries.set(k, {
        channel,
        channel_id,
        identity_ref: {
          id: identity.id,
          signing_pubkey_hash: identity.signing_pubkey_hash,
          display_name: identity.display_name,
        },
        encryption_pubkey: identity.public_keys.encryption_pubkey,
        verification: INITIAL_LINK_STATE, // ASSERTED — Article XIV §1
        linked_at: now,
        last_transition_at: now,
        last_event: 'ASSERT',
        proof,
      });
      return true;
    },

    verifyChannel({ channel, channel_id }) {
      const k = key(channel, channel_id);
      const entry = entries.get(k);
      if (!entry) {
        // S0.2.2 — no link exists. Return false (no throw) so caller cannot
        // distinguish "no link" from "wrong state" via thrown exception type.
        return false;
      }
      // S0.2.2 — canonical state machine: ASSERTED → VERIFIED only.
      // Throws LinkStateError if state is EXPIRED or REVOKED (terminal).
      const newState = transitionLinkState(entry.verification, 'VERIFY');
      entry.verification = newState;
      entry.last_transition_at = Date.now();
      entry.last_event = 'VERIFY';
      return true;
    },

    expireChannel(channel, channel_id) {
      const k = key(channel, channel_id);
      const entry = entries.get(k);
      if (!entry) return false;
      // Idempotent: if already EXPIRED, no-op (caller may be a TTL sweeper).
      if (entry.verification === 'EXPIRED') return false;
      // S0.2.2 (ARCH-049): consult the canonical state machine. Throws
      // LinkStateError for illegal transitions (VERIFIED → EXPIRED,
      // REVOKED → EXPIRE). The caller is responsible for catching.
      const newState = transitionLinkState(entry.verification, 'EXPIRE');
      entry.verification = newState;
      entry.last_transition_at = Date.now();
      entry.last_event = 'EXPIRE';
      return true;
    },

    resolveChannelRecipient(channel, channel_id) {
      const entry = entries.get(key(channel, channel_id));
      if (!entry) return undefined;
      // S0.2.2 — canonical: only VERIFIED links resolve (Article XIV §7).
      // isDispatchPermitted is the canonical check.
      if (!isDispatchPermitted(entry.verification)) return undefined;
      return {
        identity_ref: entry.identity_ref,
        encryption_pubkey: entry.encryption_pubkey,
        proof: entry.proof,
      };
    },

    snapshot() {
      return Array.from(entries.values()).map((e) => ({
        channel: e.channel,
        channel_id: e.channel_id,
        identity_ref: e.identity_ref,
        encryption_pubkey: e.encryption_pubkey,
        verification: e.verification,
        linked_at: e.linked_at,
        last_transition_at: e.last_transition_at,
        last_event: e.last_event,
        proof: e.proof,
      }));
    },

    get(channel, channel_id) {
      const e = entries.get(key(channel, channel_id));
      if (!e) return undefined;
      return {
        channel: e.channel,
        channel_id: e.channel_id,
        identity_ref: e.identity_ref,
        encryption_pubkey: e.encryption_pubkey,
        verification: e.verification,
        linked_at: e.linked_at,
        last_transition_at: e.last_transition_at,
        last_event: e.last_event,
        proof: e.proof,
      };
    },

    revoke(channel, channel_id) {
      const k = key(channel, channel_id);
      const entry = entries.get(k);
      if (!entry) return false;
      // Idempotent: if already REVOKED, no-op (caller may re-revoke safely).
      if (entry.verification === 'REVOKED') return false;
      // S0.2.2 (ARCH-049): consult the canonical state machine. Throws
      // LinkStateError for illegal transitions (ASSERTED → REVOKE,
      // EXPIRED → REVOKE). The caller is responsible for catching.
      const newState = transitionLinkState(entry.verification, 'REVOKE');
      entry.verification = newState;
      entry.last_transition_at = Date.now();
      entry.last_event = 'REVOKE';
      // The entry is RETAINED (NOT deleted) per Article XIV §6 — forensic trail.
      return true;
    },

    clear() {
      entries.clear();
    },

    size() {
      return entries.size;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Signed-channel-ownership proof helpers (ARCH-033).
// ──────────────────────────────────────────────────────────────────────

/**
 * Canonical payload that gets signed for a CHANNEL_OWNERSHIP proof.
 * Format: `CHANNEL_OWNERSHIP|identity_id|channel|channel_id|ts`
 */
export function canonicalChannelOwnershipPayload(
  identity_id: string,
  channel: ChannelType,
  channel_id: string,
  ts: number,
): Uint8Array {
  return utf8Encode(`CHANNEL_OWNERSHIP|${identity_id}|${channel}|${channel_id}|${ts}`);
}

/**
 * Sign a CHANNEL_OWNERSHIP proof using the identity's signing secret key.
 * The proof attests: "I, identity_id, own the channel_id 'channel_id' on
 * channel 'channel', at time ts."
 *
 * NOTE (S0.2.2): per Article XIV §1, a signed proof attests an ASSERTION,
 * not a verification. The link is created in ASSERTED state. To advance
 * to VERIFIED, the channel owner must complete an in-band challenge.
 */
export function signChannelOwnershipProof(input: {
  identity_id: string;
  channel: ChannelType;
  channel_id: string;
  signing_secret_key: Uint8Array;
  signing_pubkey: Uint8Array;
  ts?: number;
}): SignedChannelOwnershipProof {
  const ts = input.ts ?? Date.now();
  const payload = canonicalChannelOwnershipPayload(input.identity_id, input.channel, input.channel_id, ts);
  const sig = nacl.sign.detached(payload, input.signing_secret_key);
  return {
    kind: 'CHANNEL_OWNERSHIP',
    identity_id: input.identity_id,
    channel: input.channel,
    channel_id: input.channel_id,
    ts,
    signature: b64urlEncode(sig),
    signing_pubkey: b64urlEncode(input.signing_pubkey),
  };
}

/**
 * Verify a CHANNEL_OWNERSHIP proof against the identity's signing pubkey.
 * Returns true if the signature is valid AND the payload fields match.
 */
export function verifyChannelOwnershipProof(
  proof: SignedChannelOwnershipProof,
  signing_pubkey: Uint8Array,
): boolean {
  // The proof's signing_pubkey must match the identity's.
  if (b64urlEncode(signing_pubkey) !== proof.signing_pubkey) return false;
  const payload = canonicalChannelOwnershipPayload(proof.identity_id, proof.channel, proof.channel_id, proof.ts);
  const sig = b64urlDecode(proof.signature);
  return nacl.sign.detached.verify(payload, sig, signing_pubkey);
}

/**
 * Hash a public key for stable comparison (avoids comparing Uint8Arrays directly).
 */
export function pubkeyHash(pubkey: Uint8Array): string {
  return b64urlEncode(sha256(pubkey));
}

// ──────────────────────────────────────────────────────────────────────
// S0.2.2 — re-export canonical state machine primitives (consumed by
// tests + callers like CommOS / authorization.ts that want to validate
// a transition before invoking it on the graph).
// ──────────────────────────────────────────────────────────────────────

export { LinkStateError, INITIAL_LINK_STATE, isDispatchPermitted } from './IdentityLinkStateMachine';
