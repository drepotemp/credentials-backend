import bcrypt from 'bcryptjs';

const ROUNDS = 12;

function pepper() {
  const key = process.env.HASH_PEPPER;
  if (!key) throw new Error('HASH_PEPPER is missing from the environment.');
  return key;
}

/** Hashes a value with bcrypt using the env pepper. Never store plaintext. */
export function hashSecret(value) {
  return bcrypt.hash(`${String(value)}${pepper()}`, ROUNDS);
}

/** Verifies a plaintext value against a bcrypt hash. */
export function verifySecret(value, hash) {
  if (!value || !hash) return Promise.resolve(false);
  return bcrypt.compare(`${String(value)}${pepper()}`, hash);
}
