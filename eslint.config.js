import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const typedConfigs = tseslint.configs.strictTypeChecked.map((config) => ({
  ...config,
  files: ['**/*.ts'],
}))

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'worker-configuration.d.ts'],
  },
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
  },
  ...typedConfigs,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['server/repositories/inMemory*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
)
