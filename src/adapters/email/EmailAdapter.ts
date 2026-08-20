/**
 * adapters/email/EmailAdapter.ts
 *
 * A demo EmailAdapter that implements the ChannelAdapter interface (ARCH-007,
 * ARCH-029). It "sends" emails by writing them to an in-process transcript.
 *
 * STATUS: EXPERIMENTAL — in-process transcript only. Not real SMTP.
 * Article X compliance: this is option (2) "clearly marked experimental behind
 * a boundary." The boundary is the ChannelAdapter interface; production
 * implementations swap in real SMTP without touching the core protocol.
 *
 * THREAT_MODEL §1: this adapter does NOT decrypt the bundle payload. It
 * packages the opaque ciphertext + envelope metadata into the email body
 * as base64url. The recipient's email client extracts and decrypts.
 *
 * Architecture: lives in src/adapters/. May import core/* (ChannelAdapter
 * interface, types). MUST NOT import matrix/* or transport/* (Architecture
 * Constitution Article I.3).
 */

import type {
  ChannelAdapter,
  ChannelSendInput,
  ChannelSendResult,
  ChannelInbound,
} from '@/core/adapters/ChannelAdapter';
import type { CommunicationBundle } from '@/core/bundle/types';
import { b64urlEncode } from '@/core/util/encoding';

export interface EmailTranscriptEntry {
  message_id: string;
  to: string;
  from: string;
  subject: string;
  body: string; // base64url(opaque ciphertext) + envelope metadata
  sent_at: number;
  bundle_id: string;
}

/**
 * In-process email transcript. In production, this would be a real SMTP
 * server's outbox. Here it's a list the UI can render.
 */
export interface EmailTranscript {
  entries: EmailTranscriptEntry[];
}

export interface EmailAdapterDeps {
  adapter_id?: string;
  /** Sender email address — used as the From header. */
  from_address: string;
  /** Transcript sink (typically the GatewayRuntime's transcript). */
  transcript?: EmailTranscript;
}

export class EmailAdapter implements ChannelAdapter {
  readonly channel = 'EMAIL' as const;
  readonly adapter_id: string;
  readonly display_name = 'Email Adapter (EXPERIMENTAL — in-process transcript)';
  private from_address: string;
  private transcript: EmailTranscript;
  private inboundHandlers = new Set<(msg: ChannelInbound) => void>();
  private available = true;

  constructor(deps: EmailAdapterDeps) {
    this.adapter_id = deps.adapter_id ?? 'email-adapter';
    this.from_address = deps.from_address;
    this.transcript = deps.transcript ?? { entries: [] };
  }

  isAvailable(): boolean {
    return this.available;
  }

  setUpAvailable(up: boolean): void {
    this.available = up;
  }

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    if (!this.available) {
      return { kind: 'UNAVAILABLE', reason: 'email adapter is down' };
    }
    const bundle = input.bundle;
    const messageId = `email-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Package the opaque bundle into an email body. The body contains:
    //   - envelope metadata (so the recipient can identify the bundle)
    //   - the opaque ciphertext as base64url
    // The recipient's email client parses this and decrypts locally.
    const body = formatEmailBody(bundle);

    const entry: EmailTranscriptEntry = {
      message_id: messageId,
      to: input.recipient_channel_id,
      from: this.from_address,
      subject: `[Universal Comm OS] Bundle ${bundle.bundle_id.slice(0, 8)}…`,
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

  /** Test helper: simulate an inbound email (would be a real IMAP poll in production). */
  simulateInbound(input: {
    sender_channel_id: string;
    recipient_channel_id: string;
    opaque_bundle: CommunicationBundle;
  }): void {
    const msg: ChannelInbound = {
      channel: 'EMAIL',
      sender_channel_id: input.sender_channel_id,
      recipient_channel_id: input.recipient_channel_id,
      received_at: Date.now(),
      opaque_bundle: input.opaque_bundle,
    };
    for (const h of this.inboundHandlers) h(msg);
  }

  /** Return a copy of the transcript for UI rendering. */
  getTranscript(): EmailTranscriptEntry[] {
    return [...this.transcript.entries];
  }

  /** Clear the transcript (for the "Reset Network" UI action). */
  clearTranscript(): void {
    this.transcript.entries.length = 0;
  }
}

/**
 * Format the opaque bundle as an email body. The recipient's email client
 * parses this format and reconstructs the bundle for local decryption.
 *
 * Format (deliberately simple, line-oriented, human-inspectable):
 *   ---BEGIN UNIVERSAL COMM OS BUNDLE---
 *   bundle_id: <uuid>
 *   sender_id: <id>
 *   sender_signing_pubkey_hash: <hash>
 *   recipient_pubkey_hash: <hash>
 *   algorithm: <alg>
 *   nonce: <b64url>
 *   additional_data: <string>
 *   intent_type: <type>
 *   priority: <priority>
 *   conversation_id: <id>
 *   expires_at: <epoch_ms>
 *   proofs: <count>
 *   ---CIPHERTEXT---
 *   <b64url ciphertext, possibly wrapped>
 *   ---END UNIVERSAL COMM OS BUNDLE---
 */
export function formatEmailBody(bundle: CommunicationBundle): string {
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
