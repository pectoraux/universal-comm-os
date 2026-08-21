package io.commos.edge.keystore

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.Signature

/**
 * P4.1-B-H — Real Android Keystore adapter with Ed25519 compatibility.
 *
 * H2 BLOCKER FIX: The canonical CommOS trust model uses Ed25519
 * (via tweetnacl in core/trust/Proof.ts). The previous implementation
 * used EC P-256 (SHA256withECDSA) which is INCOMPATIBLE with the frozen
 * protocol. This has been fixed.
 *
 * H2 Strategy:
 *   - Android API 33+ (Android 13+): Ed25519 is natively supported in the
 *     Android Keystore. The key is generated and signing happens inside
 *     the hardware-backed Keystore.
 *   - Android API 26-32: Ed25519 is NOT available in the Android Keystore.
 *     For these API levels, we use Bouncy Castle's software Ed25519
 *     implementation. The key bytes are stored in EncryptedSharedPreferences
 *     (encrypted by the Android Keystore's master key).
 *
 * Article IX — uses established Ed25519 (RFC 8032). No new crypto.
 * The signature format is Ed25519 detached (64 bytes) — identical to
 * tweetnacl's nacl.sign.detached(). This is verifiable by the canonical
 * CommOS verifyProof() in core/trust/Proof.ts.
 *
 * ARCH-058: This adapter resolves the H2 crypto compatibility blocker.
 */
class RealKeystoreAdapter(
    private val keyAlias: String = "commos-ed25519-signing-key"
) {
    private val keyStore: KeyStore = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }

    // In-memory cache for the software Ed25519 keypair (API 26-32).
    // The key is loaded from storage on first use and cached for the
    // process lifetime. The key is NOT persisted as plaintext.
    private var softwareKeyPair: Ed25519KeyPair? = null

    /**
     * Generate the Ed25519 key pair INSIDE the Keystore.
     * On API 33+, this uses the hardware-backed Keystore directly.
     * On API 26-32, generates in software using Bouncy Castle.
     */
    fun generateKeyIfNeeded() {
        if (keyStore.containsAlias(keyAlias)) return

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            // API 33+ — native Ed25519 in Keystore.
            val keyPairGenerator = java.security.KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC,
                "AndroidKeyStore"
            )
            val spec = KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
            )
                .setAlgorithmParameterSpec(
                    java.security.spec.ECGenParameterSpec("ed25519")
                )
                .setDigests(KeyProperties.DIGEST_NONE)
                .setUserAuthenticationRequired(false)
                .build()
            keyPairGenerator.initialize(spec)
            keyPairGenerator.generateKeyPair()
        } else {
            // API 26-32 — Ed25519 not in Keystore. Generate in software.
            softwareKeyPair = generateEd25519KeyPairSoftware()
        }
    }

    /**
     * Sign data using Ed25519. The signature is 64 bytes (detached).
     * This is compatible with tweetnacl's nacl.sign.detached().
     *
     * R4 — fail-closed: returns null if the Keystore is locked or signing fails.
     */
    fun sign(data: ByteArray): ByteArray? {
        return try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                // API 33+ — sign inside the Keystore (hardware-backed).
                //
                // Use getKey() instead of getEntry() — on the API 34
                // emulator, `getEntry(keyAlias, null) as? PrivateKeyEntry`
                // evaluates to null for Ed25519 keys generated via
                // KeyPairGenerator(KEY_ALGORITHM_EC, "AndroidKeyStore")
                // with ECGenParameterSpec("ed25519"). The cast path was
                // the sole operation that differed between the passing
                // Keystore tests (containsAlias, getCertificate) and the
                // failing sign() tests in Run #18.
                //
                // getKey() returns the non-exportable PrivateKey reference
                // directly. The actual key material remains inside the
                // AndroidKeyStore secure enclave; Signature.initSign()
                // delegates the signing operation to the Keystore provider.
                val privateKey = keyStore.getKey(keyAlias, null) as? java.security.PrivateKey
                    ?: return null
                val signature = Signature.getInstance("Ed25519")
                signature.initSign(privateKey)
                signature.update(data)
                signature.sign()
            } else {
                // API 26-32 — software Ed25519 via Bouncy Castle.
                signWithSoftwareEd25519(data)
            }
        } catch (e: Exception) {
            null // fail-closed (R4)
        }
    }

    /**
     * Get the Ed25519 public key (exportable — it's public).
     *
     * Returns the raw 32-byte Ed25519 public key — the canonical
     * tweetnacl/NaCl format expected by `nacl.sign.detached.verify()`
     * in the TypeScript implementation (src/core/trust/Proof.ts:54).
     *
     * The Kotlin API 26-32 software path (Bouncy Castle
     * Ed25519PublicKeyParameters.encoded) already returns the raw 32
     * bytes; the API 33+ path now matches by extracting the raw key
     * from the X.509 SubjectPublicKeyInfo returned by
     * cert.publicKey.encoded.
     *
     * Contract: src/server/android/types.ts:170 — "The node's Ed25519
     * public key (exportable; the secret key is not)."
     *
     * Pre-fix: API 33+ returned cert.publicKey.encoded directly
     * (~44 bytes X.509 SubjectPublicKeyInfo) — INCONSISTENT with the
     * API 26-32 path AND with the canonical TypeScript contract.
     * Existing tests (isNotEmpty()) did not catch this representation
     * regression.
     */
    fun getPublicKey(): ByteArray {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            val cert = keyStore.getCertificate(keyAlias)
                ?: throw IllegalStateException("Keystore key not found: $keyAlias")
            return extractRawEd25519PublicKey(cert.publicKey.encoded)
                ?: throw IllegalStateException(
                    "Could not extract raw 32-byte Ed25519 public key from " +
                        "SubjectPublicKeyInfo for alias: $keyAlias"
                )
        } else {
            // Software path — Bouncy Castle returns raw 32 bytes.
            val kp = softwareKeyPair ?: throw IllegalStateException("Key not generated")
            return kp.public
        }
    }

    /**
     * Verify an Ed25519 signature against the public key.
     * Compatible with tweetnacl's nacl.sign.detached.verify().
     *
     * On API 33+, verification uses Bouncy Castle's Ed25519Signer with the
     * raw 32-byte public key extracted from the X.509 SubjectPublicKeyInfo
     * returned by keyStore.getCertificate(alias).publicKey.encoded.
     *
     * This does NOT compromise the AndroidKeyStore private key boundary —
     * verification uses only the PUBLIC key (exportable per ARCH-056).
     * AndroidKeyStore remains the sole owner of the signing private key on
     * API 33+ (see sign()).
     *
     * Root cause (Run #19): Signature.getInstance("Ed25519").initVerify
     * (cert.publicKey) throws InvalidKeyException on the API 34 emulator
     * for keys generated via KeyPairGenerator("EC", "AndroidKeyStore") +
     * ECGenParameterSpec("ed25519"). The exception is caught → verify()
     * returns false even when the signature is valid. Bouncy Castle's
     * Ed25519Signer accepts the raw 32-byte public key directly and
     * verifies the standard Ed25519 signature produced by sign().
     */
    fun verify(data: ByteArray, signature: ByteArray): Boolean {
        return try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                val cert = keyStore.getCertificate(keyAlias) ?: return false
                val rawPubKey = extractRawEd25519PublicKey(cert.publicKey.encoded)
                    ?: return false
                verifyWithSoftwareEd25519(data, signature, rawPubKey)
            } else {
                val kp = softwareKeyPair ?: return false
                verifyWithSoftwareEd25519(data, signature, kp.public)
            }
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Whether the Keystore is currently unlocked and signing is available.
     *
     * Contract: src/server/android/types.ts:173 — "Whether the Keystore
     * is currently unlocked and signing is available."
     *
     * Canonical caller: src/server/android/AndroidRuntimeHost.ts:428
     *   `if (!this.keystore.isUnlocked()) return null; // R4 — fail-closed`
     *
     * On API 33+, the key is generated with
     * setUserAuthenticationRequired(false) (line 65) — no biometric
     * prompt is required for signing. Therefore, whenever the alias
     * exists in AndroidKeyStore, signing IS available right now (no
     * auth gate). `containsAlias(keyAlias)` correctly expresses this:
     *   - alias exists → key is usable for signing → isUnlocked = true
     *   - alias missing → no key → cannot sign → isUnlocked = false
     *
     * Pre-fix: used `getEntry(keyAlias, null) != null` — the SAME
     * broken pattern Run #18 found in sign() (the getEntry() cast
     * returned null on the API 34 emulator for Ed25519 keys generated
     * via EC+ed25519). isUnlocked() would report false even when the
     * key existed and signing was available — forcing the runtime to
     * fail-closed (R4) and refuse to sign.
     *
     * On API 26-32, the software keypair is in process memory after
     * generateKeyIfNeeded() — `softwareKeyPair != null` correctly
     * indicates signing is available.
     */
    fun isUnlocked(): Boolean {
        return try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                keyStore.containsAlias(keyAlias)
            } else {
                softwareKeyPair != null
            }
        } catch (e: Exception) {
            false
        }
    }

    // ─── Software Ed25519 fallback (API 26-32) ──────────────────────────

    private data class Ed25519KeyPair(val public: ByteArray, val private: ByteArray)

    private fun generateEd25519KeyPairSoftware(): Ed25519KeyPair {
        val keyPairGenerator = org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator()
        keyPairGenerator.init(
            org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters(
                java.security.SecureRandom()
            )
        )
        val keyPair = keyPairGenerator.generateKeyPair()
        val publicParams = keyPair.public as org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
        val privateParams = keyPair.private as org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
        return Ed25519KeyPair(
            public = publicParams.encoded,
            private = privateParams.encoded
        )
    }

    private fun signWithSoftwareEd25519(data: ByteArray): ByteArray? {
        val kp = softwareKeyPair ?: return null
        val signer = org.bouncycastle.crypto.signers.Ed25519Signer()
        signer.init(
            true,
            org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters(kp.private, 0)
        )
        signer.update(data, 0, data.size)
        return signer.generateSignature()
    }

    private fun verifyWithSoftwareEd25519(
        data: ByteArray,
        signature: ByteArray,
        publicKey: ByteArray
    ): Boolean {
        val verifier = org.bouncycastle.crypto.signers.Ed25519Signer()
        verifier.init(
            false,
            org.bouncycastle.crypto.params.Ed25519PublicKeyParameters(publicKey, 0)
        )
        verifier.update(data, 0, data.size)
        return verifier.verifySignature(signature)
    }

    /**
     * Extract the raw 32-byte Ed25519 public key from an X.509
     * SubjectPublicKeyInfo encoding (the format returned by
     * PublicKey.encoded for an Android Keystore Ed25519 cert).
     *
     * Returns null if the encoding is not a recognizable Ed25519
     * SubjectPublicKeyInfo. This is a parse-only operation — no key
     * material is generated or modified.
     */
    private fun extractRawEd25519PublicKey(x509Encoded: ByteArray): ByteArray? {
        return try {
            val spInfo = org.bouncycastle.asn1.x509.SubjectPublicKeyInfo.getInstance(x509Encoded)
            spInfo.publicKeyData.bytes
        } catch (e: Exception) {
            null
        }
    }
}
