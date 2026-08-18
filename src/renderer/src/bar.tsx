import ReactDOM from 'react-dom/client'
import './styles.css'
import { BarApp } from './bar/BarApp'

// Página da barra flutuante (janela transparente).
document.documentElement.style.background = 'transparent'
document.body.style.background = 'transparent'

ReactDOM.createRoot(document.getElementById('root')!).render(<BarApp />)
