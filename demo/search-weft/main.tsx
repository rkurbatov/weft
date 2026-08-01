import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../common/style.css'
import '../search-common/search.css'
import { App } from './App.tsx'

createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
        <App />
    </StrictMode>,
)