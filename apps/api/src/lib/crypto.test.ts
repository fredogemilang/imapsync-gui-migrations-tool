import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from './crypto.js';

describe('crypto round-trip', () => {
  it('encrypts and decrypts identity', () => {
    const plaintext = 'super-secret-imap-password!@#$%^';
    const ct = encrypt(plaintext);
    expect(ct).not.toContain(plaintext);
    expect(decrypt(ct)).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const a = encrypt('same-password');
    const b = encrypt('same-password');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(decrypt(b));
  });

  it('rejects empty-payload ciphertext (DB corruption indicator)', () => {
    // IMAP passwords are never empty by API contract — empty payload means
    // the row was truncated; decrypt must fail loudly, not return ''.
    expect(() => decrypt('aXY=:dGFn:')).toThrow(/Invalid ciphertext/);
  });

  it('handles unicode', () => {
    const s = 'パスワード 🔐 中文 العربية';
    expect(decrypt(encrypt(s))).toBe(s);
  });

  it('rejects malformed ciphertext (missing parts)', () => {
    expect(() => decrypt('not-a-valid-ciphertext')).toThrow(/Invalid ciphertext/);
    expect(() => decrypt('a:b')).toThrow();
  });

  it('rejects tampered ciphertext (auth tag mismatch)', () => {
    const ct = encrypt('legit');
    const parts = ct.split(':');
    const encBuf = Buffer.from(parts[2]!, 'base64');
    encBuf[0] = (encBuf[0]! ^ 0xff) & 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${encBuf.toString('base64')}`;
    expect(() => decrypt(tampered)).toThrow();
  });
});
