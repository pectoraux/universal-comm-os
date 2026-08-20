/**
 * core/identity/ChannelIdentity.ts
 */

import type { ChannelIdentity, ChannelType, VerificationProof } from './types';

export interface CreateChannelIdentityInput {
  channel: ChannelType;
  channel_id: string;
  verified?: ChannelIdentity['verified'];
  proof?: VerificationProof;
}

export function createChannelIdentity(
  input: CreateChannelIdentityInput,
): ChannelIdentity {
  return {
    channel: input.channel,
    channel_id: input.channel_id,
    verified: input.verified ?? 'ASSERTED',
    linked_at: Date.now(),
    proof: input.proof,
  };
}
