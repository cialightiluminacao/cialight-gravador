import type { IpcApi } from '@shared/ipc'

// Caminho de compatibilidade: MediaRecorder por faixa (quando WebCodecs/mediabunny
// falha ao iniciar). Um arquivo por faixa, gravado em blocos de 1 s. O export
// remuxa tudo em rec.mp4 (main/export/fallbackRemux.ts).

export interface FallbackFiles {
  screen: string
  webcam?: string
  mic?: string
  system?: string
}

interface TrackRec {
  name: keyof FallbackFiles
  recorder: MediaRecorder
  handle: number
  position: number
  file: string
  queue: Promise<void>
}

const VIDEO_TYPES = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8']
const AUDIO_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus']

function pickType(candidates: string[]): { mime: string; ext: string } {
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return { mime: c, ext: c.startsWith('video/mp4') || c.startsWith('audio/mp4') ? (c.startsWith('audio') ? 'm4a' : 'mp4') : 'webm' }
  }
  return { mime: '', ext: 'webm' }
}

export class FallbackRecorder {
  private tracks: TrackRec[] = []
  private totalBytes = 0

  constructor(
    private api: IpcApi,
    private sessionId: string,
    private streams: { screen: MediaStream; cam: MediaStream | null; mic: MediaStream | null; sys: MediaStreamTrack | null },
    private onBytes: (bytes: number) => void
  ) {}

  async start(): Promise<FallbackFiles> {
    const files: FallbackFiles = { screen: '' }
    const add = async (name: keyof FallbackFiles, stream: MediaStream, isVideo: boolean, bps: number): Promise<void> => {
      const { mime, ext } = pickType(isVideo ? VIDEO_TYPES : AUDIO_TYPES)
      const file = `rec-fallback-${name}.${ext}`
      const handle = await this.api.session.writeOpen(this.sessionId, file)
      const recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: isVideo ? bps : undefined, audioBitsPerSecond: isVideo ? undefined : bps })
      const rec: TrackRec = { name, recorder, handle, position: 0, file, queue: Promise.resolve() }
      recorder.ondataavailable = (ev) => {
        if (!ev.data || ev.data.size === 0) return
        const blob = ev.data
        rec.queue = rec.queue.then(async () => {
          const buf = new Uint8Array(await blob.arrayBuffer())
          await this.api.session.write(rec.handle, buf, rec.position)
          rec.position += buf.byteLength
          this.totalBytes += buf.byteLength
          this.onBytes(this.totalBytes)
        })
      }
      this.tracks.push(rec)
      files[name] = file
    }
    await add('screen', new MediaStream(this.streams.screen.getVideoTracks()), true, 12e6)
    if (this.streams.cam) await add('webcam', new MediaStream(this.streams.cam.getVideoTracks()), true, 5e6)
    if (this.streams.mic) await add('mic', new MediaStream(this.streams.mic.getAudioTracks()), false, 160e3)
    if (this.streams.sys) await add('system', new MediaStream([this.streams.sys]), false, 160e3)
    for (const t of this.tracks) t.recorder.start(1000)
    return files
  }

  pause(): void {
    for (const t of this.tracks) if (t.recorder.state === 'recording') t.recorder.pause()
  }

  resume(): void {
    for (const t of this.tracks) if (t.recorder.state === 'paused') t.recorder.resume()
  }

  async stop(): Promise<void> {
    await Promise.all(
      this.tracks.map(
        (t) =>
          new Promise<void>((resolve) => {
            if (t.recorder.state === 'inactive') {
              resolve()
              return
            }
            t.recorder.onstop = () => resolve()
            t.recorder.stop()
          })
      )
    )
    for (const t of this.tracks) {
      await t.queue
      await this.api.session.writeClose(t.handle).catch(() => {})
    }
    this.tracks = []
  }
}
