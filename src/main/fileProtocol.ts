import { protocol } from 'electron'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'
import { FILE_HOST_MEDIA, FILE_HOST_PROJECT, FILE_PROTOCOL } from '@shared/ipc'
import type { SessionStore } from './session/sessionStore'
import type { ProjectStore } from './project/projectStore'
import { log } from './log'

// cialight-file://<sessionId>/<arquivo> → arquivo da pasta da sessão, com suporte
// a Range (o <video> da revisão faz seek; mediabunny UrlSource lê por faixas).
// Hosts reservados (sessionIds são timestamps, sem colisão):
//   media/<projectId>/<assetId>?v=original|proxy|intermediate → só assets registrados no project.json
//   project/<projectId>/<rel>                                  → arquivo da pasta do projeto
// Com scheme "standard" o host chega em minúsculo; o cache de projetos é indexado em minúsculo.

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m4v': 'video/mp4',
  '.bin': 'application/octet-stream'
}

export function registerFileProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: FILE_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } }
  ])
}

function resolveFile(url: URL, store: SessionStore, projects: ProjectStore): string | null {
  const host = decodeURIComponent(url.hostname || url.pathname.split('/')[1] || '')
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (host === FILE_HOST_MEDIA) {
    const [projectId, assetId] = parts
    if (!projectId || !assetId || parts.length !== 2) return null
    const v = url.searchParams.get('v') ?? 'original'
    if (v !== 'original' && v !== 'proxy' && v !== 'intermediate') return null
    return projects.assetPath(projects.cached(projectId), assetId, v, store)
  }
  if (host === FILE_HOST_PROJECT) {
    const [projectId, ...rel] = parts
    if (!projectId || !rel.length) return null
    return projects.filePath(projectId, rel.join('/'))
  }
  // sessionId preservado como veio; o arquivo real é procurado no NTFS (case-insensitive)
  const name = parts.join('/')
  if (!host || !name) return null
  return store.filePath(host, name)
}

export function installFileProtocol(store: SessionStore, projects: ProjectStore): void {
  protocol.handle(FILE_PROTOCOL, (request) => {
    try {
      const url = new URL(request.url)
      const file = resolveFile(url, store, projects)
      if (!file) return new Response('bad request', { status: 400 })
      const st = statSync(file)
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
      const type = MIME[ext] ?? 'application/octet-stream'
      const range = request.headers.get('range')
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        let start = m && m[1] ? Number(m[1]) : 0
        let end = m && m[2] ? Number(m[2]) : st.size - 1
        if (Number.isNaN(start)) start = 0
        if (Number.isNaN(end) || end >= st.size) end = st.size - 1
        if (start > end || start >= st.size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } })
        }
        const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
        return new Response(stream, {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${st.size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*'
          }
        })
      }
      const stream = Readable.toWeb(createReadStream(file)) as ReadableStream
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }
      })
    } catch (e) {
      log.warn(`cialight-file: ${request.url} → ${String(e)}`)
      return new Response('not found', { status: 404 })
    }
  })
}
