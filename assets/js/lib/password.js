/* ==========================================================================
   MediFlow Pharmacy ERP - Password hashing (Web Crypto, PBKDF2-SHA256)
   --------------------------------------------------------------------------
   Passwords are never stored in plain text. Each user record keeps a random
   salt and a PBKDF2 derived key; verification re-derives and compares in
   constant time.

   IMPORTANT - PRODUCTION NOTE
   This is a browser-only demonstration. Client-side hashing protects the
   stored demo data from casual inspection but it is NOT authentication:
   anybody with access to the browser can read and replace LocalStorage.
   Real deployments must authenticate on a server, store password hashes
   server-side, and issue signed session tokens. See README.md.
   ========================================================================== */

const ITERATIONS = 120000;
const KEY_BITS = 256;
const SALT_BYTES = 16;

/** True when the browser exposes the SubtleCrypto API we need. */
export function cryptoAvailable() {
  return !!(globalThis.crypto && globalThis.crypto.subtle && globalThis.crypto.getRandomValues);
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a fresh random salt as a hex string. */
export function makeSalt() {
  if (!cryptoAvailable()) return String(Date.now()) + Math.random().toString(36).slice(2);
  const bytes = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Minimal non-crypto fallback used only when SubtleCrypto is unavailable
 * (for example a non-secure origin in an older browser). Clearly weaker -
 * the hash is tagged so verification knows which scheme produced it.
 */
function weakHash(password, salt) {
  const input = `${salt}:${password}`;
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `fnv1$${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Derive a password hash.
 * @returns {Promise<string>} "pbkdf2$<iterations>$<hex>" or the fallback form
 */
export async function hashPassword(password, salt) {
  if (!cryptoAvailable()) return weakHash(password, salt);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(String(salt)), iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BITS
  );
  return `pbkdf2$${ITERATIONS}$${toHex(bits)}`;
}

/** Constant-time-ish string comparison (length-independent early exit avoided). */
function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Verify a plain-text password against a stored salt/hash pair. */
export async function verifyPassword(password, salt, storedHash) {
  if (!storedHash) return false;
  if (String(storedHash).startsWith('fnv1$')) {
    return safeEqual(weakHash(password, salt), storedHash);
  }
  const candidate = await hashPassword(password, salt);
  return safeEqual(candidate, storedHash);
}

/** Create a {salt, hash} credential pair for a new or reset password. */
export async function makeCredential(password) {
  const salt = makeSalt();
  const hash = await hashPassword(password, salt);
  return { salt, hash };
}

/** Basic strength policy used by the change-password and user forms. */
export function passwordIssue(password) {
  const value = String(password || '');
  if (value.length < 6) return 'Password must be at least 6 characters.';
  if (!/[a-zA-Z]/.test(value)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(value)) return 'Password must contain at least one number.';
  return null;
}
