// AES-256-GCM encryption for API key at-rest protection
//
// - When ENCRYPTION_KEY is set: new writes are encrypted, reads are transparently decrypted.
// - When ENCRYPTION_KEY is NOT set: no-op (backward compatible).
// - Plain-text values (without "enc:" prefix) are returned as-is for seamless migration.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const PREFIX = "enc:";
const IV_LENGTH = 12;

/** Cached derived key (process lifetime) */
let derivedKey: Buffer | null | undefined;

function getDerivedKey(): Buffer | null {
  if (derivedKey !== undefined) return derivedKey;

  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    derivedKey = null;
    return null;
  }

  // Derive a 256-bit key from the user-supplied secret
  derivedKey = scryptSync(raw, "model-check-apikey-salt", 32);
  return derivedKey;
}

/**
 * Encrypt a plain-text API key.
 * Returns the original value if ENCRYPTION_KEY is not configured or the value is already encrypted.
 */
export function encryptApiKey(plaintext: string): string {
  const key = getDerivedKey();
  if (!key) return plaintext;
  if (plaintext.startsWith(PREFIX)) return plaintext; // already encrypted

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: enc:<iv_b64>:<tag_b64>:<data_b64>
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypt an encrypted API key.
 * Returns the original value if it is plain text (no "enc:" prefix) or ENCRYPTION_KEY is missing.
 */
export function decryptApiKey(ciphertext: string): string {
  if (!ciphertext.startsWith(PREFIX)) return ciphertext; // plain text (migration)

  const key = getDerivedKey();
  if (!key) return ciphertext; // can't decrypt without key

  try {
    const parts = ciphertext.slice(PREFIX.length).split(":");
    if (parts.length !== 3) return ciphertext;

    const [ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const encrypted = Buffer.from(dataB64, "base64");

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    return decrypted.toString("utf8");
  } catch {
    // Decryption failure (wrong key, corrupted data) – return raw value
    return ciphertext;
  }
}

/**
 * Check whether encryption is currently enabled.
 */
export function isEncryptionEnabled(): boolean {
  return getDerivedKey() !== null;
}
