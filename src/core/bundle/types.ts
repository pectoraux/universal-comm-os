/**
 * core/bundle/types.ts
 *
 * Communication Bundle (ARCH-003): the fundamental routable object.
 */

import type { Intent } from '@/core/intent/types';
import type { UniversalIdentityRef } from '@/core/identity/types';

export interface EncryptionMetadata {
  algorithm:
    | 'nacl-box-sealed'
    | 'nacl-box'
    | 'xchacha20-poly1305';
  /** Hash of the recipient's encryption public key (opaque to relays). */
  recipient_pubkey_hash: string;
  /** Hash of the sender's signing public key. */
  sender_pubkey_hash?: string;
  nonce: string; // b64url
  /** Additional data bound to the AEAD (bundle_id + intent.type + expires_at). */
  additional_data: string;
}

export interface EncryptedPayload {
  /** Opaque bytes the relay cannot read. */
  ciphertext: string; // b64url
  bytes_len: number;
}

export interface RoutingPolicyRef {
  policy_id: string;
  /** Inline minimum subset of the policy that the relay needs (e.g. replication factor). */
  inline: {
    replication_factor: number;
    max_hops: number;
    require_e2e: boolean;
  };
}

export interface CommunicationBundle {
  readonly bundle_id: string;
  readonly sender: UniversalIdentityRef;
  readonly recipient: Recipient;
  readonly conversation_id: string;
  readonly intent: Intent;
  readonly created_at: number;
  readonly expires_at: number;
  readonly priority: Intent['priority'];
  readonly routing_policy: RoutingPolicyRef;
  readonly encryption_metadata: EncryptionMetadata;
  readonly payload: EncryptedPayload;
  readonly delivery_requirements: Intent['delivery_requirement'];
  readonly proofs: Proof[];
}

export type Recipient =
  | { kind: 'IDENTITY'; ref: UniversalIdentityRef }
  | { kind: 'CHANNEL'; channel: string; channel_id: string }
  | { kind: 'CONVERSATION'; conversation_id: string };

/**
 * A Proof is a signed statement that some event happened to a bundle
 * (sender signed the bundle, relay forwarded, gateway reached, recipient read, ...).
 */
export interface Proof {
  kind: ProofKind;
  signer: UniversalIdentityRef;
  signature: string; // b64url
  payload_hash: string; // b64url of sha256(canonicalized proof payload)
  ts: number;
}

export type ProofKind =
  | 'SENDER_SIGNATURE'
  | 'RELAY_FORWARD'
  | 'GATEWAY_TRANSCRIPT'
  | 'DELIVERY_RECEIPT'
  | 'READ_RECEIPT';
