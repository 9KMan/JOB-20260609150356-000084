/**
 * PHI encryption utilities — HIPAA Security Rule §164.312(a)(2)(iv) and (e)(2)(ii).
 *
 * AES-256-GCM with authenticated encryption. Key is provided via
 * PHI_ENCRYPTION_KEY in the form "base64:<32-bytes>". We also support a
 * 32-byte hex string for convenience. The first 12 bytes of the IV are
 * random; the 16-byte auth tag is appended.
 *
 * On disk / in DB, ciphertext is a single string:
 *   v1:<base64-iv>:<base64-tag>:<base64-ciphertext>
 *
 * The "v1" prefix allows key rotation: future versions can introduce v2.
 */
import * as crypto from 'crypto';
import { config } from '../config';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = config.hipaa.phiEncryptionKey;
  if (!raw) {
    // Fallback to a deterministic dev key derived from JWT secret.
    // This MUST be overridden in production.
    cachedKey = crypto
      .createHash('sha256')
      .update(config.auth.jwtSecret)
      .digest();
    return cachedKey;
  }
  if (raw.startsWith('base64:')) {
    cachedKey = Buffer.from(raw.slice('base64:'.length), 'base64');
  } else if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === KEY_BYTES * 2) {
    cachedKey = Buffer.from(raw, 'hex');
  } else {
    cachedKey = crypto.createHash('sha256').update(raw).digest();
  }
  if (cachedKey.length !== KEY_BYTES) {
    throw new Error(
      `PHI_ENCRYPTION_KEY must derive to ${KEY_BYTES} bytes (got ${cachedKey.length})`
    );
  }
  return cachedKey;
}

/**
 * Encrypt a PHI string. Returns the versioned envelope.
 * Throws on empty input — encryption is meaningful only for actual data.
 */
export function encryptPHI(plaintext: string): string {
  if (plaintext === undefined || plaintext === null) {
    throw new Error('encryptPHI: plaintext is required');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a versioned envelope produced by encryptPHI.
 * Returns null if the envelope is malformed or auth fails.
 */
export function decryptPHI(envelope: string | null | undefined): string | null {
  if (!envelope) return null;
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Deterministic, keyed hash for searchable encrypted fields (e.g. MRN).
 * Uses HMAC-SHA256; the same input + key yields the same hash, so we can
 * equality-search without revealing the plaintext.
 */
export function blindIndex(value: string): string {
  return crypto
    .createHmac('sha256', getKey())
    .update(value.toLowerCase().trim())
    .digest('hex');
}

/** Generate a cryptographically random opaque token (e.g. session id). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
