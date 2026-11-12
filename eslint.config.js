import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 代码规范基线（骨架版，由 mike 细化，见 ARCHITECTURE.md §5）。
 * 只开「真会出错」的规则，不引入风格争论 —— 风格交给 prettier。
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // D1/D2 的守卫：禁止用 eval 之类的动态判分捷径
      'no-eval': 'error',
      'no-implied-eval': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['apps/web/**/*.tsx', 'apps/web/**/*.ts'],
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly', fetch: 'readonly', localStorage: 'readonly' },
    },
  },
);
