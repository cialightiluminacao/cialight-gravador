import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { constants, tmpdir } from 'os'
import { join } from 'path'
import type { spawn } from 'child_process'
import type { TranscribeProgress, TranscribeRequest } from '@shared/ipc'
import { LOW_VOICE_WARNING, TranscribeCancelledError, TranscribeService, WHISPER_START_ERROR, mergeWords, parseWhisperProgress, transcribeInputOf, whisperThreads, type TranscribeDeps } from './transcribeService'
import type { Asset } from '@shared/editor/project'

let root: string
let media: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'transcribe-svc-'))
  media = join(root, 'fala.mp4')
  writeFileSync(media, 'x')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** WAV 16 kHz mono s16 com `sec` segundos de zeros. */
function wavBytes(sec: number): Buffer {
  const data = Math.round(sec * 32000)
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(36 + data, 4)
  b.write('WAVEfmt ', 8, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24)
  b.writeUInt32LE(32000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(data, 40)
  return b
}

const seg = (fromMs: number, toMs: number, words: [string, number][]): unknown => ({
  offsets: { from: fromMs, to: toMs },
  text: words.map((w) => ` ${w[0]}`).join(''),
  tokens: [{ text: '[_BEG_]', offsets: { from: fromMs, to: fromMs }, p: 1, t_dtw: -1 }, ...words.map(([t, dtw], i) => ({ text: ` ${t}`, offsets: { from: i === 0 ? fromMs + 100 : 0, to: 0 }, p: 0.9, t_dtw: dtw }))]
})

interface Call { cmd: string; args: string[]; opts: { cwd?: string }; child: FakeChild }
class FakeChild extends EventEmitter {
  stderr = new EventEmitter()
  killed = false
  constructor(public pid: number) {
    super()
  }
  kill(): boolean {
    this.killed = true
    setTimeout(() => this.emit('close', null), 5)
    return true
  }
}

type Behavior = (c: Call) => void
interface Fake { spawn: typeof spawn; calls: Call[]; priorities: [number, number][] }
function fake(behave: { extract?: Behavior; silence?: Behavior; whisper?: Behavior }): Fake {
  const calls: Call[] = []
  let pid = 1000
  const sp = ((cmd: string, args: string[], opts: { cwd?: string }) => {
    const child = new FakeChild(++pid)
    const c: Call = { cmd, args, opts, child }
    calls.push(c)
    const kind = cmd.endsWith('whisper-cli.exe') ? 'whisper' : args.at(-1) === '-' ? 'silence' : 'extract'
    const def: Behavior =
      kind === 'extract'
        ? (x) => {
            writeFileSync(x.args.at(-1)!, wavBytes(Number(x.args[x.args.indexOf('-t') + 1])))
            setTimeout(() => x.child.emit('close', 0), 1)
          }
        : kind === 'silence'
          ? (x) =>
              setTimeout(() => {
                x.child.stderr.emit('data', Buffer.from('[silencedetect @ 0] silence_start: 3\n[silencedetect @ 0] silence_end: 5 | silence_duration: 2\n'))
                x.child.emit('close', 0)
              }, 1)
          : (x) => {
              const out = x.args[x.args.indexOf('-of') + 1]
              writeFileSync(`${out}.json`, JSON.stringify({ transcription: [seg(0, 2900, [['olá', 50], ['mundo', 90]]), seg(5000, 6000, [['tchau', 560]])] }))
              setTimeout(() => x.child.emit('close', 0), 1)
            }
    setTimeout(() => (behave[kind] ?? def)(c), 0)
    return child
  }) as unknown as typeof spawn
  return { spawn: sp, calls, priorities: [] }
}

function service(f: Fake, extra: Partial<TranscribeDeps> = {}): { svc: TranscribeService; temps: string[]; pids: number[] } {
  const temps: string[] = []
  const pids: number[] = []
  const svc = new TranscribeService({
    resolveInput: () => ({ path: media, audioMap: '0:a:1', name: 'fala.mp4' }),
    ffmpegPath: () => 'C:/ff/ffmpeg.exe',
    whisperCliPath: () => 'C:/wh/whisper-cli.exe',
    modelsDir: () => 'C:/modelos',
    modelFile: () => 'C:/modelos/ggml-base.bin',
    spawn: f.spawn,
    tmpRoot: () => root,
    cpuCount: () => 16,
    setPriority: (pid, prio) => f.priorities.push([pid, prio]),
    hooks: { onTempDir: (d) => temps.push(d), onChild: (pid) => pids.push(pid) },
    ...extra
  })
  return { svc, temps, pids }
}

const req = (jobs: TranscribeRequest['jobs'], over: Partial<TranscribeRequest> = {}): TranscribeRequest => ({ projectId: 'p1', modelId: 'base', language: 'pt', jobs, ...over })

describe('whisperThreads', () => {
  it('clamp(floor(lógicos/2), 1, 8)', () => {
    expect([1, 2, 3, 8, 16, 32].map(whisperThreads)).toEqual([1, 1, 1, 4, 8, 8])
  })
})

describe('TranscribeService', () => {
  it('extrai, detecta silêncio e roda o whisper com os argumentos do spike; palavras em tempo da fonte', async () => {
    const f = fake({})
    const { svc, temps } = service(f)
    const prog: TranscribeProgress[] = []
    const r = await svc.transcribe(req([{ assetId: 'a1', fromUs: 10_000_000, toUs: 16_000_000 }]), (p) => prog.push(p))
    expect(f.calls.map((c) => c.cmd)).toEqual(['C:/ff/ffmpeg.exe', 'C:/ff/ffmpeg.exe', 'C:/wh/whisper-cli.exe'])
    const ex = f.calls[0].args
    // origem = pts do contêiner (como o mixer): -copyts, -ss absoluto só para buscar 1 s antes, corte exato no atrim
    expect(ex.slice(0, ex.indexOf('-i'))).toEqual(['-hide_banner', '-nostdin', '-v', 'error', '-y', '-copyts', '-seek_timestamp', '1', '-noaccurate_seek', '-ss', '9.000000'])
    expect(ex[ex.indexOf('-af') + 1]).toBe('atrim=start=10.000000:end=16.000000,asetpts=PTS-10.000000/TB,aresample=16000:async=1:first_pts=0')
    expect(ex.slice(ex.indexOf('-t'), ex.indexOf('-t') + 2)).toEqual(['-t', '6.000000'])
    expect(ex).toEqual(expect.arrayContaining(['-map', '0:a:1', '-ac', '1', '-c:a', 'pcm_s16le']))
    expect(f.calls[1].args.join(' ')).toContain('silencedetect=n=-35dB:d=0.35')
    const w = f.calls[2]
    const wav = join(temps[0], 'job0.wav')
    expect(w.args).toEqual(['-m', 'ggml-base.bin', '-f', wav, '-l', 'pt', '-t', '8', '-bs', '1', '-bo', '1', '--dtw', 'base', '-nfa', '-np', '-pp', '-ojf', '-of', join(temps[0], 'job0')])
    expect(w.opts.cwd).toBe('C:/modelos')
    expect(f.priorities).toEqual([[w.child.pid, constants.priority.PRIORITY_BELOW_NORMAL]])
    // tchau: t_dtw anterior? 1ª do segmento → offsets.from 5100 ms (fala volta em 5 s − 120 ms) → +10 s
    expect(r.words.a1.map((x) => [x.text, x.startUs])).toEqual([['olá', 10_100_000], ['mundo', 10_500_000], ['tchau', 15_100_000]])
    expect(r.words.a1.at(-1)!.endUs).toBe(16_000_000) // fim do segmento 6 s + 10 s, limitado ao fim do trecho
    expect(r.warnings).toEqual([])
    expect(temps[0].startsWith(join(root, 'cialight-whisper-'))).toBe(true)
    expect(existsSync(temps[0])).toBe(false)
    expect(prog.map((p) => p.stage)).toEqual(['extract', 'transcribe', 'transcribe'])
    expect(prog.at(-1)!.fraction).toBe(1)
  })

  it('vários trechos: progresso ponderado pela duração; palavras do mesmo asset juntas, ordenadas e sem duplicata', async () => {
    const f = fake({})
    const { svc } = service(f)
    const prog: TranscribeProgress[] = []
    const r = await svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 6_000_000 }, { assetId: 'a1', fromUs: 20_000_000, toUs: 26_000_000 }, { assetId: 'a2', fromUs: 0, toUs: 12_000_000 }]), (p) => prog.push(p))
    expect(r.words.a1.map((w) => w.startUs)).toEqual([100_000, 500_000, 5_100_000, 20_100_000, 20_500_000, 25_100_000])
    expect(r.words.a2).toHaveLength(3)
    expect(prog.filter((p) => p.stage === 'extract').map((p) => [p.jobIndex, p.fraction])).toEqual([[0, 0], [1, 0.25], [2, 0.5]])
    for (let i = 1; i < prog.length; i++) expect(prog[i].fraction).toBeGreaterThanOrEqual(prog[i - 1].fraction)
  })

  it('sem fala detectada (silencedetect: tudo silêncio) → mantém palavras e avisa “Fala muito baixa”', async () => {
    const f = fake({
      silence: (x) =>
        setTimeout(() => {
          x.child.stderr.emit('data', Buffer.from('silence_start: 0\nsilence_end: 6 | silence_duration: 6\n'))
          x.child.emit('close', 0)
        }, 1)
    })
    const { svc } = service(f)
    const r = await svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 6_000_000 }]), () => {})
    expect(r.words.a1.map((w) => w.text)).toEqual(['olá', 'mundo', 'tchau'])
    expect(r.warnings).toEqual([LOW_VOICE_WARNING])
  })

  it('modelo ausente → erro pt-BR pedindo o download, sem processo nem pasta temporária', async () => {
    const f = fake({})
    const { svc, temps } = service(f, { modelFile: () => null })
    await expect(svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 1_000_000 }], { modelId: 'small' }), () => {})).rejects.toThrow('O modelo de transcrição “Preciso” não está baixado. Baixe o modelo para gerar as legendas.')
    expect(f.calls).toEqual([])
    expect(temps).toEqual([])
  })

  it('whisper sai com erro → erro pt-BR e pasta temporária apagada', async () => {
    const f = fake({ whisper: (x) => setTimeout(() => x.child.emit('close', 3), 1) })
    const logs: string[] = []
    const { svc, temps } = service(f, { log: { info: () => {}, warn: () => {}, error: (m: unknown) => logs.push(String(m)) } })
    await expect(svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 6_000_000 }]), () => {})).rejects.toThrow(/A transcrição falhou \(whisper, código 3\)/)
    expect(existsSync(temps[0])).toBe(false)
    expect(logs.some((l) => l.includes('código 3'))).toBe(true)
  })

  it('whisper não inicia (DLL ausente 0xC0000135 ou erro de spawn) → mensagem pt-BR acionável', async () => {
    const f1 = fake({ whisper: (x) => setTimeout(() => x.child.emit('close', 0xc0000135), 1) })
    await expect(service(f1).svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 6_000_000 }]), () => {})).rejects.toThrow(WHISPER_START_ERROR)
    const f2 = fake({ whisper: (x) => setTimeout(() => x.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })), 1) })
    await expect(service(f2).svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 6_000_000 }]), () => {})).rejects.toThrow(WHISPER_START_ERROR)
  })

  it('cancelar durante o whisper → mata só o filho dele, rejeita com cancelamento e apaga a pasta temporária', async () => {
    let whisperChild: FakeChild | null = null
    const f = fake({ whisper: (x) => (whisperChild = x.child) }) // nunca termina sozinho
    const { svc, temps } = service(f)
    const ac = new AbortController()
    const p = svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 6_000_000 }]), (pr) => {
      if (pr.stage === 'transcribe') setTimeout(() => ac.abort(), 10)
    }, ac.signal)
    await expect(p).rejects.toBeInstanceOf(TranscribeCancelledError)
    await expect(p).rejects.toThrow('Transcrição cancelada')
    expect(whisperChild!.killed).toBe(true)
    expect(f.calls.filter((c) => c.child.killed)).toHaveLength(1)
    expect(existsSync(temps[0])).toBe(false)
    expect(readdirSync(root)).toEqual(['fala.mp4'])
  })

  it('cancelar durante a extração → mata o ffmpeg e não inicia o whisper', async () => {
    const f = fake({ extract: () => {} })
    const { svc, temps } = service(f)
    const ac = new AbortController()
    const p = svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 6_000_000 }]), () => setTimeout(() => ac.abort(), 10), ac.signal)
    await expect(p).rejects.toBeInstanceOf(TranscribeCancelledError)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].child.killed).toBe(true)
    expect(existsSync(temps[0])).toBe(false)
  })

  it('uma por vez: a segunda chamada durante uma execução → erro pt-BR; depois de terminar, aceita de novo', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    const f = fake({
      whisper: (x) => {
        gate.release = () => {
          const out = x.args[x.args.indexOf('-of') + 1]
          writeFileSync(`${out}.json`, JSON.stringify({ transcription: [] }))
          x.child.emit('close', 0)
        }
      }
    })
    const { svc } = service(f)
    const first = svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 6_000_000 }]), () => {})
    await expect(svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 6_000_000 }]), () => {})).rejects.toThrow('Já existe uma transcrição em andamento')
    while (!gate.release) await new Promise((r) => setTimeout(r, 5))
    gate.release()
    expect((await first).words).toEqual({ a1: [] })
    expect(svc.busy).toBe(false)
    await expect(svc.transcribe(req([]), () => {})).resolves.toEqual({ words: {}, warnings: [] })
  })

  it('arquivo de mídia ausente → erro pt-BR antes de qualquer processo', async () => {
    const f = fake({})
    const { svc } = service(f, { resolveInput: () => ({ path: join(root, 'sumiu.mp4'), audioMap: '0:a:0', name: 'sumiu.mp4' }) })
    await expect(svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 1_000_000 }]), () => {})).rejects.toThrow('Arquivo de mídia não encontrado: “sumiu.mp4”.')
    expect(f.calls).toEqual([])
  })

  it('trecho vazio (além do fim do arquivo) → sem whisper, sem palavras', async () => {
    const f = fake({ extract: (x) => { writeFileSync(x.args.at(-1)!, wavBytes(0)); setTimeout(() => x.child.emit('close', 0), 1) } })
    const r = await service(f).svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 1_000_000 }]), () => {})
    expect(r.words).toEqual({})
    expect(f.calls).toHaveLength(1)
  })
})

describe('rodada 1: progresso do -pp, palavras além do trecho, limpeza síncrona', () => {
  it('parseWhisperProgress lê "progress = N%" do -pp', () => {
    expect(parseWhisperProgress('whisper_print_progress_callback: progress =  34%')).toBe(34)
    expect(parseWhisperProgress('whisper_print_progress_callback: progress = 100%')).toBe(100)
    expect(parseWhisperProgress('whisper_full_with_state: auto-detected language')).toBeNull()
    expect(parseWhisperProgress('progress = 250%')).toBeNull()
  })

  it('progresso dentro do trecho pelo stderr do whisper (linhas partidas entre pedaços)', async () => {
    const f = fake({
      whisper: (x) => {
        const out = x.args[x.args.indexOf('-of') + 1]
        setTimeout(() => x.child.stderr.emit('data', Buffer.from('whisper_print_progress_callback: progr')), 1)
        setTimeout(() => x.child.stderr.emit('data', Buffer.from('ess =  50%\nwhisper_print_progress_callback: progress = 100%\n')), 2)
        setTimeout(() => {
          writeFileSync(`${out}.json`, JSON.stringify({ transcription: [] }))
          x.child.emit('close', 0)
        }, 4)
      }
    })
    const prog: TranscribeProgress[] = []
    await service(f).svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 6_000_000 }]), (p) => prog.push(p))
    expect(prog.map((p) => [p.stage, +p.fraction.toFixed(3)])).toEqual([['extract', 0], ['transcribe', 0.05], ['transcribe', 0.525], ['transcribe', 1], ['transcribe', 1]])
  })

  it('palavra que começa no fim do trecho ou depois é descartada; nunca fim ≤ início', async () => {
    const f = fake({
      whisper: (x) => {
        const out = x.args[x.args.indexOf('-of') + 1]
        // trecho de 6 s: "d" começa em 5,95 s; "e" em 6,2 s (margem do whisper além do trecho)
        writeFileSync(`${out}.json`, JSON.stringify({ transcription: [seg(5400, 7000, [['a', 560], ['b', 570], ['c', 595], ['d', 620], ['e', 640]])] }))
        setTimeout(() => x.child.emit('close', 0), 1)
      },
      silence: (x) => setTimeout(() => x.child.emit('close', 0), 1)
    })
    const r = await service(f).svc.transcribe(req([{ assetId: 'a1', fromUs: 10_000_000, toUs: 16_000_000 }]), () => {})
    expect(r.words.a1.map((w) => [w.text, w.startUs, w.endUs])).toEqual([['a', 15_500_000, 15_600_000], ['b', 15_600_000, 15_700_000], ['c', 15_700_000, 15_950_000], ['d', 15_950_000, 16_000_000]])
  })

  it('killAndCleanupSync (saída do app): mata o filho desta execução e apaga a pasta temporária na hora', async () => {
    let whisperChild: FakeChild | null = null
    const f = fake({ whisper: (x) => (whisperChild = x.child) })
    const { svc, temps } = service(f)
    expect(svc.killAndCleanupSync()).toBeNull()
    const p = svc.transcribe(req([{ assetId: 'a1', fromUs: 0, toUs: 6_000_000 }]), () => {})
    while (!whisperChild) await new Promise((r) => setTimeout(r, 2))
    expect(existsSync(temps[0])).toBe(true)
    expect(svc.killAndCleanupSync()).toBe(temps[0])
    expect(existsSync(temps[0])).toBe(false) // síncrono: já apagada
    expect((whisperChild as FakeChild | null)?.killed).toBe(true)
    p.catch(() => {}) // o filho morto fecha sem JSON: a execução falha (o app está saindo)
  })
})

describe('transcribeInputOf / mergeWords', () => {
  const deps = { projectFile: (p: string, r: string) => `P/${p}/${r}`, sessionFile: (s: string, n: string) => `S/${s}/${n}`, sessionTracks: () => ({ screen: 0, mic: 0, system: 1 }) }
  const base = { id: 'a', name: 'x.mp4', durationUs: 1, status: 'ready' } as const
  it('stream de áudio pela regra da ingestão; sem áudio → erro pt-BR', () => {
    expect(transcribeInputOf(deps, 'p', { ...base, kind: 'video', audio: {} as Asset['audio'], source: { type: 'file', path: 'C:/v.mp4' } } as Asset, 'a')).toEqual({ path: 'C:/v.mp4', audioMap: '0:a:0', name: 'x.mp4' })
    expect(transcribeInputOf(deps, 'p', { ...base, kind: 'audio', source: { type: 'session', sessionId: 's1', stream: 'system' } } as Asset, 'a')).toEqual({ path: 'S/s1/rec.mp4', audioMap: '0:a:1', name: 'x.mp4' })
    expect(() => transcribeInputOf(deps, 'p', { ...base, kind: 'video', source: { type: 'file', path: 'C:/v.mp4' } } as Asset, 'a')).toThrow('“x.mp4” não tem áudio para transcrever.')
    expect(() => transcribeInputOf(deps, 'p', undefined, 'zz')).toThrow(/não encontrada/)
  })
  it('faixa de áudio = a do mixer: audioTrackIndex quando definido; gravação mic/sistema; tela com áudio → principal', () => {
    // arquivo multi-faixa com audioTrackIndex (o mixer toca a:1; a ingestão sozinha diria a:0)
    expect(transcribeInputOf(deps, 'p', { ...base, kind: 'video', audio: {} as Asset['audio'], audioTrackIndex: 1, source: { type: 'file', path: 'C:/v.mp4' } } as Asset, 'a').audioMap).toBe('0:a:1')
    // gravação: mic = a:0, sistema = a:1 (session.tracks), com o audioTrackIndex do fromSession
    expect(transcribeInputOf(deps, 'p', { ...base, kind: 'audio', audioTrackIndex: 0, source: { type: 'session', sessionId: 's1', stream: 'mic' } } as Asset, 'a').audioMap).toBe('0:a:0')
    expect(transcribeInputOf(deps, 'p', { ...base, kind: 'audio', audioTrackIndex: 1, source: { type: 'session', sessionId: 's1', stream: 'system' } } as Asset, 'a').audioMap).toBe('0:a:1')
    // tela da gravação: sem `audio` (fromSession) → fora; se tivesse, o mixer tocaria a faixa principal (a:0)
    expect(() => transcribeInputOf(deps, 'p', { ...base, kind: 'video', source: { type: 'session', sessionId: 's1', stream: 'screen' } } as Asset, 'a')).toThrow(/não tem áudio/)
    expect(transcribeInputOf(deps, 'p', { ...base, kind: 'video', audio: {} as Asset['audio'], source: { type: 'session', sessionId: 's1', stream: 'screen' } } as Asset, 'a')).toEqual({ path: 'S/s1/rec.mp4', audioMap: '0:a:0', name: 'x.mp4' })
  })
  it('mergeWords ordena e remove início + texto repetidos', () => {
    expect(mergeWords([{ text: 'b', startUs: 2, endUs: 3 }, { text: 'a', startUs: 1, endUs: 2 }, { text: 'b', startUs: 2, endUs: 3 }, { text: 'c', startUs: 2, endUs: 4 }]).map((w) => w.text)).toEqual(['a', 'b', 'c'])
  })
})
