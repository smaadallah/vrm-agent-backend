import * as crypto from 'crypto';

const IV_BYTES = 12;       // 96-bit IV — recommended for AES-GCM
const AUTH_TAG_BYTES = 16; // 128-bit authentication tag

function getKey(): Buffer {
  const hex = process.env.AES_KEY;
  if (!hex) {
    throw new Error('AES_KEY environment variable is not set');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      `AES_KEY must be a 32-byte hex string (64 hex characters). Got ${hex.length} characters.`,
    );
  }
  return key;
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns a base64-encoded string with the layout:
 *   IV (12 bytes) || AuthTag (16 bytes) || Ciphertext
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypts a base64-encoded AES-256-GCM ciphertext produced by encrypt().
 * Throws if the key is wrong or the ciphertext has been tampered with.
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const encrypted = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}
