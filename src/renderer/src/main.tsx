import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import './styles.css'

const params = new URLSearchParams(location.search)
if (params.get('test') === 'capture') {
  // modo de teste de integração (CIALIGHT_TEST=capture): roda o engine e devolve ao main
  void import('./test/captureTest').then(({ runCaptureTest }) => runCaptureTest(window.api))
  ReactDOM.createRoot(document.getElementById('root')!).render(<div className="p-6 text-sm text-muted">Teste de captura em andamento…</div>)
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
