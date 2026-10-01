// Modo spike do EDITOR (CIALIGHT_SPIKE=editor): Fase F0 da spec do editor de vídeo.
// Gera mídia de teste com o ffmpeg embutido, serve via cialight-file://media/<arquivo>
// (com Range, como o UrlSource do mediabunny exige), abre editor-spike.html, que roda
// todos os testes sozinho e devolve um relatório JSON. Não faz parte do app final.
import { app, BrowserWindow, ipcMain, protocol } from 'electron'
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { execFile } from 'child_process'
import { FILE_PROTOCOL } from '@shared/ipc'
import { loadPage } from '../windows/recorderWindow'
import { ffmpegPath, ffprobePath } from '../export/ffmpegPath'

const outDir = join(app.getAppPath(), 'spike-out')
const mediaDir = join(outDir, 'editor-media')
const logFile = join(outDir, 'editor-spike-log.txt')
const reportFile = join(outDir, process.env.CIALIGHT_SPIKE_REPORT ?? 'editor-spike.json')

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  appendFileSync(logFile, line + '\n')
}

function run(bin: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout) + String(stderr) })
    })
  })
}

// testsrc2 tem muito detalhe de alta frequência (bom para medir o efeito do blur/pixelate).
const SRC_1080 = ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=10']
const SINE_1K = ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=10']
const MEDIA: Record<string, string[]> = {
  'h264_g60.mp4': [...SRC_1080, ...SINE_1K, '-ac', '2', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k', '-shortest'],
  'h264_g15.mp4': [...SRC_1080, ...SINE_1K, '-ac', '2', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k', '-shortest'],
  'hevc.mp4': [...SRC_1080, ...SINE_1K, '-ac', '2', '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-x265-params', 'keyint=60:min-keyint=60:log-level=error', '-c:a', 'aac', '-b:a', '128k', '-shortest'],
  'vp9.webm': [...SRC_1080, ...SINE_1K, '-ac', '2', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '4M', '-g', '60', '-c:a', 'libopus', '-b:a', '128k', '-shortest'],
  'h264_4k.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30:duration=10', ...SINE_1K, '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '60', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k', '-shortest'],
  'img.png': ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=1:duration=1', '-frames:v', '1'],
  'tone.mp3': ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=5', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k']
}

async function generateMedia(): Promise<Record<string, unknown>> {
  mkdirSync(mediaDir, { recursive: true })
  const res: Record<string, unknown> = {}
  for (const [name, args] of Object.entries(MEDIA)) {
    const file = join(mediaDir, name)
    if (existsSync(file) && statSync(file).size > 0) {
      res[name] = { cached: true, bytes: statSync(file).size }
      continue
    }
    const t0 = Date.now()
    const r = await run(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args, file])
    res[name] = { ok: r.ok, ms: Date.now() - t0, bytes: existsSync(file) ? statSync(file).size : 0, err: r.ok ? undefined : r.out.slice(-800) }
    log(`mídia ${name}: ${JSON.stringify(res[name])}`)
  }
  return res
}

const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.mp3': 'audio/mpeg' }

function installMediaProtocol(): void {
  protocol.handle(FILE_PROTOCOL, (request) => {
    try {
      const url = new URL(request.url)
      const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).join('/'))
      if (url.hostname !== 'media' || !name || name.includes('..')) return new Response('bad request', { status: 400 })
      const file = join(mediaDir, name)
      const st = statSync(file)
      const type = MIME[file.slice(file.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream'
      const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }
      const range = request.headers.get('range')
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        const start = m && m[1] ? Number(m[1]) : 0
        let end = m && m[2] ? Number(m[2]) : st.size - 1
        if (end >= st.size) end = st.size - 1
        if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } })
        const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
        return new Response(stream, { status: 206, headers: { ...base, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}` } })
      }
      const stream = Readable.toWeb(createReadStream(file)) as ReadableStream
      return new Response(stream, { status: 200, headers: { ...base, 'Content-Length': String(st.size) } })
    } catch (e) {
      log(`protocolo: ${request.url} → ${String(e)}`)
      return new Response('not found', { status: 404 })
    }
  })
}

async function probe(file: string): Promise<unknown> {
  const r = await run(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-count_frames', file])
  if (!r.ok) return { error: r.out.slice(-800) }
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf('{'))) as { streams: Record<string, unknown>[]; format: Record<string, unknown> }
    return {
      format: { name: j.format.format_name, duration: j.format.duration, size: j.format.size, bit_rate: j.format.bit_rate },
      streams: j.streams.map((s) => ({
        type: s.codec_type,
        codec: s.codec_name,
        profile: s.profile,
        tag: s.codec_tag_string,
        w: s.width,
        h: s.height,
        r_frame_rate: s.r_frame_rate,
        sample_rate: s.sample_rate,
        channels: s.channels,
        duration: s.duration,
        nb_read_frames: s.nb_read_frames,
        bit_rate: s.bit_rate
      }))
    }
  } catch (e) {
    return { error: String(e) }
  }
}

async function volume(file: string): Promise<string> {
  const r = await run(ffmpegPath(), ['-hide_banner', '-i', file, '-map', '0:a:0?', '-af', 'volumedetect', '-f', 'null', '-'])
  const m = r.out.match(/mean_volume: ([-\d.]+) dB[\s\S]*?max_volume: ([-\d.]+) dB/)
  return m ? `mean ${m[1]} dB, max ${m[2]} dB` : 'sem áudio'
}

export async function runEditorSpike(flagApplied: boolean): Promise<void> {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(logFile, '')
  log(`Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node} / flag ReclaimInactiveWebCodecs desligada=${flagApplied}`)
  const media = await generateMedia()
  installMediaProtocol()

  const handles = new Map<number, number>()
  let nextHandle = 1
  let win: BrowserWindow | null = null

  ipcMain.on('spike:log', (_e, msg: string) => {
    if (msg === '__minimize__') {
      win?.minimize()
      log('janela minimizada (teste de reclaim)')
      return
    }
    if (msg === '__restore__') {
      win?.restore()
      log('janela restaurada')
      return
    }
    log(`[renderer] ${msg}`)
  })
  ipcMain.handle('spike:openWrite', (_e, name: string) => {
    const fd = openSync(join(mediaDir, name), 'w')
    const h = nextHandle++
    handles.set(h, fd)
    return h
  })
  ipcMain.handle('spike:write', (_e, h: number, data: Uint8Array, position: number) => {
    const fd = handles.get(h)
    if (fd === undefined) throw new Error('handle inválido')
    writeSync(fd, data, 0, data.byteLength, position)
  })
  ipcMain.handle('spike:closeWrite', (_e, h: number) => {
    const fd = handles.get(h)
    if (fd !== undefined) closeSync(fd)
    handles.delete(h)
  })

  const finish = async (report: unknown, reason: string): Promise<unknown> => {
    const r = (report ?? {}) as { encodedFiles?: string[] }
    const probes: Record<string, unknown> = {}
    for (const f of r.encodedFiles ?? []) {
      const file = join(mediaDir, f)
      probes[f] = existsSync(file) ? { ...((await probe(file)) as object), volume: await volume(file) } : { error: 'arquivo não existe' }
    }
    let mediabunnyVersion = '?'
    try {
      mediabunnyVersion = (JSON.parse(readFileSync(join(app.getAppPath(), 'node_modules/mediabunny/package.json'), 'utf8')) as { version: string }).version
    } catch {
      /* ignora */
    }
    const full = {
      reason,
      when: new Date().toISOString(),
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, mediabunny: mediabunnyVersion },
      reclaimFlag: { applied: flagApplied, disableFeatures: app.commandLine.getSwitchValue('disable-features') },
      gpu: await app.getGPUInfo('basic').catch((e: unknown) => String(e)),
      media,
      report,
      probes
    }
    writeFileSync(reportFile, JSON.stringify(full, null, 2))
    log(`relatório escrito em ${reportFile} (${reason})`)
    return full
  }

  ipcMain.handle('spike:done', async (_e, report: unknown) => {
    const full = await finish(report, 'done')
    setTimeout(() => app.exit(0), 300)
    return full
  })

  const timeoutMs = Number(process.env.CIALIGHT_SPIKE_TIMEOUT_MS ?? 15 * 60_000)
  setTimeout(() => {
    log('timeout global do spike')
    void finish({ error: 'timeout global' }, 'timeout').then(() => app.exit(2))
  }, timeoutMs)

  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'SPIKE Editor — CiaLight Gravador',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, backgroundThrottling: process.env.CIALIGHT_SPIKE_BGTHROTTLE === '1' }
  })
  const only = process.env.CIALIGHT_SPIKE_ONLY ?? ''
  const idle = process.env.CIALIGHT_SPIKE_IDLE_S ?? '100'
  loadPage(win, `editor-spike.html?only=${encodeURIComponent(only)}&idle=${idle}&flag=${flagApplied ? 1 : 0}`)
  win.on('closed', () => app.quit())
}
