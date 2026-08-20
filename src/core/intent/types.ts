/**
 * core/intent/types.ts
 *
 * Communication Intent (ARCH-002).
 * The sender expresses WHAT they want. Transport selection belongs to routing.
 */

export type IntentType =
  | 'SEND_MESSAGE'
  | 'NOTIFY'
  | 'REQUEST_RESPONSE'
  | 'DELIVER_DOCUMENT'
  | 'SEND_MEDIA'
  | 'EMERGENCY_ALERT'
  | 'SYNC_CONVERSATION';

export type Priority =
  | 'BULK'
  | 'NORMAL'
  | 'PRIORITY'
  | 'URGENT'
  | 'EMERGENCY';

export type PrivacyClass =
  | 'PUBLIC'
  | 'STANDARD'
  | 'STRICT'
  | 'FORWARD_SECRECY';

export type DeliveryRequirement =
  | 'BEST_EFFORT'
  | 'AT_LEAST_ONCE'
  | 'EXACTLY_ONCE';

export type FallbackPolicy =
  | 'STRICT' // only use preferred_transports; fail otherwise
  | 'CASCADE' // try preferred first, then anything meeting constraints
  | 'EMERGENCY_ONLY'; // suppress nonessential transports, route via any emergency path

export type TransportCapability =
  | 'INTERNET'
  | 'WIFI'
  | 'BLE'
  | 'BLUETOOTH'
  | 'LAN'
  | 'WIFI_AWARE'
  | 'MATRIX'
  | 'SMS'
  | 'EMAIL'
  | 'WHATSAPP'
  | 'TELEGRAM'
  | 'INSTAGRAM'
  | 'MESSENGER'
  | 'RCS';

export interface PayloadConstraints {
  max_bytes?: number;
  allowed_media_types?: MediaType[];
}

export type MediaType =
  | 'TEXT'
  | 'LOW_RES_MEDIA'
  | 'FULL_MEDIA'
  | 'AUDIO'
  | 'VIDEO'
  | 'DOCUMENT';

export interface Intent {
  readonly type: IntentType;
  readonly priority: Priority;
  readonly ttl_ms?: number;
  readonly max_cost?: number;
  readonly max_latency_ms?: number;
  readonly min_reliability?: number; // 0..1
  readonly min_privacy?: PrivacyClass;
  readonly delivery_requirement: DeliveryRequirement;
  readonly payload_constraints?: PayloadConstraints;
  readonly preferred_transports?: TransportCapability[];
  readonly fallback_policy: FallbackPolicy;
}
