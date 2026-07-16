import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const orpheusMode = (process.env.ORPHEUS_MODE ?? 'production') as
  | 'development'
  | 'production'
  | 'worktree'

export default defineConfig({
  main: {
    define: {
      __ORPHEUS_MODE__: JSON.stringify(orpheusMode)
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          overlay: resolve('src/preload/overlay.ts')
        }
      }
    }
  },
  renderer: {
    define: {
      __ORPHEUS_MODE__: JSON.stringify(orpheusMode)
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [tailwindcss(), react()],
    // Pierre adoption Batch 2b (worker-pool tokenization, see
    // DiffWorkerPoolProvider.tsx): @pierre/diffs/worker/worker-portable.js is
    // loaded via `new Worker(new URL(..., import.meta.url), { type: 'module' })`.
    // Vite's default worker.format ('iife') cannot code-split, and the worker
    // bundle contains a (conditionally-gated, never-taken) dynamic import() for
    // its WASM/Oniguruma engine branch that forces a code-split — so 'iife'
    // fails the build outright ("UMD and IIFE output formats are not supported
    // for code-splitting builds"). 'es' lets Vite emit the worker as a real
    // same-origin chunk (resolved via a RELATIVE new URL(...) at runtime,
    // matching how every other lazy chunk in this renderer already resolves
    // under the packaged app's file:// origin) instead of failing the build or
    // falling back to an inlined blob: worker (which the CSP would reject —
    // script-src has no blob: exception).
    worker: {
      format: 'es'
    },
    build: {
      minify: 'esbuild',
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          overlay: resolve('src/renderer/overlay.html')
        }
      }
    }
  }
})
