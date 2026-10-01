import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import './styles.css'

const params = new URLSearchParams(location.search)
if (params.get('test') === 'capture') {
  // modo de teste de integração (CIALIGHT_TEST=capture): roda o engine e devolve ao main
  void import('./test/captureTest').then(({ runCaptureTest }) => runCaptureTest(window.api))
  ReactDOM.createRoot(document.getElementById('root')!).render(<div className="p-6 text-sm text-muted">Teste de captura em andamento…</div>)
} else if (location.hash.startsWith('#editor-test/')) {
  // teste de integração do render do editor (CIALIGHT_TEST=editor-render): só o harness, sem UI
  const projectId = decodeURIComponent(location.hash.slice('#editor-test/'.length))
  void import('./editor/test/renderHarness').then(({ runRenderHarness }) => runRenderHarness(projectId))
} else if (location.hash.startsWith('#editor-export-test/')) {
  // teste de integração da exportação do editor (CIALIGHT_TEST=editor-export): só o harness, sem UI
  const params = JSON.parse(decodeURIComponent(location.hash.slice('#editor-export-test/'.length)))
  void import('./editor/test/exportHarness').then(({ runExportHarness }) => runExportHarness(params))
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
