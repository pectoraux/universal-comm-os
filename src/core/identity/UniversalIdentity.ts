/**
 * core/identity/UniversalIdentity.ts
 *
 * Construct / inspect UniversalIdentity values. Pure, no IO, no outer deps.
 */

import type {
  ChannelIdentity,
  KeySet,
  UniversalIdentity,
  UniversalIdentityRef,
  VerificationState,
} from './types';
import { buildIdentityRef } from './keys';
import { randomUuid } from '@/core/util/encoding';

export interface CreateIdentityInput {
  id?: string;
  display_name?: string;
  key_set: KeySet;
  channel_identities?: ChannelIdentity[];
}

export function createUniversalIdentity(
  input: CreateIdentityInput,
): UniversalIdentity {
  const id = input.id ?? randomUuid();
  const ref = buildIdentityRef({
    id,
    key_set: input.key_set,
    display_name: input.display_name,
  });
  return {
    ...ref,
    public_keys: input.key_set,
    channel_identities: input.channel_identities ?? [],
    created_at: Date.now(),
  };
}

export function toRef(identity: UniversalIdentity): UniversalIdentityRef {
  return {
    id: identity.id,
    signing_pubkey_hash: identity.signing_pubkey_hash,
    display_name: identity.display_name,
  };
}

export function findChannelIdentity(
  identity: UniversalIdentity,
  channel: ChannelIdentity['channel'],
  channelId?: string,
): ChannelIdentity | undefined {
  return identity.channel_identities.find(
    (c) => c.channel === channel && (channelId === undefined || c.channel_id === channelId),
  );
}

export function attachChannelIdentity(
  identity: UniversalIdentity,
  channel: ChannelIdentity,
): UniversalIdentity {
  // Identity linking MUST NOT auto-merge based on unverified signals (ARCH-001).
  // The caller is responsible for proving verification first if they want state=VERIFIED.
  const exists = identity.channel_identities.some(
    (c) => c.channel === channel.channel && c.channel_id === channel.channel_id,
  );
  if (exists) return identity;
  return {
    ...identity,
    channel_identities: [...identity.channel_identities, channel],
  };
}

export function setChannelVerification(
  identity: UniversalIdentity,
  channel: ChannelIdentity['channel'],
  channelId: string,
  state: VerificationState,
): UniversalIdentity {
  return {
    ...identity,
    channel_identities: identity.channel_identities.map((c) =>
      c.channel === channel && c.channel_id === channelId
        ? { ...c, verified: state }
        : c,
    ),
  };
}
