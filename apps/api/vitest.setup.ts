// Runs before any test module is imported. env.ts validates these at load.
process.env.MASTER_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JWT_SECRET ??= 'test-secret-at-least-16-chars-long';
process.env.NODE_ENV ??= 'development';
