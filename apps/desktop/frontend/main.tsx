import { createRoot } from 'react-dom/client'
import App from './App'
import './style.css'
import './sidebar.css'
import './chat.css'
import './settings.css'
import './memory.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('#root not found')
createRoot(rootElement).render(<App />)
