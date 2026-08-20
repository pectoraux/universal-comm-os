/**
 * core/errors.ts — canonical protocol errors.
 */

export class ProtocolError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export type ProtocolErrorCode =
  | 'NO_ROUTE'
  | 'DESTINATION_UNKNOWN'
  | 'CHANNEL_UNAVAILABLE'
  | 'GATEWAY_UNAVAILABLE'
  | 'POLICY_BLOCKED'
  | 'BUNDLE_EXPIRED'
  | 'BUNDLE_DUPLICATE'
  | 'VERIFICATION_FAILED'
  | 'SIGNATURE_INVALID'
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED'
  | 'CAPABILITY_INSUFFICIENT'
  | 'IDENTITY_UNRESOLVED'
  | 'IDENTITY_UNVERIFIED'
  | 'PAYLOAD_TOO_LARGE'
  | 'TRANSPORT_UNAVAILABLE'
  | 'STATE_TRANSITION_INVALID'
  | 'NOT_IMPLEMENTED';
