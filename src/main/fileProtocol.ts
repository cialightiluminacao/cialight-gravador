import { protocol } from 'electron'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'
import { FILE_PROTOCOL } from '@shared/ipc'
import type { SessionStore } from './session/sessionStore'
import { log } from './log'

// cialight-file://<sessionId>/<arquivo> → arquivo da pasta da sessão, com suporte
// a Range (o <video> da revisão faz seek; mediabunny UrlSource lê por faixas).

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json',
  '.wav': 'audio/wav'
}

export function registerFileProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: FILE_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } }
  ])
}

export function installFileProtocol(store: SessionStore): void {
  protocol.handle(FILE_PROTOCOL, (request) => {
    try {
      const url = new URL(request.url)
      const sessionId = decodeURIComponent(url.hostname || url.pathname.split('/')[1] || '')
      // com scheme "standard", o host vira lowercase; sessionIds são case-insensitive no NTFS, mas
      // preservamos: procuramos o arquivo real
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      const name = parts.length ? parts.join('/') : ''
      if (!sessionId || !name) return new Response('bad request', { status: 400 })
      const file = store.filePath(sessionId, name.replace(/\//g, '\\'))
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
            'Cache-Control': 'no-cache'
          }
        })
      }
      const stream = Readable.toWeb(createReadStream(file)) as ReadableStream
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }
      })
    } catch (e) {
      log.warn(`cialight-file: ${request.url} → ${String(e)}`)
      return new Response('not found', { status: 404 })
    }
  })
}
