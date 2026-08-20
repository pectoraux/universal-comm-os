/**
 * core/identity/types.ts
 *
 * Universal Identity primitives (ARCH-001).
 * A person is NOT a phone number, email, Matrix ID, or WhatsApp ID.
 * Those are ChannelIdentity instances attached to a UniversalIdentity.
 */

export type ChannelType =
  | 'MATRIX'
  | 'WHATSAPP'
  | 'SMS'
  | 'EMAIL'
  | 'RCS'
  | 'TELEGRAM'
  | 'INSTAGRAM'
  | 'MESSENGER'
  | 'DEVICE'
  | 'WEB'
  | 'DESKTOP'
  | 'UNKNOWN';

/**
 * Canonical IdentityLink verification state (Article XIV §1-6, ARCH-049).
 *
 * Lifecycle:
 *   ASSERTED  — link created via a signed CHANNEL_OWNERSHIP proof; the channel
 *               owner has NOT yet proven possession of the channel_id.
 *   VERIFIED  — the channel owner completed an in-band challenge-response
 *               proving they actually control the channel_id.
 *   EXPIRED   — the ASSERTED challenge's TTL elapsed before verification.
 *   REVOKED   — a previously-VERIFIED link has been administratively or
 *               owner-initiated revoked. The link is retained for forensics.
 *
 * State transitions (canonical, enforced by `IdentityLinkStateMachine`):
 *   ASSERTED → VERIFIED     (event VERIFY, requires challenge match)
 *   ASSERTED → EXPIRED      (event EXPIRE, TTL elapsed)
 *   VERIFIED → REVOKED      (event REVOKE)
 *
 * ALL OTHER TRANSITIONS ARE FORBIDDEN AND MUST THROW `LinkStateError`.
 *
 * S0.2.2 — the previous `'UNVERIFIED'` state is removed. It conflated
 * "no proof has been provided yet" with "an assertion has been made but not
 * verified." Article XIV separates these: the assertion (ASSERTED) is the
 * starting state, and it can only advance to VERIFIED or EXPIRED — never
 * regress to UNVERIFIED.
 */
export type VerificationState =
  | 'ASSERTED'
  | 'VERIFIED'
  | 'EXPIRED'
  | 'REVOKED';

/**
 * Events that drive the canonical IdentityLink state machine.
 * Each event corresponds to a legal transition (see ARCH-049 transition table).
 */
export type IdentityLinkEvent =
  | 'ASSERT'   // create a new link (initial state ASSERTED)
  | 'VERIFY'   // ASSERTED → VERIFIED (challenge-response succeeded)
  | 'EXPIRE'   // ASSERTED → EXPIRED  (TTL elapsed without verification)
  | 'REVOKE';  // VERIFIED → REVOKED   (administrative or owner-initiated)

/**
 * A reference to a UniversalIdentity that is safe to put inside an envelope
 * (no private material, no PII beyond an opaque identifier + pubkey hash).
 */
export interface UniversalIdentityRef {
  /** Opaque canonical identifier. May be a DID or a server-issued CUID. */
  readonly id: string;
  /** Hash of the signing public key (so relays can verify proofs). */
  readonly signing_pubkey_hash: string;
  /** Optional human-facing display name. */
  readonly display_name?: string;
}

export interface UniversalIdentity extends UniversalIdentityRef {
  readonly channel_identities: ReadonlyArray<ChannelIdentity>;
  readonly public_keys: KeySet;
  readonly created_at: number;
}

export interface ChannelIdentity {
  readonly channel: ChannelType;
  /** Channel-specific identifier (phone number, email, Matrix user ID, …). */
  readonly channel_id: string;
  readonly verified: VerificationState;
  readonly linked_at: number;
  readonly proof?: VerificationProof;
}

export interface KeySet {
  /** Ed25519 public key for signing bundles & proofs. */
  readonly signing_pubkey: Uint8Array;
  /** X25519 public key for sealed-box encryption. */
  readonly encryption_pubkey: Uint8Array;
}

export interface VerificationProof {
  readonly kind: VerificationProofKind;
  /** Opaque proof blob — verifier knows how to interpret per kind. */
  readonly blob: Uint8Array;
  readonly verifier?: UniversalIdentityRef;
  readonly verified_at: number;
}

export type VerificationProofKind =
  | 'CHANNEL_OWNERSHIP'
  | 'THIRD_PARTY_ATTESTATION'
  | 'IN_BAND_VERIFICATION';
