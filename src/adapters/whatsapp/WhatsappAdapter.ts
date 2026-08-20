/**
 * adapters/whatsapp/WhatsappAdapter.ts
 *
 * A demo WhatsappAdapter implementing the ChannelAdapter interface (ARCH-007,
 * ARCH-029). Same pattern as EmailAdapter/SmsAdapter — packages opaque bundle
 * bytes into a WhatsApp message format, writes to an in-process transcript.
 *
 * STATUS: EXPERIMENTAL — in-process transcript only. Not real WhatsApp Business
 * API. Article X compliance: option (2) — clearly marked experimental behind
 * the ChannelAdapter boundary.
 *
 * THREAT_MODEL §1: does NOT decrypt the bundle payload. Packages opaque
 * ciphertext into the WhatsApp message body. The recipient's WhatsApp client
 * extracts and decrypts.
 *
 * WhatsApp messages support up to 65536 characters (much larger than SMS),
 * so no segmentation is needed.
 */

import type {
  ChannelAdapter,
  ChannelSendInput,
  ChannelSendResult,
  ChannelInbound,
} from '@/core/adapters/ChannelAdapter';
import type { CommunicationBundle } from '@/core/bundle/types';

export interface WhatsappTranscriptEntry {
  message_id: string;
  to: string;
  from: string;
  body: string;
  sent_at: number;
  bundle_id: string;
}

export interface WhatsappTranscript {
  entries: WhatsappTranscriptEntry[];
}

export interface WhatsappAdapterDeps {
  adapter_id?: string;
  from_number: string;
  transcript?: WhatsappTranscript;
}

export class WhatsappAdapter implements ChannelAdapter {
  readonly channel = 'WHATSAPP' as const;
  readonly adapter_id: string;
  readonly display_name = 'WhatsApp Adapter (EXPERIMENTAL — in-process transcript)';
  private from_number: string;
  private transcript: WhatsappTranscript;
  private inboundHandlers = new Set<(msg: ChannelInbound) => void>();
  private available = true;

  constructor(deps: WhatsappAdapterDeps) {
    this.adapter_id = deps.adapter_id ?? 'whatsapp-adapter';
    this.from_number = deps.from_number;
    this.transcript = deps.transcript ?? { entries: [] };
  }

  isAvailable(): boolean { return this.available; }
  setUpAvailable(up: boolean): void { this.available = up; }

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    if (!this.available) return { kind: 'UNAVAILABLE', reason: 'whatsapp adapter is down' };
    const bundle = input.bundle;
    const messageId = `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = formatWhatsappBody(bundle);

    const entry: WhatsappTranscriptEntry = {
      message_id: messageId,
      to: input.recipient_channel_id,
      from: this.from_number,
      body,
      sent_at: Date.now(),
      bundle_id: bundle.bundle_id,
    };
    this.transcript.entries.push(entry);
    return { kind: 'OK', external_message_id: messageId };
  }

  onInbound(handler: (msg: ChannelInbound) => void): void {
    this.inboundHandlers.add(handler);
  }

  getTranscript(): WhatsappTranscriptEntry[] {
    return [...this.transcript.entries];
  }

  clearTranscript(): void {
    this.transcript.entries.length = 0;
  }
}

/**
 * Format the opaque bundle as a WhatsApp message body. WhatsApp supports
 * longer messages than SMS, so the format is similar to email (line-oriented).
 */
export function formatWhatsappBody(bundle: CommunicationBundle): string {
  const lines = [
    '---BEGIN UNIVERSAL COMM OS BUNDLE---',
    `bundle_id: ${bundle.bundle_id}`,
    `sender_id: ${bundle.sender.id}`,
    `sender_signing_pubkey_hash: ${bundle.sender.signing_pubkey_hash}`,
    `recipient_pubkey_hash: ${bundle.encryption_metadata.recipient_pubkey_hash}`,
    `algorithm: ${bundle.encryption_metadata.algorithm}`,
    `nonce: ${bundle.encryption_metadata.nonce}`,
    `additional_data: ${bundle.encryption_metadata.additional_data}`,
    `intent_type: ${bundle.intent.type}`,
    `priority: ${bundle.intent.priority}`,
    `conversation_id: ${bundle.conversation_id}`,
    `expires_at: ${bundle.expires_at}`,
    `proofs: ${bundle.proofs.length}`,
    '---CIPHERTEXT---',
    bundle.payload.ciphertext,
    '---END UNIVERSAL COMM OS BUNDLE---',
  ];
  return lines.join('\n');
}
