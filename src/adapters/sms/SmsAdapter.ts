/**
 * adapters/sms/SmsAdapter.ts
 *
 * A demo SmsAdapter implementing the ChannelAdapter interface (ARCH-007, ARCH-029).
 * Same pattern as EmailAdapter — packages opaque bundle bytes into SMS payload
 * format, writes to an in-process transcript.
 *
 * STATUS: EXPERIMENTAL — in-process transcript only. Not real SMS (no Twilio,
 * no carrier API). Article X compliance: option (2) — clearly marked
 * experimental behind the ChannelAdapter boundary.
 *
 * THREAT_MODEL §1: does NOT decrypt the bundle payload. Packages opaque
 * ciphertext into the SMS body. The recipient's SMS client extracts and
 * decrypts.
 *
 * SMS constraint: SMS messages are limited to ~160 characters (GSM-7) or
 * ~70 characters (UCS-2). The opaque bundle is much larger, so the adapter
 * splits it across multiple SMS segments (like concatenated SMS / SMS PDUs).
 * The recipient's client reassembles.
 */

import type {
  ChannelAdapter,
  ChannelSendInput,
  ChannelSendResult,
  ChannelInbound,
} from '@/core/adapters/ChannelAdapter';
import type { CommunicationBundle } from '@/core/bundle/types';

export interface SmsTranscriptEntry {
  message_id: string;
  to: string;
  from: string;
  body: string;
  segments: number;
  sent_at: number;
  bundle_id: string;
}

export interface SmsTranscript {
  entries: SmsTranscriptEntry[];
}

export interface SmsAdapterDeps {
  adapter_id?: string;
  from_number: string;
  transcript?: SmsTranscript;
}

export class SmsAdapter implements ChannelAdapter {
  readonly channel = 'SMS' as const;
  readonly adapter_id: string;
  readonly display_name = 'SMS Adapter (EXPERIMENTAL — in-process transcript)';
  private from_number: string;
  private transcript: SmsTranscript;
  private inboundHandlers = new Set<(msg: ChannelInbound) => void>();
  private available = true;

  constructor(deps: SmsAdapterDeps) {
    this.adapter_id = deps.adapter_id ?? 'sms-adapter';
    this.from_number = deps.from_number;
    this.transcript = deps.transcript ?? { entries: [] };
  }

  isAvailable(): boolean { return this.available; }
  setUpAvailable(up: boolean): void { this.available = up; }

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    if (!this.available) return { kind: 'UNAVAILABLE', reason: 'sms adapter is down' };
    const bundle = input.bundle;
    const messageId = `sms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = formatSmsBody(bundle);
    // Simulate SMS segment count: 153 chars per segment (GSM-7 concatenated).
    const segments = Math.max(1, Math.ceil(body.length / 153));

    const entry: SmsTranscriptEntry = {
      message_id: messageId,
      to: input.recipient_channel_id,
      from: this.from_number,
      body,
      segments,
      sent_at: Date.now(),
      bundle_id: bundle.bundle_id,
    };
    this.transcript.entries.push(entry);
    return { kind: 'OK', external_message_id: messageId };
  }

  onInbound(handler: (msg: ChannelInbound) => void): void {
    this.inboundHandlers.add(handler);
  }

  getTranscript(): SmsTranscriptEntry[] {
    return [...this.transcript.entries];
  }

  clearTranscript(): void {
    this.transcript.entries.length = 0;
  }
}

/**
 * Format the opaque bundle as an SMS body. SMS is size-constrained, so the
 * body is a compact header + base64url ciphertext, split across segments
 * by the adapter. The recipient's SMS client reassembles and decrypts.
 */
export function formatSmsBody(bundle: CommunicationBundle): string {
  // Compact format: each line is a key=value pair, then ---CIPHERTEXT---.
  const lines = [
    `UCOS|${bundle.bundle_id.slice(0, 8)}`,
    `s=${bundle.sender.signing_pubkey_hash.slice(0, 8)}`,
    `r=${bundle.encryption_metadata.recipient_pubkey_hash.slice(0, 8)}`,
    `a=${bundle.encryption_metadata.algorithm}`,
    `n=${bundle.encryption_metadata.nonce.slice(0, 12)}`,
    `i=${bundle.intent.type}`,
    `p=${bundle.intent.priority}`,
    `e=${bundle.expires_at}`,
    '---CT---',
    bundle.payload.ciphertext,
  ];
  return lines.join('|');
}
