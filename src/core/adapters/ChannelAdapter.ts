/**
 * core/adapters/ChannelAdapter.ts
 *
 * The ChannelAdapter INTERFACE — lives in core (Architecture Constitution Article I.3).
 * Implementations live in src/adapters/* (email, sms, whatsapp, ...).
 *
 * Adapters translate between the universal communication model and external
 * channel semantics. The core MUST NOT contain `if whatsapp` / `if telegram` (ARCH-007).
 */

import type { CommunicationBundle } from '@/core/bundle/types';
import type { GatewayCapabilityType } from '@/core/capabilities/types';

export interface ChannelSendResult {
  kind: 'OK' | 'UNAVAILABLE' | 'REJECTED' | 'ERROR';
  external_message_id?: string;
  reason?: string;
}

export interface ChannelAdapter {
  readonly channel: GatewayCapabilityType;
  readonly adapter_id: string;
  readonly display_name: string;

  isAvailable(): boolean;

  /**
   * Translate a (decrypted) bundle envelope to an external-channel-native message
   * and submit it via the channel's official API. The caller is responsible for
   * decryption; the adapter receives plaintext only at the gateway boundary.
   */
  send(input: ChannelSendInput): Promise<ChannelSendResult>;

  /** Receive inbound messages from the channel and emit them as bundle envelopes. */
  onInbound(handler: (msg: ChannelInbound) => void): void;
}

export interface ChannelSendInput {
  bundle: CommunicationBundle;
  plaintext: Uint8Array;
  recipient_channel_id: string;
}

export interface ChannelInbound {
  channel: GatewayCapabilityType;
  sender_channel_id: string;
  recipient_channel_id: string;
  received_at: number;
  plaintext: Uint8Array;
  metadata?: Record<string, string>;
}
