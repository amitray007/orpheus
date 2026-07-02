import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import tseslintTyped from 'typescript-eslint'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '.claude/**',
      'docs/**',
      'tmp/**',
      '.gstack/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // Plain JS/MJS build + utility scripts (e.g. scripts/*.mjs) can't carry TS
    // type annotations, so the typescript-eslint type-signature rules don't
    // apply to them — turn them off here to avoid unsatisfiable lint errors.
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off'
    }
  },
  // Type-aware linting for the Node-side code (main/preload/shared). Scoped
  // narrowly because `recommendedTypeChecked` requires a real TS program
  // (projectService) and the renderer is covered by its own tsconfig/project
  // — mixing them here would misattribute files to the wrong tsconfig.
  //
  // `recommendedTypeChecked`'s first entry (`typescript-eslint/base`) only
  // registers the `@typescript-eslint` parser/plugin — both already
  // registered globally above via `tseslint.configs.recommended` (the
  // `@electron-toolkit/eslint-config-ts` package). Flat config forbids two
  // configs redefining the same plugin key for overlapping `files`, so that
  // entry is dropped here; the rule-bearing entries are kept.
  tseslintTyped.config({
    files: ['src/main/**/*.{ts,tsx}', 'src/preload/**/*.{ts,tsx}', 'src/shared/**/*.{ts,tsx}'],
    extends: tseslintTyped.configs.recommendedTypeChecked.filter(
      (config) => config.name !== 'typescript-eslint/base'
    ),
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // The 4 rules called out for this rollout. `await-thenable` has zero
      // violations in main/preload/shared today, so it stays at `error`.
      // The other 3 currently have violations — kept at `warn` (not fixed,
      // per scope of this task) until the underlying code is cleaned up.
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',

      // Remaining `recommendedTypeChecked` rules with existing violations in
      // main/preload/shared as of this rollout — downgraded to `warn` so
      // `bun run lint` exits 0 without fixing the underlying code (out of
      // scope here). Any `recommendedTypeChecked` rule NOT listed here had
      // zero violations and is intentionally left at its default (`error`).
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/prefer-promise-reject-errors': 'warn'
    }
  }),
  eslintConfigPrettier
)
