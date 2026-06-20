import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const orpheusMode = (process.env.ORPHEUS_MODE ?? 'production') as 'development' | 'production'

export default defineConfig({
  main: {
    define: {
      __ORPHEUS_MODE__: JSON.stringify(orpheusMode)
    }
  },
  preload: {},
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
    plugins: [tailwindcss(), react()]
  }
})
