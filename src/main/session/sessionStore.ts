import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, writeSync, promises as fsp } from 'fs'
import { join } from 'path'
import { parseSession } from '@shared/schemas'
import type { RecordingConfig, Session, SessionSummary } from '@shared/types'

// Sessões brutas: uma pasta por gravação em <rawRoot>/<sessionId>/ com rec.mp4 + session.json.
// A escrita do rec.mp4 é posicional (o muxer fMP4 escreve sequencialmente, mas
// mantemos `position` para suportar formatos que reescrevem cabeçalhos).

export interface SessionStoreDeps {
  rawRoot: () => string
  trash: (path: string) => Promise<void>
  log?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
}

export class SessionStore {
  private handles = new Map<number, number>()
  private nextHandle = 1

  constructor(private deps: SessionStoreDeps) {}

  root(): string {
    return this.deps.rawRoot()
  }

  dirOf(sessionId: string): string {
    if (!/^[\w.-]+$/.test(sessionId)) throw new Error(`sessionId inválido: ${sessionId}`)
    return join(this.root(), sessionId)
  }

  filePath(sessionId: string, name: string): string {
    if (name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error(`nome de arquivo inválido: ${name}`)
    return join(this.dirOf(sessionId), name)
  }

  create(config: RecordingConfig, sessionId: string, extra: { bounds: Session['source']['bounds']; scaleFactor: number; video: Session['video'] }): { dir: string; session: Session } {
    const dir = this.dirOf(sessionId)
    mkdirSync(dir, { recursive: true })
    const session: Session = {
      version: 1,
      id: sessionId,
      createdAt: new Date().toISOString(),
      state: 'recording',
      source: { kind: config.source.kind, id: config.source.id, name: config.source.name, displayId: config.source.displayId, bounds: extra.bounds, scaleFactor: extra.scaleFactor },
      video: extra.video,
      webcam: config.webcam ? { deviceId: config.webcam.deviceId, label: config.webcam.label, width: 0, height: 0, mirrored: config.webcam.mirrored } : undefined,
      mic: config.mic ? { ...config.mic } : undefined,
      systemAudio: config.systemAudio,
      tracks: { screen: 0 },
      pauses: [],
      pip: [config.pipInitial],
      strokes: [],
      clearEvents: [],
      markers: [],
      engine: 'webcodecs',
      files: { rec: 'rec.mp4' }
    }
    this.save(session)
    return { dir, session }
  }

  openWrite(sessionId: string, name: string): number {
    const fd = openSync(this.filePath(sessionId, name), 'w')
    const h = this.nextHandle++
    this.handles.set(h, fd)
    return h
  }

  write(handle: number, data: Uint8Array, position: number): void {
    const fd = this.handles.get(handle)
    if (fd === undefined) throw new Error('handle de escrita inválido')
    let off = 0
    while (off < data.byteLength) {
      off += writeSync(fd, data, off, data.byteLength - off, position + off)
    }
  }

  closeWrite(handle: number): void {
    const fd = this.handles.get(handle)
    if (fd !== undefined) closeSync(fd)
    this.handles.delete(handle)
  }

  closeAll(): void {
    for (const h of [...this.handles.keys()]) this.closeWrite(h)
  }

  save(session: Session): void {
    const dir = this.dirOf(session.id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.json')
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  get(id: string): Session | null {
    const file = join(this.dirOf(id), 'session.json')
    if (!existsSync(file)) return null
    try {
      return parseSession(JSON.parse(readFileSync(file, 'utf8')))
    } catch (e) {
      this.deps.log?.warn(`session.json inválido em ${id}`, e)
      return null
    }
  }

  list(): SessionSummary[] {
    const root = this.root()
    if (!existsSync(root)) return []
    const out: SessionSummary[] = []
    for (const name of readdirSync(root)) {
      const s = this.get(name)
      if (!s) continue
      const dir = this.dirOf(name)
      let bytes = s.bytes ?? 0
      if (!bytes) {
        try {
          bytes = statSync(join(dir, s.files.rec)).size
        } catch {
          bytes = 0
        }
      }
      const thumbFile = join(dir, 'thumbs', '001.jpg')
      out.push({
        id: s.id,
        createdAt: s.createdAt,
        state: s.state,
        durationMs: s.durationMs ?? null,
        bytes,
        hasWebcam: !!s.webcam,
        sourceName: s.source.name,
        thumb: existsSync(thumbFile) ? thumbFile : null
      })
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return out
  }

  async delete(id: string): Promise<void> {
    const dir = this.dirOf(id)
    if (!existsSync(dir)) return
    await this.deps.trash(dir)
  }

  findUnfinished(): Session[] {
    return this.list()
      .filter((s) => s.state === 'recording')
      .map((s) => this.get(s.id))
      .filter((s): s is Session => !!s)
  }

  async freeSpaceMB(): Promise<number> {
    const root = this.root()
    mkdirSync(root, { recursive: true })
    const st = await fsp.statfs(root)
    return Math.floor((st.bavail * st.bsize) / 1048576)
  }

  /** Remove sessões finalizadas com mais de `days` dias. Retorna quantas foram enviadas à lixeira. */
  async cleanupOld(days: number): Promise<number> {
    const cutoff = Date.now() - days * 86400_000
    let n = 0
    for (const s of this.list()) {
      if (s.state === 'recording') continue
      if (new Date(s.createdAt).getTime() < cutoff) {
        await this.delete(s.id)
        n++
      }
    }
    return n
  }
}
