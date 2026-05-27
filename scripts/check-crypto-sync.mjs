#!/usr/bin/env node
// Asserts that the `decrypt` function in apps/api/src/lib/crypto.ts is
// byte-identical to the one in apps/worker/src/crypto.ts (modulo whitespace
// and the env import path). The worker has no `encrypt` (it never writes
// ciphertext), but the decrypt path MUST match — any divergence in IV
// length, separator, tag length, base64 vs hex encoding, etc. would cause
// every running migration to fail with 'Invalid ciphertext'.
//
// Also asserts that both files derive KEY from the same env source via
// `Buffer.from(env.MASTER_KEY, 'hex')`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const apiPath = resolve(root, 'apps/api/src/lib/crypto.ts');
const workerPath = resolve(root, 'apps/worker/src/crypto.ts');

const api = readFileSync(apiPath, 'utf8');
const worker = readFileSync(workerPath, 'utf8');

// Extract the body of `export function decrypt(...) { ... }`
function extractDecrypt(src) {
  const m = src.match(/export function decrypt\b[\s\S]*?\n\}/);
  if (!m) throw new Error('decrypt function not found');
  return m[0];
}

// Normalise: collapse whitespace, remove single-line comments
function normalise(s) {
  return (
    s
      .split('\n')
      .map((ln) => ln.replace(/\/\/.*$/, '').trim())
      .filter((ln) => ln.length > 0)
      .join('\n')
      // Algorithm could be inlined ('aes-256-gcm') OR referenced via const ALGO.
      // Normalise both forms.
      .replace(/['"]aes-256-gcm['"]/g, 'ALGO')
      .replace(/createDecipheriv\(ALGO/g, 'createDecipheriv(ALGO')
      // local var rename — d vs decipher
      .replace(/\bdecipher\b/g, 'd')
  );
}

const apiDecrypt = normalise(extractDecrypt(api));
const workerDecrypt = normalise(extractDecrypt(worker));

if (apiDecrypt !== workerDecrypt) {
  console.error('❌ decrypt() implementations have drifted:');
  console.error('');
  console.error('--- api ---');
  console.error(apiDecrypt);
  console.error('');
  console.error('--- worker ---');
  console.error(workerDecrypt);
  console.error('');
  console.error('The two decrypt functions MUST stay semantically identical (whitespace and');
  console.error('local var names are normalised). Drift causes silent credential loss.');
  process.exit(1);
}

// Also verify the key derivation is consistent
const apiKey = api.match(/Buffer\.from\(env\.MASTER_KEY,\s*['"]hex['"]\)/);
const workerKey = worker.match(/Buffer\.from\(env\.MASTER_KEY,\s*['"]hex['"]\)/);
if (!apiKey || !workerKey) {
  console.error('❌ MASTER_KEY derivation missing or different in one of the files');
  process.exit(1);
}

console.log('✓ crypto decrypt() and key derivation in sync');
