import { desktopCapturer, session } from 'electron'
import { log } from '../log'

// O renderer chama getDisplayMedia(); o Chromium pede ao main qual fonte usar.
// O renderer informa a fonte escolhida antes (capture:select). Áudio do sistema
// (loopback WASAPI) só quando o toggle estiver ligado E o renderer pedir audio.
// Nunca damos 'loopbackWithMute' (silenciaria o PC).

let selectedSourceId: string | null = null
let systemAudioWanted = false

export function selectCaptureSource(sourceId: string, systemAudio: boolean): void {
  selectedSourceId = sourceId
  systemAudioWanted = systemAudio
  log.info(`fonte de captura selecionada: ${sourceId} (áudio do sistema: ${systemAudio})`)
}

export function getSelectedCapture(): { sourceId: string | null; systemAudio: boolean } {
  return { sourceId: selectedSourceId, systemAudio: systemAudioWanted }
}

export function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      const wantAudio = request.audioRequested && systemAudioWanted
      desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const src = sources.find((s) => s.id === selectedSourceId)
          if (!src) {
            log.error(`fonte ${selectedSourceId} não encontrada ao atender getDisplayMedia`)
            callback({})
            return
          }
          callback({ video: src, audio: wantAudio ? 'loopback' : undefined })
        })
        .catch((e) => {
          log.error('getSources falhou no handler', e)
          callback({})
        })
    },
    { useSystemPicker: false }
  )
}
