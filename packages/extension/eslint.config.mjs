import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

const commonRules = {
  semi: ['error', 'always'],
  quotes: ['error', 'single', { avoidEscape: true }],
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'prefer-const': 'error',
};

export default [
  {
    ignores: ['dist/', 'node_modules/', 'src/ui/'],
  },
  // Source files — typed linting with tsconfig.json
  {
    files: ['src/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: commonRules,
  },
  // Test files — no project reference (excluded from tsconfig.json)
  {
    files: ['src/__tests__/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: null,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: commonRules,
  },
];
