import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import deepsightPlugin from './rules/no-silent-catch.js';

/**
 * Shared DeepSight lint configuration.
 *
 * The rules below are not style preferences — each one mechanically enforces a
 * non-negotiable from the build brief that would otherwise depend on a reviewer
 * noticing it. See docs/architecture/02-REPOSITORY-STRUCTURE.md section 6.
 */
export const deepsightRules = {
  // Brief section 9: no `any` without an explicit disable + justification.
  '@typescript-eslint/no-explicit-any': 'error',

  // Brief section 8: Promise.all is banned wherever partial failure must be isolated.
  // A convention nobody can enforce is not a control.
  'no-restricted-syntax': [
    'error',
    {
      selector: "MemberExpression[object.name='Promise'][property.name='all']",
      message:
        'Promise.all is banned: partial failure must be isolated. Use Promise.allSettled with explicit rejection handling.',
    },
  ],

  // Application code must never obtain a raw connection pool — it could then query
  // without a tenant GUC, which is a cross-tenant data leak (architecture section 7.2).
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['@deepsight/db/src/*', '**/db/src/pool*'],
          message:
            'Deep imports into @deepsight/db are banned. Use withOrg(), withOrgClient() or withGlobalConfig() so every query carries a tenant GUC.',
        },
      ],
    },
  ],

  // Brief section 9: no silently swallowed errors.
  'no-empty': ['error', { allowEmptyCatch: false }],
  'deepsight/no-silent-catch': 'error',

  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-console': 'off',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      // Fixtures exist precisely to violate the rules; test A12 asserts they fail
      // when linted explicitly, so they must not fail the normal repo-wide lint.
      'tests/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Everything here is Node or isomorphic; nothing runs in a browser except the
    // dashboard, which brings its own config in a later phase.
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    plugins: { deepsight: deepsightPlugin },
    rules: deepsightRules,
  },
  {
    files: ['**/*.ts'],
    rules: {
      // TypeScript resolves identifiers far better than ESLint's scope analysis can,
      // and no-undef produces false positives on type-only names. Disabling it for TS
      // is the typescript-eslint project's own recommendation.
      'no-undef': 'off',
    },
  },
  {
    // Plain JS tooling: scripts, config, the lint plugin itself.
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
