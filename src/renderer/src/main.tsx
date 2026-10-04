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
  // teste de integração do render do editor (CIALIGHT_TEST=editor-render): só o harness, sem UI (?out=<pasta> recebe a
  // exportação da paridade do zoom; &decoderBench=1 com CIALIGHT_DECODER_BENCH=1 liga a medição do decoder)
  const [id, query] = location.hash.slice('#editor-test/'.length).split('?')
  const projectId = decodeURIComponent(id)
  const params = new URLSearchParams(query ?? '')
  void import('./editor/test/renderHarness').then(({ runRenderHarness }) => runRenderHarness(projectId, params.get('out'), { decoderBench: params.get('decoderBench') === '1' }))
} else if (location.hash.startsWith('#decode-test/')) {
  // teste de integração da ingestão (CIALIGHT_TEST=ingest): decodable de vídeo/áudio com o WebCodecs real
  const params = JSON.parse(decodeURIComponent(location.hash.slice('#decode-test/'.length)))
  void import('./editor/test/decodeHarness').then(({ runDecodeHarness }) => runDecodeHarness(params))
} else if (location.hash.startsWith('#editor-export-test/')) {
  // teste de integração da exportação do editor (CIALIGHT_TEST=editor-export): só o harness, sem UI
  const params = JSON.parse(decodeURIComponent(location.hash.slice('#editor-export-test/'.length)))
  void import('./editor/test/exportHarness').then(({ runExportHarness }) => runExportHarness(params))
} else if (location.hash.startsWith('#editor-formats-test/')) {
  // teste de integração dos formatos extras (CIALIGHT_TEST=editor-formats): GIF, PNG e só áudio
  const params = JSON.parse(decodeURIComponent(location.hash.slice('#editor-formats-test/'.length)))
  void import('./editor/test/formatsHarness').then(({ runFormatsHarness }) => runFormatsHarness(params))
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
