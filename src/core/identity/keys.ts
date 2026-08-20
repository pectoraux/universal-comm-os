/**
 * core/identity/keys.ts
 *
 * Cryptographic key utilities for UniversalIdentity.
 * Uses established primitives (NaCl: Ed25519 for signing, X25519 for sealed box).
 * ARCH-014: never invent cryptography.
 */

import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64urlEncode, b64urlDecode } from '@/core/util/encoding';
import type { KeySet, UniversalIdentityRef } from './types';

export interface IdentityKeyPair {
  /** Ed25519 secret key (32 bytes seed + 32 bytes public key in NaCl format = 64 bytes). */
  signing_secret_key: Uint8Array;
  /** X25519 secret key for sealed-box decryption (32 bytes). */
  encryption_secret_key: Uint8Array;
  key_set: KeySet;
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  const signing = nacl.sign.keyPair();
  // Box keypair (X25519). In tweetnacl, box.keyPair.fromSecretKey expects 32 bytes.
  const encryption = nacl.box.keyPair();
  return {
    signing_secret_key: signing.secretKey,
    encryption_secret_key: encryption.secretKey,
    key_set: {
      signing_pubkey: signing.publicKey,
      encryption_pubkey: encryption.publicKey,
    },
  };
}

export function hashPubkey(pubkey: Uint8Array): string {
  return b64urlEncode(sha256(pubkey));
}

export function buildIdentityRef(input: {
  id: string;
  key_set: KeySet;
  display_name?: string;
}): UniversalIdentityRef {
  return {
    id: input.id,
    signing_pubkey_hash: hashPubkey(input.key_set.signing_pubkey),
    display_name: input.display_name,
  };
}

export function encodePubkey(pubkey: Uint8Array): string {
  return b64urlEncode(pubkey);
}

export function decodePubkey(s: string): Uint8Array {
  return b64urlDecode(s);
}
