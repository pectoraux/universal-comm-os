/**
 * core/identity/IdentityGraph.ts
 *
 * Universal Identity Graph (ROADMAP P10).
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
 * ARCH-032 (added in P10): IdentityGraph is an interface in core. In-memory
 * impl for tests; Prisma-backed for production (future). Each node has its
 * own graph (per-node view, like CapabilityCache). In production, identity
 * links are propagated via a separate identity-gossip protocol (future work)
 * OR via a federated identity directory.
 *
 * ARCH-033 (added in P10): the verification proof format is a signed
 * Ed25519 signature over the canonical string
 *   `CHANNEL_OWNERSHIP|identity_id|channel|channel_id|ts`
 * using the channel owner's signing secret key. The verifier checks the
 * signature against the identity's signing pubkey.
 *
 * ARCH-034 (added in P10): contact resolution is `resolveChannelRecipient(
 * channel, channel_id) → { identity_ref, encryption_pubkey } | undefined`.
 * Returns undefined if no verified link exists — the caller MUST NOT encrypt
 * to an unverified recipient (THREAT_MODEL §16: identity impersonation).
 */

import nacl from 'tweetnacl';
import { utf8Encode, b64urlEncode, b64urlDecode } from '@/core/util/encoding';
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  ChannelType,
  UniversalIdentity,
  UniversalIdentityRef,
  VerificationState,
} from './types';

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
   * proof; the proof is verified against the identity's signing pubkey.
   * Returns true if the link was added (or updated).
   */
  link(input: {
    identity: UniversalIdentity;
    channel: ChannelType;
    channel_id: string;
    proof: SignedChannelOwnershipProof;
  }): boolean;

  /**
   * Resolve a channel recipient to their UniversalIdentityRef + encryption
   * pubkey. Returns undefined if no VERIFIED link exists.
   *
   * Per ARCH-034 and THREAT_MODEL §16: the caller MUST NOT encrypt to an
   * unverified recipient. UNVERIFIED links are skipped.
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

  /** Revoke a link (e.g., the user lost access to the channel). */
  revoke(channel: ChannelType, channel_id: string): boolean;

  /** Clear all entries. */
  clear(): void;

  /** Number of entries. */
  size(): number;
}

export function createIdentityGraph(): IdentityGraph {
  const entries = new Map<string, LinkedChannelIdentity>(); // key = `${channel}|${channel_id}`

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
      // Don't downgrade: a VERIFIED link can't be overwritten by an UNVERIFIED one.
      // (We don't have UNVERIFIED proofs in this minimal impl — all proofs are
      // signed, so all links are VERIFIED. But the check is here for the future.)
      if (existing && existing.verification === 'VERIFIED') {
        // Allow re-linking with a fresher proof.
        if (existing.proof.ts >= proof.ts) return false;
      }

      entries.set(k, {
        channel,
        channel_id,
        identity_ref: {
          id: identity.id,
          signing_pubkey_hash: identity.signing_pubkey_hash,
          display_name: identity.display_name,
        },
        encryption_pubkey: identity.public_keys.encryption_pubkey,
        verification: 'VERIFIED',
        linked_at: Date.now(),
        proof,
      });
      return true;
    },

    resolveChannelRecipient(channel, channel_id) {
      const entry = entries.get(key(channel, channel_id));
      if (!entry) return undefined;
      if (entry.verification !== 'VERIFIED') return undefined;
      return {
        identity_ref: entry.identity_ref,
        encryption_pubkey: entry.encryption_pubkey,
        proof: entry.proof,
      };
    },

    snapshot() {
      return Array.from(entries.values());
    },

    get(channel, channel_id) {
      return entries.get(key(channel, channel_id));
    },

    revoke(channel, channel_id) {
      const k = key(channel, channel_id);
      if (!entries.has(k)) return false;
      entries.delete(k);
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
