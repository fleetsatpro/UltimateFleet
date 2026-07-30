import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing with Argon2id.
 *
 * Argon2id (not bcrypt, not a bare SHA) because it is memory-hard: a GPU/ASIC attacker cannot
 * parallelise it cheaply the way they can bcrypt. The parameters below follow OWASP's guidance
 * (≥19 MiB, a few iterations); they are encoded INTO the hash string, so verifying an old hash
 * uses the parameters it was made with and raising the cost later does not invalidate existing
 * passwords. The salt is generated per hash by the library and stored in the same string.
 */
// @node-rs/argon2 defaults `algorithm` to Argon2id, so it is left implicit here: the library's
// `Algorithm` enum is an ambient const enum that cannot be imported under verbatimModuleSyntax.
const PARAMS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, PARAMS);
}

/**
 * Verifies a password against a stored hash. Returns false rather than throwing on a malformed
 * hash, so a corrupt record is a failed login (never a crash that leaks which accounts exist).
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext);
  } catch {
    return false;
  }
}
