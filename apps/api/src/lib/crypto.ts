import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env.js';

const KEY = Buffer.from(env.MASTER_KEY, 'hex');
const ALGO = 'aes-256-gcm';

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

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
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
