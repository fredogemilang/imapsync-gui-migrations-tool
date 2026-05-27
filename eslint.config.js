// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Ignore generated artefacts
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.vite/**',
      '**/.turbo/**',
      'mockup/**',
      'apps/api/drizzle/**',
      '.playwright-mcp/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Node TS (api + worker) — type-aware, no-floating-promises
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Files outside any tsconfig's `include` (vitest config/setup,
          // drizzle.config) need to be parsed without type-aware rules.
          allowDefaultProject: [
            'apps/api/vitest.config.ts',
            'apps/api/vitest.setup.ts',
            'apps/api/drizzle.config.ts',
            'apps/worker/vitest.config.ts',
            'apps/worker/vitest.setup.ts',
          ],
          defaultProject: 'tsconfig.base.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      // Fastify plugin/route functions are conventionally `async` even when
      // they don't await — keeps the signature uniform. Don't flag.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off', // pragmatic — we use `as any` in a few places
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Web (React) — non-type-aware (Vite-built, type-aware is too slow for SPA)
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off', // React 17+ no longer requires
      'react/prop-types': 'off', // we use TS
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Test files — relax some rules
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  // Node scripts (.mjs)
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Disable formatting-related ESLint rules so Prettier owns formatting
  prettier,
);
