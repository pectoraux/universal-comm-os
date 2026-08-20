/**
 * core/bundle/CommunicationBundle.ts
 *
 * Bundle construction, canonical hashing, verification.
 * A Bundle is the smallest unit the routing layer may inspect.
 * Payload is opaque to relays.
 */

import type {
  CommunicationBundle,
  EncryptionMetadata,
  EncryptedPayload,
  Proof,
  Recipient,
  RoutingPolicyRef,
} from './types';
import type { Intent } from '@/core/intent/types';
import type { UniversalIdentityRef } from '@/core/identity/types';
import { randomUuid } from '@/core/util/encoding';

export interface CreateBundleInput {
  sender: UniversalIdentityRef;
  recipient: Recipient;
  conversation_id: string;
  intent: Intent;
  encryption_metadata: EncryptionMetadata;
  payload: EncryptedPayload;
  routing_policy: RoutingPolicyRef;
  proofs?: Proof[];
  /** Override defaults for testing. */
  bundle_id?: string;
  created_at?: number;
  expires_at?: number;
}

export function createBundle(input: CreateBundleInput): CommunicationBundle {
  const now = input.created_at ?? Date.now();
  const ttl = input.intent.ttl_ms ?? 24 * 60 * 60 * 1000; // default 24h
  const expires = input.expires_at ?? now + ttl;

  if (expires <= now) {
    throw new Error('createBundle: expires_at must be > created_at');
  }

  return Object.freeze({
    bundle_id: input.bundle_id ?? randomUuid(),
    sender: input.sender,
    recipient: input.recipient,
    conversation_id: input.conversation_id,
    intent: input.intent,
    created_at: now,
    expires_at: expires,
    priority: input.intent.priority,
    routing_policy: input.routing_policy,
    encryption_metadata: input.encryption_metadata,
    payload: input.payload,
    delivery_requirements: input.intent.delivery_requirement,
    proofs: input.proofs ?? [],
  });
}

/**
 * The canonical envelope bytes that a sender signs and a relay can verify.
 * Payload bytes are NOT included — only the payload_hash (from encryption_metadata).
 */
export function canonicalEnvelope(bundle: CommunicationBundle): Uint8Array {
  const parts = [
    bundle.bundle_id,
    bundle.sender.id,
    bundle.sender.signing_pubkey_hash,
    bundle.recipient.kind,
    bundle.recipient.kind === 'IDENTITY'
      ? bundle.recipient.ref.id
      : bundle.recipient.kind === 'CHANNEL'
        ? `${bundle.recipient.channel}:${bundle.recipient.channel_id}`
        : bundle.recipient.conversation_id,
    bundle.conversation_id,
    bundle.intent.type,
    bundle.intent.priority,
    String(bundle.created_at),
    String(bundle.expires_at),
    bundle.encryption_metadata.algorithm,
    bundle.encryption_metadata.recipient_pubkey_hash,
    bundle.encryption_metadata.nonce,
    bundle.encryption_metadata.additional_data,
    bundle.payload.bytes_len.toString(),
    bundle.routing_policy.policy_id,
    String(bundle.routing_policy.inline.replication_factor),
    String(bundle.routing_policy.inline.max_hops),
    String(bundle.routing_policy.inline.require_e2e),
  ];
  return new TextEncoder().encode(parts.join('|'));
}

export function isExpired(bundle: CommunicationBundle, now: number = Date.now()): boolean {
  return bundle.expires_at <= now;
}

export function appendProof(bundle: CommunicationBundle, proof: Proof): CommunicationBundle {
  return Object.freeze({
    ...bundle,
    proofs: [...bundle.proofs, proof],
  });
}
