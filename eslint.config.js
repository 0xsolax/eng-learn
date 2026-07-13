import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

const typedConfigs = tseslint.configs.strictTypeChecked.map((config) => ({
  ...config,
  files: ['**/*.ts'],
}))

const typedVueConfigs = tseslint.configs.strictTypeChecked.map((config) => ({
  ...config,
  files: ['**/*.vue'],
  languageOptions: {
    ...config.languageOptions,
    parser: vueParser,
    parserOptions: {
      ...config.languageOptions?.parserOptions,
      parser: tseslint.parser,
      project: ['./tsconfig.eslint.json'],
      extraFileExtensions: ['.vue'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
}))

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'worker-configuration.d.ts'],
  },
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
  },
  ...pluginVue.configs['flat/recommended'],
  ...typedConfigs,
  ...typedVueConfigs,
  {
    files: ['**/*.vue'],
    rules: {
      'vue/require-default-prop': 'off',
    },
  },
  {
    files: ['src/pages/**/*.vue', 'src/features/**/*.vue', 'src/components/**/*.vue'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'Use the typed client in src/api instead of calling fetch from UI code.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'fetch',
          message: 'Use the typed client in src/api instead of calling window.fetch from UI code.',
        },
        {
          object: 'globalThis',
          property: 'fetch',
          message: 'Use the typed client in src/api instead of calling globalThis.fetch from UI code.',
        },
      ],
    },
  },
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        extraFileExtensions: ['.vue'],
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
