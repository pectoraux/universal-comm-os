/**
 * core/trust/CryptoEnvelope.ts
 *
 * Cryptographic envelope for Communication Bundles (ARCH-014).
 * Uses established primitives only (NaCl sealed-box construction + Ed25519 signatures).
 *
 * RELAYS CAN FORWARD WITHOUT DECRYPTING.
 * A relay sees only envelope headers + opaque ciphertext.
 *
 * Sealed-box construction (RFC 8439-style):
 *   1. Generate ephemeral X25519 keypair (epk, esk).
 *   2. nonce = blake2b-24(epk || recipient_pubkey).
 *   3. ciphertext = nacl.box(plaintext, nonce, recipient_pubkey, esk).
 *   4. Emit (epk || nonce || ciphertext) as the payload bytes.
 *
 * Receiver:
 *   1. nonce = blake2b-24(epk || recipient_pubkey).
 *   2. plaintext = nacl.box.open(ciphertext, nonce, epk, recipient_secret_key).
 *
 * Only the recipient can decrypt. The sender's identity is established via the
 * SENDER_SIGNATURE proof over canonical envelope bytes, NOT via the ciphertext.
 */

import nacl from 'tweetnacl';
import { blake2b } from '@noble/hashes/blake2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64urlEncode, b64urlDecode, utf8Encode, randomBytes } from '@/core/util/encoding';
import type { EncryptionMetadata, EncryptedPayload } from '@/core/bundle/types';
import type { UniversalIdentityRef } from '@/core/identity/types';

export interface SealedEnvelope {
  encryption_metadata: EncryptionMetadata;
  payload: EncryptedPayload;
}

export interface SealedInput {
  bundle_id: string;
  intent_type: string;
  expires_at: number;
  sender: UniversalIdentityRef;
  recipient_encryption_pubkey: Uint8Array; // X25519 pubkey
  plaintext: Uint8Array;
}

const SEALED_BOX_VERSION = 1;

/**
 * Pack (ephemeral_pubkey || nonce || ciphertext) into a single byte buffer.
 * Format: [1 byte version][32 bytes epk][24 bytes nonce][rest ciphertext].
 */
function packSealed(epk: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 32 + 24 + ciphertext.length);
  out[0] = SEALED_BOX_VERSION;
  out.set(epk, 1);
  out.set(nonce, 1 + 32);
  out.set(ciphertext, 1 + 32 + 24);
  return out;
}

function unpackSealed(bytes: Uint8Array): { epk: Uint8Array; nonce: Uint8Array; ciphertext: Uint8Array } {
  if (bytes.length < 1 + 32 + 24 + nacl.box.overheadLength) {
    throw new Error('unpackSealed: buffer too short');
  }
  if (bytes[0] !== SEALED_BOX_VERSION) {
    throw new Error(`unpackSealed: unsupported version ${bytes[0]}`);
  }
  const epk = bytes.subarray(1, 1 + 32);
  const nonce = bytes.subarray(1 + 32, 1 + 32 + 24);
  const ciphertext = bytes.subarray(1 + 32 + 24);
  return { epk, nonce, ciphertext };
}

function deriveNonce(epk: Uint8Array, recipient_pubkey: Uint8Array): Uint8Array {
  // Concatenate epk || recipient_pubkey and hash to 24 bytes with blake2b.
  const input = new Uint8Array(epk.length + recipient_pubkey.length);
  input.set(epk, 0);
  input.set(recipient_pubkey, epk.length);
  // blake2b with 24-byte output (the NaCl-box nonce size).
  const full = blake2b(input, { dkLen: 24 });
  return full;
}

/**
 * Sealed-box encryption: only the recipient can open. Relays cannot decrypt.
 */
export function sealPayload(input: SealedInput): SealedEnvelope {
  // Generate ephemeral X25519 keypair.
  const ephemeral = nacl.box.keyPair();
  const nonce = deriveNonce(ephemeral.publicKey, input.recipient_encryption_pubkey);
  const ciphertext = nacl.box(
    input.plaintext,
    nonce,
    input.recipient_encryption_pubkey,
    ephemeral.secretKey,
  );

  if (!ciphertext) {
    throw new Error('sealPayload: nacl.box returned null');
  }

  const packed = packSealed(ephemeral.publicKey, nonce, ciphertext);
  const recipient_pubkey_hash = b64urlEncode(sha256(input.recipient_encryption_pubkey));
  const sender_pubkey_hash = input.sender.signing_pubkey_hash;

  const additional_data = `${input.bundle_id}|${input.intent_type}|${input.expires_at}`;

  return {
    encryption_metadata: {
      algorithm: 'nacl-box-sealed',
      recipient_pubkey_hash,
      sender_pubkey_hash,
      nonce: b64urlEncode(nonce),
      additional_data,
    },
    payload: {
      ciphertext: b64urlEncode(packed),
      bytes_len: packed.length,
    },
  };
}

/**
 * Recipient-side decryption using X25519 secret key.
 */
export function openSealedPayload(
  env: SealedEnvelope,
  recipient_encryption_secret_key: Uint8Array,
): Uint8Array {
  if (env.encryption_metadata.algorithm !== 'nacl-box-sealed') {
    throw new Error(`Unsupported algorithm: ${env.encryption_metadata.algorithm}`);
  }
  const packed = b64urlDecode(env.payload.ciphertext);
  const { epk, nonce, ciphertext } = unpackSealed(packed);

  // Derive the receiver's public key from the secret key (X25519).
  const receiver_keypair = nacl.box.keyPair.fromSecretKey(recipient_encryption_secret_key);

  // Reconstruct the nonce from the ephemeral pubkey + receiver pubkey (per sealed-box).
  const derivedNonce = deriveNonce(epk, receiver_keypair.publicKey);
  if (b64urlEncode(derivedNonce) !== env.encryption_metadata.nonce) {
    // Strict mode: nonce must match what was advertised.
    throw new Error('openSealedPayload: nonce mismatch');
  }

  const plaintext = nacl.box.open(ciphertext, derivedNonce, epk, recipient_encryption_secret_key);
  if (!plaintext) {
    throw new Error('openSealedPayload: decryption failed (sealed box open returned null)');
  }
  return plaintext;
}

/**
 * Hash of canonical envelope bytes (used by Proof.sign).
 */
export function hashBytes(b: Uint8Array): string {
  return b64urlEncode(sha256(b));
}

/**
 * Verify that a received bundle's encryption metadata matches the recipient's key.
 * Relays never call this; only the recipient (or audit) does.
 */
export function isRecipientFor(
  env: SealedEnvelope,
  recipient_encryption_pubkey: Uint8Array,
): boolean {
  return (
    env.encryption_metadata.recipient_pubkey_hash ===
    b64urlEncode(sha256(recipient_encryption_pubkey))
  );
}

export function utf8EncodeHelper(s: string): Uint8Array {
  return utf8Encode(s);
}
