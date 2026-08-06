// How every example starts: the same four lines, written once.
//
// Each demo used to carry its own copy of createRoot with StrictMode, and the
// only thing that differed was which App went in and which stylesheet came
// along. Four copies of a thing that never varies is four places to forget the
// strict mode in.

import { StrictMode } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

/** Put a screen on the page, under the double render of strict mode. */
export function mount(screen: ReactNode): void {
  const root = document.getElementById('root')
  if (root === null) throw new Error('demo: the page has no #root to mount into')
  createRoot(root).render(<StrictMode>{screen}</StrictMode>)
}
