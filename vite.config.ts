import { readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = resolve(import.meta.dirname, 'demo')

/**
 * Every page under `demo`, found rather than listed.
 *
 * A stand is a folder with an `index.html` in it, and its entry is named by
 * its path — `sheet/weft`, `table/wire`. Listing them by hand meant a new
 * stand worked in development and was quietly missing from the build.
 */
function pages(dir: string = root, found: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) pages(path, found)
    else if (entry.name === 'index.html') {
      const name = relative(root, dir).replaceAll('\\', '/')
      found[name === '' ? 'menu' : name] = path
    }
  }
  return found
}

export default defineConfig({
  root: 'demo',
  // Relative asset paths, so the built pages open from any directory — a static
  // server rooted elsewhere, an IDE's own preview, even file://.
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist-demo',
    emptyOutDir: true,
    // The library is reached through the package's own subpath imports
    // (`#weft`, `#demo`), the same way the tests reach it — no alias table to
    // keep in step with tsconfig.
    rolldownOptions: { input: pages() },
  },
})
