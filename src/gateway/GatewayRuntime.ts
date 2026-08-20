/**
 * gateway/GatewayRuntime.ts
 *
 * The gateway runtime (ROADMAP P6). Lives in src/gateway/ (Architecture
 * Constitution Article I.4). May import core/* and adapters/*.
 *
 * Responsibility:
 *   - Hold a registry of ChannelAdapter implementations (Email, SMS, WhatsApp, ...).
 *   - Receive a CommunicationBundle from a node's receiveBundle() when the
 *     recipient.kind === 'CHANNEL' AND this node advertises the matching
 *     GATEWAY capability.
 *   - Look up the right adapter for the recipient's channel.
 *   - Call adapter.send({bundle, recipient_channel_id}).
 *   - Transition the bundle's delivery state: GATEWAY_REACHED → EXTERNAL_ACCEPTED.
 *
 * THREAT_MODEL §1: the gateway does NOT decrypt the bundle. The adapter
 * receives opaque ciphertext and packages it into the channel-native format.
 *
 * ARCH-027 (added in P6): the gateway runtime is owned by the NodeRuntime
 * as an optional dep. When absent, CHANNEL-recipient bundles fall through
 * to DTN forwarding (P3 behavior).
 */

import type { ChannelAdapter, ChannelSendResult } from '@/core/adapters/ChannelAdapter';
import type { CommunicationBundle } from '@/core/bundle/types';
import type { GatewayCapabilityType } from '@/core/capabilities/types';

export interface GatewayHandleResult {
  /** Whether the gateway accepted and successfully submitted to the external channel. */
  status: 'OK' | 'NO_ADAPTER' | 'ADAPTER_UNAVAILABLE' | 'NOT_A_GATEWAY' | 'SEND_FAILED';
  /** External message id (from adapter.send), if available. */
  external_message_id?: string;
  /** Reason on failure. */
  reason?: string;
}

export interface GatewayRuntime {
  /** Register a ChannelAdapter implementation. */
  registerAdapter(adapter: ChannelAdapter): void;
  /** List registered channels. */
  listChannels(): GatewayCapabilityType[];
  /**
   * Attempt to handle a bundle whose recipient is a CHANNEL kind.
   * Returns NOT_A_GATEWAY if no adapter is registered for the recipient's channel.
   */
  handleBundle(input: {
    bundle: CommunicationBundle;
    recipient_channel: GatewayCapabilityType;
    recipient_channel_id: string;
  }): Promise<GatewayHandleResult>;
}

export function createGatewayRuntime(): GatewayRuntime {
  const adapters = new Map<GatewayCapabilityType, ChannelAdapter>();

  return {
    registerAdapter(adapter) {
      adapters.set(adapter.channel, adapter);
    },

    listChannels() {
      return Array.from(adapters.keys());
    },

    async handleBundle({ bundle, recipient_channel, recipient_channel_id }) {
      const adapter = adapters.get(recipient_channel);
      if (!adapter) {
        return { status: 'NO_ADAPTER', reason: `no adapter registered for channel ${recipient_channel}` };
      }
      if (!adapter.isAvailable()) {
        return { status: 'ADAPTER_UNAVAILABLE', reason: `adapter ${adapter.adapter_id} unavailable` };
      }
      let result: ChannelSendResult;
      try {
        result = await adapter.send({ bundle, recipient_channel_id });
      } catch (e) {
        return { status: 'SEND_FAILED', reason: String(e) };
      }
      if (result.kind === 'OK') {
        return { status: 'OK', external_message_id: result.external_message_id };
      }
      return { status: 'SEND_FAILED', reason: result.reason ?? result.kind };
    },
  };
}
