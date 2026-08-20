/**
 * core/adapters/ChannelAdapter.ts
 *
 * The ChannelAdapter INTERFACE — lives in core (Architecture Constitution Article I.3).
 * Implementations live in src/adapters/* (email, sms, whatsapp, ...).
 *
 * Adapters translate between the universal communication model and external
 * channel semantics. The core MUST NOT contain `if whatsapp` / `if telegram` (ARCH-007).
 *
 * THREAT_MODEL §1 (Payload confidentiality): bundle payloads are end-to-end
 * encrypted to the recipient. Relays, gateways, and CHANNEL ADAPTERS do not
 * learn payload contents. The adapter therefore receives the OPAQUE bundle
 * (ciphertext + envelope metadata) — never plaintext — and packages those
 * opaque bytes into the channel-native format (e.g., email body).
 *
 * The recipient (who owns the X25519 secret key) decrypts on the other side
 * of the channel. The channel provider may see ciphertext at rest — that is
 * the channel-layer threat model, not the DTN-layer one.
 *
 * ARCH-029 (added in P6): the previous ChannelAdapter interface took
 * `plaintext: Uint8Array` — that violated THREAT_MODEL §1. The interface
 * now takes only the opaque bundle. This is a protocol-level correction,
 * not an architecture change (THREAT_MODEL was already authoritative).
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
   * Package the opaque bundle (ciphertext + envelope metadata) into the
   * channel-native message format and submit it via the channel's official API.
   *
   * The adapter MUST NOT attempt to decrypt the bundle payload. It MUST
   * package the opaque bytes (e.g., as an email body, SMS payload, etc.)
   * such that the recipient can extract and decrypt them on the other side.
   */
  send(input: ChannelSendInput): Promise<ChannelSendResult>;

  /** Receive inbound messages from the channel and emit them as bundle envelopes. */
  onInbound(handler: (msg: ChannelInbound) => void): void;
}

export interface ChannelSendInput {
  /** The opaque bundle — payload is encrypted to the recipient. */
  bundle: CommunicationBundle;
  /** Channel-specific recipient identifier (e.g., email address, phone number). */
  recipient_channel_id: string;
}

export interface ChannelInbound {
  channel: GatewayCapabilityType;
  sender_channel_id: string;
  recipient_channel_id: string;
  received_at: number;
  /** Opaque bundle bytes extracted from the channel-native message. */
  opaque_bundle: CommunicationBundle;
  metadata?: Record<string, string>;
}
