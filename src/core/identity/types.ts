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

export type VerificationState =
  | 'UNVERIFIED'
  | 'VERIFIED'
  | 'REVOKED';

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
