// Vite turns a stylesheet import into a side effect; the compiler needs telling.
declare module '*.css'

interface ImportMeta {
  readonly hot?: {
    dispose(callback: () => void): void
    accept(): void
  }
}
