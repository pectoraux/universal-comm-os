/**
 * core/trust/Proof.ts
 *
 * Proofs (ARCH-014). A Proof is a signature over a canonical payload.
 */

import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8Encode, b64urlEncode, b64urlDecode } from '@/core/util/encoding';
import type { Proof, ProofKind } from '@/core/bundle/types';
import type { UniversalIdentityRef } from '@/core/identity/types';

/**
 * Canonical bytes that get signed for a given proof kind.
 * For SENDER_SIGNATURE, the canonical envelope bytes (from CommunicationBundle)
 * are passed in directly.
 */
export function canonicalProofPayload(
  kind: ProofKind,
  fields: Record<string, string | number | boolean>,
): Uint8Array {
  const flat = Object.entries(fields)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('|');
  return utf8Encode(`${kind}|${flat}`);
}

export function signProof(
  kind: ProofKind,
  fields: Record<string, string | number | boolean>,
  signer: UniversalIdentityRef,
  signing_secret_key: Uint8Array,
  ts: number = Date.now(),
): Proof {
  const payload = canonicalProofPayload(kind, fields);
  const payload_hash = b64urlEncode(sha256(payload));
  const sig = nacl.sign.detached(payload, signing_secret_key);
  return {
    kind,
    signer,
    signature: b64urlEncode(sig),
    payload_hash,
    ts,
  };
}

export function verifyProof(
  proof: Proof,
  fields: Record<string, string | number | boolean>,
  signer_public_key: Uint8Array,
): boolean {
  const payload = canonicalProofPayload(proof.kind, fields);
  const sig = b64urlDecode(proof.signature);
  return nacl.sign.detached.verify(payload, sig, signer_public_key);
}

/**
 * Convenience: build the canonical SENDER_SIGNATURE fields from a bundle envelope.
 * The signed fields MUST be the same set used by canonicalEnvelope in CommunicationBundle.
 */
export function senderSignatureFields(input: {
  bundle_id: string;
  sender_id: string;
  sender_signing_pubkey_hash: string;
  recipient_kind: string;
  recipient_descriptor: string;
  conversation_id: string;
  intent_type: string;
  priority: string;
  created_at: number;
  expires_at: number;
  algorithm: string;
  recipient_pubkey_hash: string;
  nonce: string;
  additional_data: string;
  payload_bytes_len: number;
  routing_policy_id: string;
  replication_factor: number;
  max_hops: number;
  require_e2e: boolean;
}): Record<string, string | number | boolean> {
  return { ...input };
}
