import { useEffect, useRef, useState } from 'react'
import { Check, MousePointerClick, Palette } from 'lucide-react'
import { Badge, Kbd, Section, Slider, Toggle } from '@/components/ui/primitives'
import { SettingRow, SettingRows } from '@/components/ui/SettingRow'
import { cn } from '@/lib/cn'
import { useSettingsPatch } from './useSettingsPatch'

// Aba Anotações: cor, espessura (com prévia), sumir automaticamente, realce de cliques, teclas do modo desenho.

const PALETTE: { value: string; label: string }[] = [
  { value: '#ff3b30', label: 'Vermelho' },
  { value: '#ff9f0a', label: 'Laranja' },
  { value: '#ffd60a', label: 'Amarelo' },
  { value: '#30d158', label: 'Verde' },
  { value: '#0a84ff', label: 'Azul' },
  { value: '#ffffff', label: 'Branco' }
]

const WIDTH_MIN = 2
const WIDTH_MAX = 16
const FADE_MIN = 2
const FADE_MAX = 15
const FADE_DEFAULT = 5

const DRAW_KEYS: { keys: string[]; what: string }[] = [
  { keys: ['Shift'], what: 'segurando: linha reta' },
  { keys: ['Ctrl+Shift'], what: 'segurando: seta' },
  { keys: ['R', 'G', 'B', 'Y'], what: 'vermelho · verde · azul · amarelo' },
  { keys: ['[', ']'], what: 'espessura − / +' },
  { keys: ['Ctrl+Z'], what: 'desfaz o último traço' },
  { keys: ['E'], what: 'apaga tudo' },
  { keys: ['Esc'], what: 'sai do modo desenho' }
]

/** Prévia do traço: uma curva com a cor/espessura atuais, desenhada num canvas pequeno. */
function StrokePreview({ color, width }: { color: string; width: number }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = 4
    ctx.beginPath()
    ctx.moveTo(14, h * 0.62)
    ctx.bezierCurveTo(w * 0.28, h * -0.1, w * 0.42, h * 1.15, w * 0.62, h * 0.5)
    ctx.bezierCurveTo(w * 0.76, h * 0.05, w * 0.88, h * 0.35, w - 14, h * 0.4)
    ctx.stroke()
  }, [color, width])
  return <canvas ref={ref} className="h-16 w-full rounded-xl border border-border-strong bg-[linear-gradient(135deg,#1b202d,#0f121a)]" aria-label={`Prévia do traço: ${width} px`} />
}

export function AnnotationsTab(): React.JSX.Element {
  const { settings, patch } = useSettingsPatch()
  const ann = settings.annotations
  const setAnn = (p: Partial<typeof ann>): void => void patch({ annotations: { ...ann, ...p } })
  const inPalette = PALETTE.some((c) => c.value.toLowerCase() === ann.color.toLowerCase())
  const fadeOn = ann.autoFadeSec !== null
  // Durante o arrasto dos sliders o valor fica local; só persiste ao soltar (onValueCommit),
  // para não gravar em disco a cada tick nem fazer o thumb tremer com o broadcast.
  const [widthDraft, setWidthDraft] = useState<number | null>(null)
  const [fadeDraft, setFadeDraft] = useState<number | null>(null)
  const width = widthDraft ?? ann.width
  const fadeSec = fadeDraft ?? ann.autoFadeSec ?? FADE_DEFAULT

  return (
    <div className="flex flex-col gap-4">
      <Section title="Traço" className="rise-in">
        <div className="grid grid-cols-[1fr_220px] gap-6">
          <SettingRows>
            <SettingRow label="Cor" description="Cor inicial ao entrar no modo desenho. Durante a gravação, R, G, B e Y trocam na hora.">
              <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Cor do traço">
                {PALETTE.map((c) => {
                  const active = c.value.toLowerCase() === ann.color.toLowerCase()
                  return (
                    <button
                      key={c.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      title={c.label}
                      aria-label={c.label}
                      onClick={() => setAnn({ color: c.value })}
                      className={cn('flex h-7 w-7 items-center justify-center rounded-full border-2 transition-transform hover:scale-110', active ? 'border-fg' : 'border-transparent')}
                      style={{ background: c.value }}
                    >
                      {active ? <Check className={cn('h-3.5 w-3.5', c.value === '#ffffff' || c.value === '#ffd60a' ? 'text-black' : 'text-white')} strokeWidth={3} /> : null}
                    </button>
                  )
                })}
                <label
                  className={cn(
                    'relative ml-1 flex h-7 w-7 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2 bg-[conic-gradient(#ff3b30,#ffd60a,#30d158,#0a84ff,#bf5af2,#ff3b30)]',
                    !inPalette ? 'border-fg' : 'border-transparent'
                  )}
                  title="Outra cor…"
                >
                  <Palette className="h-3.5 w-3.5 text-white drop-shadow" />
                  <input type="color" value={ann.color} onChange={(e) => setAnn({ color: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Escolher outra cor" />
                </label>
              </div>
            </SettingRow>
            <SettingRow label="Espessura" description="Ajuste também com [ e ] enquanto desenha.">
              <div className="flex w-60 items-center gap-3">
                <span className="font-mono w-6 text-right text-[11px] text-muted">{WIDTH_MIN}</span>
                <Slider
                  min={WIDTH_MIN}
                  max={WIDTH_MAX}
                  step={1}
                  value={[width]}
                  onValueChange={([v]) => setWidthDraft(v)}
                  onValueCommit={([v]) => {
                    setWidthDraft(null)
                    if (v !== ann.width) setAnn({ width: v })
                  }}
                  aria-label="Espessura do traço"
                />
                <span className="font-mono w-6 text-[11px] text-muted">{WIDTH_MAX}</span>
              </div>
            </SettingRow>
          </SettingRows>
          <div className="flex flex-col gap-2 pt-1">
            <StrokePreview color={ann.color} width={width} />
            <p className="text-center text-[11px] text-muted">
              Prévia · <span className="font-mono tnum">{width} px</span>
            </p>
          </div>
        </div>
      </Section>

      <Section title="Comportamento" className="rise-in rise-in-1">
        <SettingRows>
          <SettingRow
            label="Sumir automaticamente"
            description={fadeOn ? `Cada traço desaparece sozinho ${fadeSec} s depois de desenhado.` : 'Os traços ficam na tela até você apagar (E) ou sair do modo desenho.'}
            htmlFor="autoFade"
          >
            <div className="flex items-center gap-4">
              {fadeOn ? (
                <div className="flex w-56 items-center gap-3">
                  <Slider
                    min={FADE_MIN}
                    max={FADE_MAX}
                    step={1}
                    value={[fadeSec]}
                    onValueChange={([v]) => setFadeDraft(v)}
                    onValueCommit={([v]) => {
                      setFadeDraft(null)
                      if (v !== ann.autoFadeSec) setAnn({ autoFadeSec: v })
                    }}
                    aria-label="Segundos até sumir"
                  />
                  <span className="font-mono tnum w-8 text-right text-xs text-fg-2">{fadeSec} s</span>
                </div>
              ) : null}
              <Toggle id="autoFade" checked={fadeOn} onCheckedChange={(v) => setAnn({ autoFadeSec: v ? FADE_DEFAULT : null })} />
            </div>
          </SettingRow>
          <SettingRow
            label={
              <span className="inline-flex items-center gap-2">
                Realce de cliques <Badge tone="info">em breve</Badge>
              </span>
            }
            description="Mostra um círculo em cada clique do mouse no vídeo. A preferência já fica salva e passa a valer assim que o recurso for liberado."
            htmlFor="clickHighlight"
          >
            <div className="flex items-center gap-2">
              <MousePointerClick className="h-4 w-4 text-muted" />
              <Toggle id="clickHighlight" checked={settings.clickHighlight} onCheckedChange={(v) => void patch({ clickHighlight: v })} />
            </div>
          </SettingRow>
        </SettingRows>
      </Section>

      <Section title="Teclas no modo desenho" className="rise-in rise-in-2">
        <ul className="grid grid-cols-2 gap-x-8 gap-y-2">
          {DRAW_KEYS.map((k) => (
            <li key={k.what} className="flex items-center gap-3 text-xs text-fg-2">
              <span className="flex w-[124px] shrink-0 items-center gap-1">
                {k.keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </span>
              <span>{k.what}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-muted">Entre no modo desenho pelo atalho «Anotar» ou pela barra flutuante. Os traços vão para o vídeo exportado (dá para desligar na Revisão).</p>
      </Section>
    </div>
  )
}
