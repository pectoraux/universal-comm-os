/**
 * core/intent/Intent.ts
 */

import type { Intent, IntentType, FallbackPolicy, DeliveryRequirement } from './types';

export interface CreateIntentInput {
  type: IntentType;
  priority?: Intent['priority'];
  ttl_ms?: number;
  max_cost?: number;
  max_latency_ms?: number;
  min_reliability?: number;
  min_privacy?: Intent['min_privacy'];
  delivery_requirement?: DeliveryRequirement;
  payload_constraints?: Intent['payload_constraints'];
  preferred_transports?: Intent['preferred_transports'];
  fallback_policy?: FallbackPolicy;
}

export function createIntent(input: CreateIntentInput): Intent {
  if (input.min_reliability !== undefined) {
    if (input.min_reliability < 0 || input.min_reliability > 1) {
      throw new Error('min_reliability must be in [0,1]');
    }
  }
  if (input.ttl_ms !== undefined && input.ttl_ms <= 0) {
    throw new Error('ttl_ms must be positive');
  }
  return Object.freeze({
    type: input.type,
    priority: input.priority ?? 'NORMAL',
    ttl_ms: input.ttl_ms,
    max_cost: input.max_cost,
    max_latency_ms: input.max_latency_ms,
    min_reliability: input.min_reliability,
    min_privacy: input.min_privacy,
    delivery_requirement: input.delivery_requirement ?? 'AT_LEAST_ONCE',
    payload_constraints: input.payload_constraints,
    preferred_transports: input.preferred_transports,
    fallback_policy: input.fallback_policy ?? 'CASCADE',
  });
}

export function isEmergency(intent: Intent): boolean {
  return intent.priority === 'EMERGENCY' || intent.type === 'EMERGENCY_ALERT';
}
