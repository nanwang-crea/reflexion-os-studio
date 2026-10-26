import { createRoot } from 'react-dom/client'
import { RemoteApp } from './features/remote/RemoteApp'
import { initializeTheme } from './lib/theme'
import { initializeOperations } from './api/operations'
import './styles/style.css'
import './styles/themes.css'
import './styles/markdown.css'
import './features/chat/chat.css'
import './features/remote/remote.css'
initializeTheme()
initializeOperations()
const root = document.getElementById('root')
if (!root) throw new Error('#root not found')
createRoot(root).render(<RemoteApp />)
