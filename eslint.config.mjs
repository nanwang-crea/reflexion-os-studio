// ESLint（flat config，v9）：前端 React(含 react-hooks 依赖纪律) + Node 侧 TS 基础规则。
// 门禁：pnpm lint(根级)；与 format:check 同级,必须在提交前全绿。
import ts from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default ts.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-frontend/**',
      '**/target/**',
      '**/src-tauri/gen/**',
      '*.config.*',
    ],
  },
  // Node 侧 TS（runtime / packages / scripts）：基础推荐规则。
  ...ts.configs.recommended,
  {
    files: [
      'apps/runtime/**/*.ts',
      'packages/*/src/**/*.ts',
      'packages/agent-core/test/**/*.mjs',
      'scripts/**/*.mjs',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // 前端 React：追加 hooks 规则（依赖数组完整性）。
  {
    files: ['apps/desktop/frontend/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
)
