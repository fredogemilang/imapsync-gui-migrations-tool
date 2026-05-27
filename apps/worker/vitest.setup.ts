// Runs before any test module is imported. env.ts validates these at load.
process.env.MASTER_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
