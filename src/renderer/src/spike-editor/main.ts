// Spike F0 do editor: roda todos os testes automaticamente e envia o relatório ao main
// (que grava spike-out/editor-spike.json e encerra). Ver docs/research/2026-10-01-editor-spike-results.md.
import SignalsmithStretch from 'signalsmith-stretch'
import GlWorker from './gl.worker?worker'
import DecodeWorker from './decode.worker?worker'
import EncodeWorker from './encode.worker?worker'
import StretchWorker from './stretch.worker?worker'
import ReclaimWorker from './reclaim.worker?worker'
import { analyze, makeTestSignal, SR } from './audioAnalysis'

const q = new URLSearchParams(location.search)
const only = (q.get('only') ?? '').split(',').filter(Boolean)
const idleSec = Number(q.get('idle') ?? 100)
const want = (t: string): boolean => only.length === 0 || only.includes(t)
const BASE = 'cialight-file://media/'
const pre = document.getElementById('log')!

function log(msg: string): void {
  pre.textContent += msg + '\n'
  window.spikeApi.log(msg)
}

type Reply = { ok: boolean; result?: unknown; error?: string; [k: string]: unknown }

function call(w: Worker, msg: unknown, transfer: Transferable[] = [], timeoutMs = 180_000): Promise<Reply> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: `timeout ${timeoutMs} ms` }), timeoutMs)
    const onMsg = (e: MessageEvent<Reply>): void => {
      clearTimeout(timer)
      w.removeEventListener('message', onMsg)
      resolve(e.data)
    }
    w.addEventListener('message', onMsg)
    w.onerror = (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `worker error: ${e.message}` })
    }
    w.postMessage(msg, transfer)
  })
}

async function saveFile(name: string, data: ArrayBuffer): Promise<void> {
  const h = await window.spikeApi.openWrite(name)
  const CH = 8 * 1024 * 1024
  for (let o = 0; o < data.byteLength; o += CH) await window.spikeApi.write(h, new Uint8Array(data, o, Math.min(CH, data.byteLength - o)), o)
  await window.spikeApi.closeWrite(h)
}

/** Teste 5b: caminho oficial do pacote (AudioWorkletNode) num OfflineAudioContext. */
async function stretchWorklet(rates: number[], seconds: number): Promise<unknown> {
  const rows: unknown[] = []
  for (const rate of rates) {
    try {
      const input = makeTestSignal(seconds)
      const L = Math.round(input[0].length / rate)
      const ctx = new OfflineAudioContext(2, L, SR)
      const node = await SignalsmithStretch(ctx)
      node.connect(ctx.destination)
      await node.addBuffers(input)
      node.schedule({ active: true, input: 0, output: 0, rate })
      const t0 = performance.now()
      const buf = await ctx.startRendering()
      const ms = performance.now() - t0
      rows.push({ rate, outSeconds: +buf.duration.toFixed(3), ms: Math.round(ms), realtimeFactorOut: +(buf.duration / (ms / 1000)).toFixed(1), latencySec: +(await node.latency()).toFixed(4), ...analyze(buf.getChannelData(0), rate) })
    } catch (e) {
      rows.push({ rate, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) })
    }
  }
  return rows
}

async function main(): Promise<void> {
  const report: Record<string, unknown> & { encodedFiles: string[] } = { encodedFiles: [], userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency }
  const t0 = performance.now()
  log(`spike editor: only=${only.join(',') || 'tudo'} idle=${idleSec}s flag=${q.get('flag')}`)

  // 6 (início): decoder ocioso
  let reclaim: Worker | null = null
  let reclaimPreparedAt = 0
  if (want('reclaim')) {
    reclaim = new ReclaimWorker()
    const r = await call(reclaim, { cmd: 'prepare', url: BASE + 'h264_g60.mp4' })
    reclaimPreparedAt = performance.now()
    report.reclaimPrepare = r
    log(`reclaim prepare: ${JSON.stringify(r)}`)
  }

  // 2: WebGL2 no worker
  if (want('webgl')) {
    const canvas = document.getElementById('view') as HTMLCanvasElement
    const off = canvas.transferControlToOffscreen()
    const w = new GlWorker()
    const r = await call(w, { canvas: off, url: BASE + 'h264_g60.mp4', frames: 90 }, [off])
    if (r.png instanceof ArrayBuffer) {
      await saveFile('webgl-effects.png', r.png)
      delete r.png
    }
    report.webgl = r
    log(`webgl: ${JSON.stringify(r)}`)
    w.terminate()
  }

  // 3: decodificação
  if (want('decode')) {
    const w = new DecodeWorker()
    const files = ['h264_g60.mp4', 'h264_g15.mp4', 'hevc.mp4', 'vp9.webm', 'h264_4k.mp4']
    report.decode = await call(w, { cmd: 'decode', files, base: BASE }, [], 300_000)
    log(`decode: ${JSON.stringify(report.decode)}`)
    report.image = await call(w, { cmd: 'image', url: BASE + 'img.png' })
    log(`image: ${JSON.stringify(report.image)}`)
    w.terminate()
  }
  if (want('concurrent')) {
    for (const hw of ['prefer-hardware', 'no-preference'] as const) {
      const w = new DecodeWorker()
      const r = await call(w, { cmd: 'concurrent', url: BASE + 'h264_g60.mp4', max: 10, hw }, [], 300_000)
      report[`concurrent_${hw}`] = r
      log(`concurrent ${hw}: ${JSON.stringify(r)}`)
      w.terminate()
    }
  }

  // 4: codificação
  if (want('encode')) {
    const w = new EncodeWorker()
    report.encodeSupport = await call(w, { cmd: 'support' })
    log(`encode support: ${JSON.stringify(report.encodeSupport)}`)
    report.rawEncode = await call(w, { cmd: 'raw' })
    log(`raw encode: ${JSON.stringify(report.rawEncode)}`)
    const jobs = [
      { name: 'enc_avc_hw.mp4', codec: 'avc', hw: 'prefer-hardware' },
      { name: 'enc_avc_sw.mp4', codec: 'avc', hw: 'prefer-software' },
      { name: 'enc_hevc_hw.mp4', codec: 'hevc', hw: 'prefer-hardware' },
      { name: 'enc_e2e_avc_hw.mp4', codec: 'avc', hw: 'prefer-hardware', e2eUrl: BASE + 'h264_g60.mp4' }
    ]
    const results: Record<string, unknown> = {}
    for (const j of jobs) {
      const r = await call(w, { cmd: 'encode', seconds: 10, ...j }, [], 300_000)
      const res = r.result as { file?: ArrayBuffer } | undefined
      if (res?.file) {
        await saveFile(j.name, res.file)
        delete res.file
        report.encodedFiles.push(j.name)
      }
      results[j.name] = r
      log(`encode ${j.name}: ${JSON.stringify(r)}`)
    }
    report.encode = results
    w.terminate()
  }

  // 5: time-stretch
  if (want('stretch')) {
    const w = new StretchWorker()
    report.stretchWorker = await call(w, { rates: [0.5, 1, 1.5, 2, 4], seconds: 5 }, [], 300_000)
    log(`stretch worker: ${JSON.stringify(report.stretchWorker)}`)
    w.terminate()
    report.stretchWorklet = await stretchWorklet([0.5, 1.5, 2, 4], 5)
    log(`stretch worklet: ${JSON.stringify(report.stretchWorklet)}`)
  }

  // 7: AudioSampleSink
  if (want('audio')) {
    const w = new DecodeWorker()
    report.audioSink = await call(w, { cmd: 'audio', files: ['tone.mp3', 'h264_g60.mp4', 'vp9.webm', 'enc_avc_hw.mp4'], base: BASE })
    log(`audio sink: ${JSON.stringify(report.audioSink)}`)
    w.terminate()
  }

  // 6 (fim): minimiza, espera e tenta continuar
  if (reclaim) {
    const already = (performance.now() - reclaimPreparedAt) / 1000
    log('__minimize__')
    const wait = Math.max(idleSec - already, 0) + 5
    log(`reclaim: ocioso há ${already.toFixed(0)} s; minimizado aguardando mais ${wait.toFixed(0)} s`)
    await new Promise((r) => setTimeout(r, 3000))
    report.reclaimVisibilityWhileMinimized = { visibilityState: document.visibilityState, hidden: document.hidden }
    await new Promise((r) => setTimeout(r, Math.max(0, wait * 1000 - 3000)))
    log('__restore__')
    report.reclaimResume = await call(reclaim, { cmd: 'resume' })
    report.reclaimMinimizedSec = Math.round(wait)
    log(`reclaim resume: ${JSON.stringify(report.reclaimResume)}`)
    reclaim.terminate()
  }

  report.totalSec = Math.round((performance.now() - t0) / 1000)
  log(`fim em ${report.totalSec} s`)
  await window.spikeApi.done(report)
}

main().catch(async (e: unknown) => {
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
  log(`FALHA: ${msg}`)
  await window.spikeApi.done({ fatal: msg, encodedFiles: [] })
})
