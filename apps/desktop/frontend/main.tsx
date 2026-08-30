import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/style.css'
import './styles/sidebar.css'
import './features/chat/chat.css'
import './features/settings/settings.css'
import './features/memories/memory.css'
import './features/skills/skills.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('#root not found')
createRoot(rootElement).render(<App />)
