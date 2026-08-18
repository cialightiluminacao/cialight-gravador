import { useAppStore } from './store'
import * as controller from './recordingController'

// Ganchos de QA (só fora do pacote): permitem dirigir o app por CDP/executeJavaScript
// nos testes end-to-end sem depender de cliques na tela.
declare global {
  interface Window {
    __qa?: { store: typeof useAppStore; controller: typeof controller }
  }
}

export function installQaHooks(): void {
  void window.api.app.info().then((info) => {
    if (!info.isPackaged) window.__qa = { store: useAppStore, controller }
  })
}
