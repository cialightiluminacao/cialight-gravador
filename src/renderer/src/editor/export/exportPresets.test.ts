import { describe, expect, it } from 'vitest'
import {
  EXPORT_PRESETS,
  exportRequestFor,
  estimateFor,
  fpsChoices,
  outputFileName,
  presetAvailability,
  presetOutputSize,
  basePreset,
  settingsForPreset,
  sizeForHeight,
  sizeForWidth,
  validateExport,
  videoBitrateFor,
  type ExportPresetId,
  type ExportSettings
} from './exportPresets'
import { estimateBytes, MIN_TARGET_BPS, targetBitrate } from './exportPlan'

const MiB = 1024 * 1024
const S = 1_000_000
const cv = (width: number, height: number, fps = 30): { width: number; height: number; fps: number } => ({ width, height, fps })

const C1080 = cv(1920, 1080, 30)
const C1440_60 = cv(2560, 1440, 60)
const C4K = cv(3840, 2160, 30)
const C916 = cv(1080, 1920, 30)
const C11 = cv(1080, 1080, 30)
const C54 = cv(1280, 1024, 30)

const PRESET_IDS: ExportPresetId[] = ['whatsapp', 'youtube1080', 'youtube4k', 'reels', 'feed11', 'feed45', 'original', 'intermediate']

describe('EXPORT_PRESETS', () => {
  it('os 8 presets na ordem, com rótulos em pt-BR', () => {
    expect(EXPORT_PRESETS.map((p) => p.id)).toEqual(PRESET_IDS)
    expect(EXPORT_PRESETS.map((p) => p.label)).toEqual([
      'WhatsApp (até 64 MB)',
      'YouTube 1080p',
      'YouTube 4K',
      'Instagram Reels/Stories (9:16)',
      'Instagram Feed 1:1',
      'Instagram Feed 4:5',
      'Original (máxima)',
      'Edição (intermediário)'
    ])
    for (const p of EXPORT_PRESETS) expect(p.hint.length).toBeGreaterThan(0)
  })
  it('valores da tabela (fps, qualidade, quadro-chave, áudio, HEVC)', () => {
    const by = Object.fromEntries(EXPORT_PRESETS.map((p) => [p.id, p]))
    expect(by.whatsapp).toMatchObject({ size: { kind: 'fit', maxW: 1280, maxH: 720 }, fpsCap: 30, quality: { kind: 'target', mb: 64, maxBps: 8_000_000 }, keyFrameIntervalS: 2, audioKbps: 128, allowHevc: false })
    expect(by.youtube1080).toMatchObject({ size: { kind: 'fit', maxW: 1920, maxH: 1080 }, fpsCap: null, quality: { kind: 'bitrate', bps30: 12_000_000, bps60: 20_000_000 }, keyFrameIntervalS: 2, audioKbps: 192, allowHevc: true })
    expect(by.youtube4k).toMatchObject({ size: { kind: 'fit', maxW: 3840, maxH: 2160 }, fpsCap: null, quality: { kind: 'bitrate', bps30: 45_000_000, bps60: 68_000_000 }, keyFrameIntervalS: 2, audioKbps: 192, allowHevc: true })
    expect(by.reels).toMatchObject({ size: { kind: 'exact', w: 1080, h: 1920, aspect: 9 / 16 }, fpsCap: 30, quality: { kind: 'bitrate', bps30: 10_000_000, bps60: 10_000_000 }, keyFrameIntervalS: 2, audioKbps: 128, allowHevc: false })
    expect(by.feed11).toMatchObject({ size: { kind: 'exact', w: 1080, h: 1080, aspect: 1 }, fpsCap: 30, quality: { kind: 'bitrate', bps30: 8_000_000, bps60: 8_000_000 }, audioKbps: 128, allowHevc: false })
    expect(by.feed45).toMatchObject({ size: { kind: 'exact', w: 1080, h: 1350, aspect: 4 / 5 }, fpsCap: 30, quality: { kind: 'bitrate', bps30: 8_000_000, bps60: 8_000_000 }, audioKbps: 128, allowHevc: false })
    expect(by.original).toMatchObject({ size: { kind: 'original' }, fpsCap: null, quality: { kind: 'bitrate', bps30: 20_000_000, bps60: 30_000_000 }, keyFrameIntervalS: 2, audioKbps: 192, allowHevc: true })
    expect(by.intermediate).toMatchObject({ size: { kind: 'original' }, fpsCap: null, quality: { kind: 'bitrate', bps30: 60_000_000, bps60: 90_000_000 }, keyFrameIntervalS: 0.5, audioKbps: 192, allowHevc: false })
  })
})

describe('settingsForPreset', () => {
  const dims = (id: ExportPresetId, c: ReturnType<typeof cv>): string => {
    const s = settingsForPreset(id, c)
    return `${s.width}x${s.height}@${s.fps}`
  }
  it('1920×1080 @ 30', () => {
    expect(PRESET_IDS.map((id) => dims(id, C1080))).toEqual(['1280x720@30', '1920x1080@30', '1920x1080@30', '1080x1920@30', '1080x1080@30', '1080x1350@30', '1920x1080@30', '1920x1080@30'])
  })
  it('2560×1440 @ 60: teto de 30 fps nos presets sociais, fps do projeto nos outros', () => {
    expect(PRESET_IDS.map((id) => dims(id, C1440_60))).toEqual(['1280x720@30', '1920x1080@60', '2560x1440@60', '1080x1920@30', '1080x1080@30', '1080x1350@30', '2560x1440@60', '2560x1440@60'])
  })
  it('3840×2160 @ 30', () => {
    expect(PRESET_IDS.map((id) => dims(id, C4K))).toEqual(['1280x720@30', '1920x1080@30', '3840x2160@30', '1080x1920@30', '1080x1080@30', '1080x1350@30', '3840x2160@30', '3840x2160@30'])
  })
  it('1080×1920 (vertical): a caixa gira com a orientação', () => {
    expect(PRESET_IDS.map((id) => dims(id, C916))).toEqual(['720x1280@30', '1080x1920@30', '1080x1920@30', '1080x1920@30', '1080x1080@30', '1080x1350@30', '1080x1920@30', '1080x1920@30'])
  })
  it('1080×1080 e 1280×1024 (proporção fora do padrão): o fit nunca amplia', () => {
    expect(PRESET_IDS.map((id) => dims(id, C11))).toEqual(['720x720@30', '1080x1080@30', '1080x1080@30', '1080x1920@30', '1080x1080@30', '1080x1350@30', '1080x1080@30', '1080x1080@30'])
    expect(PRESET_IDS.map((id) => dims(id, C54))).toEqual(['900x720@30', '1280x1024@30', '1280x1024@30', '1080x1920@30', '1080x1080@30', '1080x1350@30', '1280x1024@30', '1280x1024@30'])
  })
  it('qualidade: taxa a ≤ 30 fps / > 30 fps, alvo de 64 MB no WhatsApp; H.264, áudio e quadro-chave do preset', () => {
    expect(settingsForPreset('youtube1080', C1080)).toEqual({ presetId: 'youtube1080', width: 1920, height: 1080, fps: 30, quality: { kind: 'bitrate', bps: 12_000_000 }, codec: 'h264', audioKbps: 192, keyFrameIntervalS: 2 })
    expect(settingsForPreset('youtube1080', C1440_60).quality).toEqual({ kind: 'bitrate', bps: 20_000_000 })
    expect(settingsForPreset('youtube4k', C1440_60).quality).toEqual({ kind: 'bitrate', bps: 68_000_000 })
    expect(settingsForPreset('original', C1440_60).quality).toEqual({ kind: 'bitrate', bps: 30_000_000 })
    expect(settingsForPreset('intermediate', C1080)).toMatchObject({ quality: { kind: 'bitrate', bps: 60_000_000 }, keyFrameIntervalS: 0.5, audioKbps: 192 })
    expect(settingsForPreset('intermediate', C1440_60).quality).toEqual({ kind: 'bitrate', bps: 90_000_000 })
    // teto de 30 fps: um projeto de 60 fps no Reels usa a taxa de 30
    expect(settingsForPreset('reels', cv(1080, 1920, 60))).toMatchObject({ fps: 30, quality: { kind: 'bitrate', bps: 10_000_000 } })
    expect(settingsForPreset('whatsapp', C1080)).toMatchObject({ quality: { kind: 'target', mb: 64 }, audioKbps: 128, codec: 'h264' })
  })
  it('teto de fps nunca sobe o fps do projeto (25 fps continua 25)', () => {
    expect(settingsForPreset('whatsapp', cv(1920, 1080, 25)).fps).toBe(25)
    expect(settingsForPreset('reels', cv(1080, 1920, 24)).fps).toBe(24)
  })
  it('"custom" parte do Original', () => {
    expect(settingsForPreset('custom', C1080)).toEqual({ ...settingsForPreset('original', C1080), presetId: 'custom' })
  })
})

describe('presetOutputSize (fit)', () => {
  it('pares e nunca maior que o projeto', () => {
    for (const c of [cv(1001, 777), cv(1366, 768), cv(640, 480), cv(1279, 719), cv(5000, 3000)]) {
      for (const id of ['whatsapp', 'youtube1080', 'youtube4k'] as const) {
        const s = presetOutputSize(id, c)
        expect(s.width % 2).toBe(0)
        expect(s.height % 2).toBe(0)
        expect(s.width).toBeLessThanOrEqual(Math.max(2, Math.round(c.width / 2) * 2))
        expect(s.height).toBeLessThanOrEqual(Math.max(2, Math.round(c.height / 2) * 2))
      }
    }
    expect(presetOutputSize('youtube1080', cv(1280, 720))).toEqual({ width: 1280, height: 720 })
    expect(presetOutputSize('whatsapp', cv(1080, 1350))).toEqual({ width: 720, height: 900 })
    expect(presetOutputSize('original', cv(1001, 777))).toEqual({ width: 1002, height: 778 })
  })
})

describe('presetAvailability', () => {
  it('4K só com projeto de 4K', () => {
    expect(presetAvailability('youtube4k', C4K, 10 * S)).toEqual({ ok: true })
    expect(presetAvailability('youtube4k', cv(3840, 1600), 10 * S).ok).toBe(true) // lado maior ≥ 3840
    expect(presetAvailability('youtube4k', cv(2160, 3840), 10 * S).ok).toBe(true)
    expect(presetAvailability('youtube4k', C1080, 10 * S)).toEqual({ ok: false, reason: 'O projeto tem menos de 4K — use YouTube 1080p ou Original' })
    expect(presetAvailability('youtube4k', C1440_60, 10 * S).ok).toBe(false)
  })
  it('proporção exata (±1 %) nos presets do Instagram, nunca tarja/corte silenciosos', () => {
    expect(presetAvailability('reels', C916, 10 * S)).toEqual({ ok: true })
    expect(presetAvailability('reels', cv(720, 1280), 10 * S)).toEqual({ ok: true })
    expect(presetAvailability('reels', C1080, 10 * S)).toEqual({ ok: false, reason: 'O projeto não é 9:16 — use Reenquadrar (9:16) antes' })
    expect(presetAvailability('feed11', C11, 10 * S)).toEqual({ ok: true })
    expect(presetAvailability('feed11', cv(1090, 1080), 10 * S).ok).toBe(true) // 0,9 %
    expect(presetAvailability('feed11', cv(1100, 1080), 10 * S)).toEqual({ ok: false, reason: 'O projeto não é 1:1 — use Reenquadrar (1:1) antes' })
    expect(presetAvailability('feed45', cv(1080, 1350), 10 * S)).toEqual({ ok: true })
    expect(presetAvailability('feed45', C54, 10 * S)).toEqual({ ok: false, reason: 'O projeto não é 4:5 — use Reenquadrar (4:5) antes' })
  })
  it('os demais sempre disponíveis (com duração)', () => {
    for (const id of ['whatsapp', 'youtube1080', 'original', 'intermediate', 'custom'] as const) expect(presetAvailability(id, C54, 10 * S)).toEqual({ ok: true })
  })
  it('WhatsApp: vídeo longo demais para 64 MB', () => {
    expect(presetAvailability('whatsapp', C1080, 2 * 3600 * S)).toEqual({ ok: false, reason: 'Vídeo longo demais para caber em 64 MB — exporte um trecho menor (I–O)' })
  })
})

describe('videoBitrateFor / estimateFor (tamanho alvo)', () => {
  it('64 MB em 10 min: bitrate do alvo com o áudio do preset', () => {
    const s = settingsForPreset('whatsapp', C1080)
    // 64·1 048 576·8·0,96 / 600 − 128 000
    expect(videoBitrateFor(s, 600 * S)).toBe(Math.floor((64 * MiB * 8 * 0.96) / 600 - 128_000))
    expect(videoBitrateFor(s, 600 * S)).toBe(730_993)
  })
  it('limitado ao teto do preset (WhatsApp 8 Mbps) e a 50 Mbps fora dele; piso MIN_TARGET_BPS', () => {
    expect(videoBitrateFor(settingsForPreset('whatsapp', C1080), 10 * S)).toBe(8_000_000)
    const custom: ExportSettings = { ...settingsForPreset('youtube1080', C1080), presetId: 'custom', quality: { kind: 'target', mb: 500 } }
    expect(videoBitrateFor(custom, 10 * S)).toBe(50_000_000)
    expect(videoBitrateFor({ ...custom, quality: { kind: 'target', mb: 1 } }, 3600 * S)).toBe(MIN_TARGET_BPS)
  })
  it('taxa fixa: a taxa', () => {
    expect(videoBitrateFor(settingsForPreset('youtube1080', C1080), 600 * S)).toBe(12_000_000)
  })
  it('estimativa = (vídeo + áudio) × duração; sem áudio só o vídeo', () => {
    const s = settingsForPreset('youtube1080', C1080)
    expect(estimateFor(s, 20 * S)).toBe(estimateBytes(12_000_000, 192_000, 20 * S))
    expect(estimateFor(s, 20 * S, false)).toBe(estimateBytes(12_000_000, 0, 20 * S))
    const t: ExportSettings = { ...s, presetId: 'custom', quality: { kind: 'target', mb: 3 } }
    expect(estimateFor(t, 20 * S)).toBeLessThanOrEqual(3 * MiB * 0.96 + 1)
    expect(videoBitrateFor(t, 20 * S)).toBe(targetBitrate(3, 20 * S, 192))
  })
})

describe('exportRequestFor', () => {
  it('tamanho alvo (qualquer, não só o WhatsApp) leva targetBytes → 2ª passada', () => {
    const t: ExportSettings = { ...settingsForPreset('youtube1080', C1080), presetId: 'custom', quality: { kind: 'target', mb: 3 } }
    expect(exportRequestFor(t, 20 * S)).toEqual({ width: 1920, height: 1080, fps: 30, videoBitrate: targetBitrate(3, 20 * S, 192), audioBitrate: 192_000, keyFrameIntervalS: 2, codec: 'h264', targetBytes: 3 * MiB })
    expect(exportRequestFor(settingsForPreset('whatsapp', C1080), 20 * S).targetBytes).toBe(64 * MiB)
    expect(exportRequestFor(settingsForPreset('intermediate', C1080), 20 * S)).toEqual({ width: 1920, height: 1080, fps: 30, videoBitrate: 60_000_000, audioBitrate: 192_000, keyFrameIntervalS: 0.5, codec: 'h264' })
  })
})

describe('validateExport', () => {
  const ok = (s: ExportSettings, c = C1080, dur = 20 * S, hevc = false): ReturnType<typeof validateExport> => validateExport(s, c, dur, hevc)
  it('presets disponíveis passam sem bloqueio', () => {
    for (const id of PRESET_IDS) {
      const c = id === 'youtube4k' ? C4K : id === 'reels' ? C916 : id === 'feed11' ? C11 : id === 'feed45' ? cv(1080, 1350) : C1080
      expect(ok(settingsForPreset(id, c), c)).toEqual({ blocker: null, warnings: [] })
    }
  })
  it('preset indisponível bloqueia com o motivo', () => {
    expect(ok(settingsForPreset('reels', C1080)).blocker).toBe('O projeto não é 9:16 — use Reenquadrar (9:16) antes')
    expect(ok(settingsForPreset('youtube4k', C1080)).blocker).toBe('O projeto tem menos de 4K — use YouTube 1080p ou Original')
  })
  it('linha do tempo vazia', () => {
    expect(ok(settingsForPreset('youtube1080', C1080), C1080, 0).blocker).toBe('A linha do tempo está vazia.')
  })
  it('HEVC sem suporte bloqueia; com suporte passa; preset só H.264 bloqueia HEVC', () => {
    const s: ExportSettings = { ...settingsForPreset('youtube1080', C1080), codec: 'hevc' }
    expect(ok(s, C1080, 20 * S, false).blocker).toBe('HEVC não suportado neste computador')
    expect(ok(s, C1080, 20 * S, true).blocker).toBeNull()
    expect(ok({ ...s, presetId: 'custom' }, C1080, 20 * S, true).blocker).toBeNull()
    expect(ok({ ...settingsForPreset('whatsapp', C1080), codec: 'hevc' }, C1080, 20 * S, true).blocker).toBe('O preset “WhatsApp (até 64 MB)” usa só H.264 (compatibilidade).')
  })
  it('tamanho alvo pequeno demais (abaixo de MIN_TARGET_BPS) bloqueia; abaixo de 500 kbps avisa', () => {
    const base: ExportSettings = { ...settingsForPreset('youtube1080', C1080), presetId: 'custom' }
    expect(ok({ ...base, quality: { kind: 'target', mb: 1 } }, C1080, 600 * S).blocker).toMatch(/^1 MB é pouco para 10:00/)
    const low = ok(settingsForPreset('whatsapp', C1080), C1080, 20 * 60 * S)
    expect(low.blocker).toBeNull()
    expect(low.warnings).toContain('Qualidade baixa: vídeo longo para 64 MB.')
    expect(ok({ ...base, quality: { kind: 'target', mb: 0 } }).blocker).toBe('Informe o tamanho alvo em MB.')
  })
  it('taxa fora de 0,1–100 Mbps bloqueia', () => {
    const base: ExportSettings = { ...settingsForPreset('youtube1080', C1080), presetId: 'custom' }
    expect(ok({ ...base, quality: { kind: 'bitrate', bps: 50_000 } }).blocker).toBe('A taxa precisa ficar entre 0,1 e 100 Mbps.')
    expect(ok({ ...base, quality: { kind: 'bitrate', bps: 150_000_000 } }).blocker).toBe('A taxa precisa ficar entre 0,1 e 100 Mbps.')
  })
  it('resolução personalizada: par, 16–4096, proporção do projeto, limite do H.264 nível 5.2', () => {
    const base: ExportSettings = { ...settingsForPreset('youtube1080', C1080), presetId: 'custom' }
    expect(ok({ ...base, width: 1281, height: 720 }).blocker).toBe('Largura e altura precisam ser números pares.')
    expect(ok({ ...base, width: 8, height: 4 }, cv(16, 8)).blocker).toBe('A resolução precisa ficar entre 16 e 4096 pixels.')
    expect(ok({ ...base, width: 4352, height: 2448 }).blocker).toBe('A resolução precisa ficar entre 16 e 4096 pixels.')
    expect(ok({ ...base, width: 1280, height: 1024 }).blocker).toBe('A proporção 1280×1024 não é a do projeto (1920×1080) — use Reenquadrar para mudar a proporção.')
    // 4096×4096 cabe no intervalo mas passa do nível 5.2 (36 864 macroblocos por quadro)
    expect(ok({ ...base, width: 4096, height: 4096 }, cv(4096, 4096)).blocker).toBe('Resolução e fps acima do limite do H.264 (nível 5.2): reduza a resolução ou o fps.')
    // 4096×2160 a 60 fps: no limite (2 073 600 MB/s); acima disso não
    expect(ok({ ...base, width: 4096, height: 2160, fps: 60 }, cv(4096, 2160, 60)).blocker).toBeNull()
    expect(ok({ ...base, width: 4096, height: 2304, fps: 60 }, cv(4096, 2304, 60)).blocker).toBe('Resolução e fps acima do limite do H.264 (nível 5.2): reduza a resolução ou o fps.')
  })
  it('fps: escolhas fixas ou o do projeto', () => {
    const base: ExportSettings = { ...settingsForPreset('youtube1080', C1080), presetId: 'custom' }
    expect(ok({ ...base, fps: 60 }).blocker).toBeNull()
    expect(ok({ ...base, fps: 29.97 }, cv(1920, 1080, 29.97)).blocker).toBeNull()
    expect(ok({ ...base, fps: 48 }).blocker).toBe('Taxa de quadros inválida.')
  })
  it('avisos: Reels acima de 90 s; resolução maior que a do projeto', () => {
    expect(ok(settingsForPreset('reels', C916), C916, 91 * S).warnings).toEqual(['Reels acima de 90 s: o Instagram pode recusar ou cortar o vídeo.'])
    expect(ok(settingsForPreset('reels', C916), C916, 90 * S).warnings).toEqual([])
    const up: ExportSettings = { ...settingsForPreset('youtube1080', cv(1280, 720)), presetId: 'custom', width: 1920, height: 1080 }
    expect(ok(up, cv(1280, 720)).warnings).toEqual(['A resolução é maior que a do projeto: o vídeo não ganha detalhe.'])
  })
})

describe('auxiliares do diálogo', () => {
  it('fpsChoices: 24/25/30/50/60 + o do projeto', () => {
    expect(fpsChoices(30)).toEqual([24, 25, 30, 50, 60])
    expect(fpsChoices(29.97)).toEqual([24, 25, 29.97, 30, 50, 60])
  })
  it('sizeForWidth / sizeForHeight mantêm a proporção do projeto (pares)', () => {
    expect(sizeForWidth(1280, C1080)).toEqual({ width: 1280, height: 720 })
    expect(sizeForWidth(1001, C1080)).toEqual({ width: 1002, height: 564 })
    expect(sizeForHeight(720, C916)).toEqual({ width: 406, height: 720 })
  })
  it('outputFileName troca/acrescenta a extensão', () => {
    expect(outputFileName('Aula 1', 'mp4')).toBe('Aula 1.mp4')
    expect(outputFileName('Aula 1.mp4', 'mp4')).toBe('Aula 1.mp4')
    expect(outputFileName('Aula 1.5', 'mp4')).toBe('Aula 1.5.mp4')
    expect(outputFileName('Aula.MOV', 'mp4')).toBe('Aula.mp4')
  })
})

describe('personalizado: limites do preset base só sem ajustes (decisão do controlador)', () => {
  it('sem ajustes: teto do preset (WhatsApp 8 Mbps) e disponibilidade do preset valem', () => {
    const wa = settingsForPreset('whatsapp', C1080)
    expect(wa.customized).toBeFalsy()
    expect(videoBitrateFor({ ...wa, quality: { kind: 'target', mb: 500 } }, 10 * S)).toBe(8_000_000)
    expect(validateExport(wa, C1080, 2 * 3600 * S, false).blocker).toBe('Vídeo longo demais para caber em 64 MB — exporte um trecho menor (I–O)')
    expect(validateExport({ ...wa, codec: 'hevc' }, C1080, 20 * S, true).blocker).toBe('O preset “WhatsApp (até 64 MB)” usa só H.264 (compatibilidade).')
  })
  it('com ajustes: limites genéricos (teto de 50 Mbps, sem o bloqueio de disponibilidade nem o "só H.264" do preset base)', () => {
    const wa: ExportSettings = { ...settingsForPreset('whatsapp', C1080), customized: true }
    expect(videoBitrateFor({ ...wa, quality: { kind: 'target', mb: 500 } }, 10 * S)).toBe(50_000_000)
    const long = validateExport({ ...wa, quality: { kind: 'target', mb: 4000 } }, C1080, 2 * 3600 * S, false)
    expect(long.blocker).toBeNull()
    expect(validateExport({ ...wa, codec: 'hevc' }, C1080, 20 * S, true).blocker).toBeNull()
    // as regras genéricas continuam: HEVC sem suporte, nível, tamanho alvo pequeno demais
    expect(validateExport({ ...wa, codec: 'hevc' }, C1080, 20 * S, false).blocker).toBe('HEVC não suportado neste computador')
    expect(validateExport({ ...wa, quality: { kind: 'target', mb: 64 } }, C1080, 2 * 3600 * S, false).blocker).toMatch(/^64 MB é pouco para 2:00:00/)
    // preset exato com ajustes: a regra genérica de proporção continua valendo
    expect(validateExport({ ...settingsForPreset('reels', C1080), customized: true }, C1080, 20 * S, false).blocker).toBe('A proporção 1080×1920 não é a do projeto (1920×1080) — use Reenquadrar para mudar a proporção.')
  })
  it('basePreset: "custom" é o Original (nunca undefined)', () => {
    expect(basePreset('custom').id).toBe('original')
    expect(basePreset('whatsapp').id).toBe('whatsapp')
  })
})
