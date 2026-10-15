/**
 * Everything cred-keeper puts into the fleet cache is sealed with AES-256-GCM
 * under the fleet key: Redis (plain TCP, shared by the fleet) only ever sees
 * ciphertext. The key name is bound as associated data, so a value cannot be
 * moved to another key (e.g. one account's credential served as another's).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileNoFollow } from '../util.ts';

const VERSION = 1;

export function loadFleetKey(path: string): Buffer {
  const text = readFileNoFollow(path);
  if (text === null) throw new Error(`fleet key file ${path} not found (create one with: cred-keeper fleet-keygen)`);
  const key = Buffer.from(text.trim(), 'base64');
  if (key.length !== 32) throw new Error(`fleet key file ${path} must hold 32 bytes, base64-encoded`);
  return key;
}

export function newFleetKey(): string {
  return randomBytes(32).toString('base64');
}

export function seal(key: Buffer, name: string, payload: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`cred-keeper/v${VERSION}/${name}`));
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf-8'), c.final()]);
  return JSON.stringify({ v: VERSION, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') });
}

/** Throws on a wrong key, a wrong name, or any tampering. */
export function open(key: Buffer, name: string, sealed: string): unknown {
  const env = JSON.parse(sealed) as { v?: unknown; iv?: unknown; tag?: unknown; ct?: unknown };
  if (env.v !== VERSION || typeof env.iv !== 'string' || typeof env.tag !== 'string' || typeof env.ct !== 'string') {
    throw new Error('not a cred-keeper envelope');
  }
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAAD(Buffer.from(`cred-keeper/v${VERSION}/${name}`));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  const pt = Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]);
  return JSON.parse(pt.toString('utf-8')) as unknown;
}
