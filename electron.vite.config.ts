import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const orpheusMode = (process.env.ORPHEUS_MODE ?? 'production') as 'development' | 'production'
const orpheusVariantName = process.env.ORPHEUS_VARIANT_NAME ?? ''
const orpheusVariantId = process.env.ORPHEUS_VARIANT_ID ?? ''
const orpheusShareDataWith = process.env.ORPHEUS_SHARE_DATA_WITH ?? ''

export default defineConfig({
  main: {
    define: {
      __ORPHEUS_MODE__: JSON.stringify(orpheusMode),
      __ORPHEUS_VARIANT_NAME__: JSON.stringify(orpheusVariantName),
      __ORPHEUS_VARIANT_ID__: JSON.stringify(orpheusVariantId),
      __ORPHEUS_SHARE_DATA_WITH__: JSON.stringify(orpheusShareDataWith)
    }
  },
  preload: {},
  renderer: {
    define: {
      __ORPHEUS_MODE__: JSON.stringify(orpheusMode),
      __ORPHEUS_VARIANT_NAME__: JSON.stringify(orpheusVariantName),
      __ORPHEUS_VARIANT_ID__: JSON.stringify(orpheusVariantId),
      __ORPHEUS_SHARE_DATA_WITH__: JSON.stringify(orpheusShareDataWith)
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [tailwindcss(), react()],
    build: {
      minify: 'esbuild',
      sourcemap: false
    }
  }
})
