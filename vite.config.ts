import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// One config, seven pages: the menu, the two spreadsheets, the sheet across windows, and the rail. The library is
// reached through the package's own subpath imports (#weft), the same way the
// tests reach it — no alias to keep in step with tsconfig.
export default defineConfig({
  root: 'demo',
  // Relative asset paths, so the built pages open from any directory — a static
  // server rooted elsewhere, an IDE's own preview, even file://.
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist-demo',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        menu: resolve(import.meta.dirname, 'demo/index.html'),
        classic: resolve(import.meta.dirname, 'demo/spreadsheet/index.html'),
        weft: resolve(import.meta.dirname, 'demo/spreadsheet-weft/index.html'),
        rail: resolve(import.meta.dirname, 'demo/rail/index.html'),
        kanbanClassic: resolve(import.meta.dirname, 'demo/kanban-classic/index.html'),
        kanbanWeft: resolve(import.meta.dirname, 'demo/kanban-weft/index.html'),
        kanbanTabs: resolve(import.meta.dirname, 'demo/kanban-tabs/index.html'),
        engine: resolve(import.meta.dirname, 'demo/engine/index.html'),
        tableWire: resolve(import.meta.dirname, 'demo/table-wire/index.html'),
        tableFull: resolve(import.meta.dirname, 'demo/table-full/index.html'),
      },
    },
  },
})
