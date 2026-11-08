import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { PilotUserSeed } from '../lib/pilotSeed';

/**
 * Pilot-only seeded token pattern (`token_<userId>_pilot`). These tokens are
 * predictable by design and kept ONLY for compatibility with the seeded
 * pilot roster login flow. All newly issued tokens are cryptographically
 * random and stored only as SHA-256 hashes.
 */
export const SEEDED_TOKEN_RE = /^token_(.+)_pilot$/;

export const PERSISTENCE_ERROR_CODE = 'PERSISTENCE_FAILED';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

export function issueToken(db: DatabaseSync, userId: string): string {
  const token = `oprt_${randomBytes(24).toString('hex')}`;
  db.prepare(
    `INSERT INTO auth_tokens (token_hash, user_id, token_hint, created_at_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(token_hash) DO NOTHING`
  ).run(sha256Hex(token), userId, token.slice(0, 10), Date.now());
  return token;
}

/**
 * Resolves a bearer token to a pilot user. Seeded pilot tokens are matched
 * directly (predictable, pilot-only, documented limitation); every other
 * token is looked up by SHA-256 hash so raw random tokens are never stored.
 */
export function resolveTokenUser(
  db: DatabaseSync,
  users: PilotUserSeed[],
  token: string
): PilotUserSeed | null {
  if (!token || token.length > 200) return null;

  const seededMatch = SEEDED_TOKEN_RE.exec(token);
  if (seededMatch) {
    const userId = seededMatch[1];
    return users.find((u) => u.id === userId) ?? null;
  }

  const row = db
    .prepare('SELECT user_id FROM auth_tokens WHERE token_hash = ?')
    .get(sha256Hex(token)) as { user_id: string } | undefined;
  if (!row) return null;
  return users.find((u) => u.id === row.user_id) ?? null;
}
