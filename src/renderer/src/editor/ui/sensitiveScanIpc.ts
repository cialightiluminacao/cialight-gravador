import type { ScanResult } from '@shared/editor/sensitiveScan'
import type { IpcApi, SensitiveScanProgress, SensitiveScanRequest } from '@shared/ipc'

// Uma varredura de dados sensíveis pelo IPC (G3), separada do diálogo para ser testada com uma API falsa.
// Assina progresso/fim ANTES de começar (o `done` pode chegar antes da resposta do start). Se a busca foi cancelada
// (ou o diálogo fechado) antes do start responder — `isStale()` —, o cancelamento chega ao main assim que o scanId
// existe: a varredura nunca fica rodando sozinha. A promessa só resolve com o `done` (o main faz uma por vez).

export type SensitiveIpc = Pick<IpcApi['editor']['sensitive'], 'start' | 'cancel' | 'onProgress' | 'onDone'>

export interface ScanOnceHooks {
  onProgress?: (p: SensitiveScanProgress) => void
  onId?: (scanId: string) => void
  /** A busca já não interessa (cancelada/fechada antes do start responder). */
  isStale?: () => boolean
}

const failed = (code: 'ffmpeg', message: string): ScanResult => ({ occurrences: [], framesSampled: 0, framesOcr: 0, ms: 0, lang: '', error: { code, message } })

export function scanOnce(api: SensitiveIpc, req: SensitiveScanRequest, hooks: ScanOnceHooks = {}): Promise<ScanResult> {
  return new Promise<ScanResult>((resolve) => {
    let id: string | null = null
    const early: { scanId: string; result: ScanResult }[] = []
    const earlyProg: SensitiveScanProgress[] = []
    const offProg = api.onProgress((pr) => {
      if (id === null) earlyProg.push(pr)
      else if (pr.scanId === id) hooks.onProgress?.(pr)
    })
    const offDone = api.onDone((d) => {
      if (id === null) early.push(d)
      else if (d.scanId === id) finish(d.result)
    })
    function finish(r: ScanResult): void {
      offDone()
      offProg()
      resolve(r)
    }
    api.start(req).then(
      (r) => {
        if (r.error) return finish({ occurrences: [], framesSampled: 0, framesOcr: 0, ms: 0, lang: '', error: r.error })
        id = r.scanId
        const d = early.find((x) => x.scanId === id)
        if (hooks.isStale?.()) {
          // cancelada antes de sabermos o id: cancela agora no main e espera o fim dela
          if (!d) void api.cancel(r.scanId)
        } else {
          hooks.onId?.(r.scanId)
          for (const pr of earlyProg) if (pr.scanId === id) hooks.onProgress?.(pr)
        }
        if (d) finish(d.result)
      },
      (e: unknown) => finish(failed('ffmpeg', e instanceof Error ? e.message : String(e)))
    )
  })
}
