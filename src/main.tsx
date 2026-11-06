import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
     {window.isSecureContext ? <App /> : <main>Para conectar, abrí la dirección HTTPS de la Jetson.</main>}
  </StrictMode>,
)
