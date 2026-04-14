/**
 * MOTHERSHIP — Password / token hashing
 *
 * Wraps hash-wasm's argon2id (pure WASM, no native compilation).
 * OWASP 2026 baseline: m=64 MiB, t=3, p=1, hashLength=32.
 */

const crypto = require('crypto');
const { argon2id, argon2Verify } = require('hash-wasm');

async function hash(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  const salt = crypto.randomBytes(16);
  return argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536, // 64 MiB
    hashLength: 32,
    outputType: 'encoded'
  });
}

async function verify(encoded, password) {
  if (typeof encoded !== 'string' || typeof password !== 'string') return false;
  if (!encoded.startsWith('$argon2id$')) return false;
  try {
    return await argon2Verify({ password, hash: encoded });
  } catch (_) {
    return false;
  }
}

module.exports = { hash, verify };
