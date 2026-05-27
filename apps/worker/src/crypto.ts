import { createDecipheriv } from 'node:crypto';
import { env } from './env.js';

const KEY = Buffer.from(env.MASTER_KEY, 'hex');

export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext');
  const [ivB64, tagB64, encB64] = parts;
  // All three parts must be non-empty. IMAP passwords are required non-empty
  // by the API schema, so an empty payload indicates DB corruption — surface
  // it loudly instead of returning '' and letting imapsync auth-fail opaquely.
  if (!ivB64 || !tagB64 || !encB64) throw new Error('Invalid ciphertext');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const d = createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
