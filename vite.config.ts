import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// One config, five pages: the menu, the two spreadsheets, and the sheet across windows. The library is
// reached through the package's own subpath imports (#weft), the same way the
// tests reach it — no alias to keep in step with tsconfig.
export default defineConfig({
  root: 'demo',
  // Relative asset paths, so the built pages open from any directory — a static
  // server rooted elsewhere, an IDE's own preview, even file://.
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist-demo',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        menu: resolve(import.meta.dirname, 'demo/index.html'),
        classic: resolve(import.meta.dirname, 'demo/spreadsheet/index.html'),
        weft: resolve(import.meta.dirname, 'demo/spreadsheet-weft/index.html'),
        sheetTabs: resolve(import.meta.dirname, 'demo/spreadsheet-tabs/index.html'),
      },
    },
  },
})
