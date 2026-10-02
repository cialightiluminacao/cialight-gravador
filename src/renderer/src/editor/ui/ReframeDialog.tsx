import { useEffect, useMemo, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Crop, Crosshair, ShieldCheck, TriangleAlert, X, ZoomIn } from 'lucide-react'
import { toast } from 'sonner'
import { newProjectId } from '@shared/editor/ids'
import type { MediaItem, Project } from '@shared/editor/project'
import { findItem } from '@shared/editor/ops'
import { hasZoomKeys, mainClipAt, REFRAME_ASPECTS, reframeName, type ReframeAspect, type ReframeWarning } from '@shared/editor/reframe'
import { formatTimecodeUs } from '@shared/editor/time'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/primitives'
import { useAppStore } from '@/app/store'
import { ipcErrorMessage } from '@/lib/ipcError'
import type { PlaybackController } from '../engine/PlaybackController'
import { flushAutosave, useEditorStore } from '../state/editorStore'
import { reframePreview, useReframe } from '../state/reframe'
import { seekTo } from './editorActions'
import { itemLabel } from './itemLabel'
import { aspectIdOf } from './aspects'

// "Reenquadrar" (F4): painel não modal (abaixo da barra superior, sobre o inspetor — visualizador e linha do tempo
// continuam utilizáveis) para levar o projeto a 9:16, 1:1 ou 4:5. Modo Preencher: o clipe principal cobre o quadro
// novo e segue os pontos de foco marcados clicando no visualizador (no instante do playhead; lista editável); sem
// pontos, o centro do clipe. Os pontos ficam no espaço do conteúdo de cada clipe; a lista os agrupa por clipe (o do
// playhead primeiro) e diz quantos há em outros clipes. Modo Caber inteiro: barras, sem foco. O visualizador mostra o quadro novo por cima do
// atual (ReframeOverlay). Padrão: cria uma CÓPIA do projeto "<nome> (Vertical)" (pasta própria, abre em seguida); ou
// aplica neste projeto num passo de desfazer. Efeitos de privacidade continuam cobrindo o mesmo conteúdo
// (shared/editor/reframe): o resumo "continuam sobre o mesmo conteúdo" só aparece sem nenhum aviso; com avisos (região
// fora do quadro novo, buraco fechado, âncora removida, anotações) a lista deles aparece aqui e ao aplicar. Narrações
// pendentes (não recuperadas) ficam só no original: aviso ao criar a cópia.

/** Topo do painel: logo abaixo da barra superior do editor. */
function panelTop(): number {
  const b = document.querySelector('[data-editor-topbar]')?.getBoundingClientRect().bottom
  return Math.round((b ?? 88) + 8)
}

const pct = (v: number): string => `${Math.round(v * 100)}%`

/** Avisos agrupados por tipo: "mensagem (n efeitos)". */
function warningLines(ws: ReframeWarning[]): string[] {
  const by = new Map<string, number>()
  for (const w of ws) by.set(w.message, (by.get(w.message) ?? 0) + 1)
  return [...by].map(([m, n]) => (n > 1 ? `${m} (${n} itens)` : m))
}

/** Proporção padrão ao abrir: vertical, ou quadrado se o projeto já é vertical. */
export function defaultReframeAspect(p: Project): ReframeAspect {
  return aspectIdOf(p) === '9:16' ? '1:1' : '9:16'
}

/** Cria a cópia reenquadrada (salva o atual antes) e a abre; ou aplica aqui como um passo de desfazer. */
async function runReframe(): Promise<void> {
  const st = useEditorStore.getState()
  const p = st.project
  if (!p) return
  const rf = useReframe.getState()
  if (st.txBase) st.commitTx()
  const r = reframePreview(useEditorStore.getState().project!, rf)
  const lines = warningLines(r.warnings)
  const label = REFRAME_ASPECTS.find((a) => a.id === rf.aspect)!.label
  if (rf.dest === 'apply') {
    if (!useEditorStore.getState().apply(() => r.project)) return
    rf.close()
    if (lines.length) toast.warning(`Projeto reenquadrado para ${label}`, { description: lines.join(' · '), duration: 12_000 })
    else toast.success(`Projeto reenquadrado para ${label}`, { description: 'Ctrl+Z desfaz.' })
    return
  }
  try {
    await flushAutosave()
    const now = new Date()
    // a cópia não é "o projeto da gravação": "Editar" na gravação continua abrindo o original
    const { originSessionId: _, ...rest } = r.project
    const copy: Project = { ...rest, id: newProjectId(now), name: reframeName(p.name, rf.aspect), createdAt: now.toISOString(), updatedAt: now.toISOString() }
    const { skippedPending } = await window.api.project.duplicate(p.id, copy)
    rf.close()
    useAppStore.getState().openEditor(copy.id)
    const n = skippedPending.length
    const all = [...lines, ...(n ? [`${n === 1 ? '1 narração pendente (não recuperada) ficou' : `${n} narrações pendentes (não recuperadas) ficaram`} só no original — abra o original para recuperá-las`] : [])]
    if (all.length) toast.warning(`Cópia criada: ${copy.name}`, { description: all.join(' · '), duration: 12_000 })
    else toast.success(`Cópia criada: ${copy.name}`, { description: `O original (${p.name}) ficou como estava.` })
  } catch (e) {
    toast.error(`Não foi possível criar a cópia: ${ipcErrorMessage(e)}`)
  }
}

export function ReframeDialog({ playback }: { playback: PlaybackController | null }): React.JSX.Element | null {
  const open = useReframe((s) => s.open)
  const aspect = useReframe((s) => s.aspect)
  const mode = useReframe((s) => s.mode)
  const dest = useReframe((s) => s.dest)
  const points = useReframe((s) => s.points)
  const project = useEditorStore((s) => s.project)
  const playheadUs = useEditorStore((s) => s.playheadUs)
  const [top, setTop] = useState(88)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setTop(panelTop())
    const onResize = (): void => setTop(panelTop())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  const result = useMemo(() => (open && project ? reframePreview(project, { aspect, mode, points }) : null), [open, project, aspect, mode, points])
  if (!project || !result) return null
  const rf = useReframe.getState()
  const target = mainClipAt(project, playheadUs)
  // pontos por clipe (o do playhead primeiro); clipes apagados somem da lista
  const groups = Object.entries(points)
    .map(([id, list]) => ({ m: findItem(project, id)?.item, list }))
    .filter((g): g is { m: MediaItem; list: typeof g.list } => g.m?.type === 'media' && g.list.length > 0)
    .sort((a, b) => (a.m.id === target?.id ? -1 : b.m.id === target?.id ? 1 : a.m.startUs - b.m.startUs))
  const others = groups.filter((g) => g.m.id !== target?.id).reduce((n, g) => n + g.list.length, 0)
  const hasTarget = groups.some((g) => g.m.id === target?.id)
  const current = aspectIdOf(project)
  const effects = project.tracks.reduce((n, t) => n + t.items.filter((i) => i.type === 'effect').length, 0)
  const lines = warningLines(result.warnings)
  const fps = project.canvas.fps
  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      await runReframe()
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => (o ? undefined : rf.close())} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-reframe-dialog=""
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          style={{ top, maxHeight: `calc(100vh - ${top + 12}px)` }}
          className="fixed right-3 z-50 w-[min(360px,92vw)] overflow-y-auto rounded-2xl border border-border-strong bg-surface p-5 shadow-2xl animate-in fade-in-0 zoom-in-95 focus:outline-none"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogPrimitive.Title className="flex items-center gap-2 text-base font-semibold">
                <Crop className="h-4 w-4 text-accent" /> Reenquadrar
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-[12px] leading-relaxed text-muted">
                Leva o vídeo para outra proporção mantendo o ponto de interesse no quadro. O retângulo no visualizador mostra o novo quadro.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="rounded-lg p-1 text-muted hover:bg-white/5 hover:text-fg" aria-label="Fechar">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <span className="text-[12px] font-medium text-fg-2">Proporção</span>
              <Segmented
                className="flex w-full [&>*]:flex-1"
                size="sm"
                value={aspect}
                onValueChange={(a) => rf.set({ aspect: a })}
                options={REFRAME_ASPECTS.map((a) => ({ value: a.id, label: a.id, title: a.id === current ? 'O projeto já está nesta proporção' : a.label, disabled: a.id === current }))}
              />
              <p className="text-[11px] text-muted">
                {REFRAME_ASPECTS.find((a) => a.id === aspect)!.label} · {result.project.canvas.width}×{result.project.canvas.height}
              </p>
            </div>

            <div className="space-y-1.5">
              <span className="text-[12px] font-medium text-fg-2">Enquadramento</span>
              <Segmented
                className="flex w-full [&>*]:flex-1"
                size="sm"
                value={mode}
                onValueChange={(m) => rf.set({ mode: m })}
                options={[
                  { value: 'cover', label: 'Preencher', title: 'O vídeo cobre o quadro inteiro e segue os pontos de foco (sem bordas pretas)' },
                  { value: 'contain', label: 'Caber inteiro', title: 'O vídeo inteiro aparece, com barras' }
                ]}
              />
            </div>

            {mode === 'cover' ? (
              <div className="space-y-1.5" data-reframe-points="">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-fg-2">
                    <Crosshair className="h-3.5 w-3.5 text-accent" /> Pontos de foco
                  </span>
                  {hasTarget && target ? (
                    <button type="button" className="text-[11px] text-muted hover:text-fg" onClick={() => rf.clearPoints(target.id)}>
                      Limpar deste clipe
                    </button>
                  ) : null}
                </div>
                <p className="text-[11px] leading-snug text-muted">
                  {target ? (
                    <>
                      Clique no visualizador para marcar o que deve ficar no centro de <span className="text-fg-2">{itemLabel(project, target)}</span> neste instante. Mude o playhead para marcar outros instantes; a câmera anda suave entre eles.
                    </>
                  ) : (
                    'Não há clipe principal no playhead: mova o playhead para um trecho com vídeo.'
                  )}
                </p>
                {target && hasZoomKeys(target) ? (
                  <p data-reframe-zoom-note="" className="flex gap-2 rounded-xl border border-border bg-bg-2 px-3 py-2 text-[11px] leading-snug text-fg-2">
                    <ZoomIn className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                    <span>Este clipe tem zoom: durante o zoom, o enquadramento segue o alvo dele (o detalhe ampliado continua no quadro); os pontos de foco valem fora do zoom.</span>
                  </p>
                ) : null}
                {groups.length ? (
                  <div className="space-y-2" aria-label="Pontos de foco por clipe">
                    {groups.map((g) => (
                      <div key={g.m.id} data-focus-group={g.m.id} className="rounded-xl border border-border bg-bg-2 px-2 py-1.5">
                        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-fg-2">
                          <span className="truncate">{itemLabel(project, g.m)}</span>
                          <span className="shrink-0 text-muted">· {g.list.length === 1 ? '1 ponto' : `${g.list.length} pontos`}</span>
                          {g.m.id === target?.id ? <span className="ml-auto shrink-0 text-[10px] text-accent">no playhead</span> : null}
                        </div>
                        <ul className="space-y-1">
                          {g.list.map((pt) => {
                            const tUs = g.m.startUs + pt.localUs
                            return (
                              <li key={pt.localUs} data-focus-point={tUs} className="flex items-center gap-2 text-[11px]">
                                <button type="button" className="font-mono tabular-nums text-fg hover:text-accent" title="Ir para este instante" onClick={() => seekTo(playback, tUs)}>
                                  {formatTimecodeUs(tUs, fps)}
                                </button>
                                <span className="flex-1 text-muted" title="Posição na imagem do clipe">
                                  {pct(pt.x)} × {pct(pt.y)}
                                </span>
                                <button type="button" aria-label={`Remover o ponto em ${formatTimecodeUs(tUs, fps)}`} className="rounded p-0.5 text-muted hover:bg-white/5 hover:text-fg" onClick={() => rf.removePoint(g.m.id, pt.localUs)}>
                                  <X className="h-3 w-3" />
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : null}
                {target && !hasTarget ? (
                  <p data-focus-empty="" className="rounded-xl border border-dashed border-border px-3 py-2 text-[11px] text-muted">
                    Sem pontos neste clipe: o centro dele (ou o movimento de zoom que ele já tem).
                    {others ? ` ${others === 1 ? 'Há 1 ponto' : `Há ${others} pontos`} em outros clipes.` : ''}
                  </p>
                ) : null}
              </div>
            ) : null}

            {effects > 0 && !lines.length ? (
              <div className="flex gap-2 rounded-xl border border-border bg-bg-2 px-3 py-2 text-[11px] leading-snug text-fg-2" data-reframe-privacy="">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
                <span>
                  Os efeitos de privacidade continuam sobre o mesmo conteúdo
                  {result.anchored.length ? `; ${result.anchored.length === 1 ? '1 será ancorado' : `${result.anchored.length} serão ancorados`} ao clipe` : ''}
                  {result.baked.length ? `; ${result.baked.length === 1 ? '1 terá a região ajustada' : `${result.baked.length} terão a região ajustada`} ao novo quadro` : ''}.
                </span>
              </div>
            ) : null}
            {lines.length ? (
              <div className="space-y-1" data-reframe-warnings="">
                {lines.map((l) => (
                  <div key={l} className="flex gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] leading-snug text-warn">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{l}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="space-y-1.5">
              <span className="text-[12px] font-medium text-fg-2">Destino</span>
              <Segmented
                className="flex w-full [&>*]:flex-1"
                size="sm"
                value={dest}
                onValueChange={(d) => rf.set({ dest: d })}
                options={[
                  { value: 'copy', label: 'Criar cópia', title: 'Um projeto novo; o original fica como está' },
                  { value: 'apply', label: 'Este projeto', title: 'Aplica aqui (Ctrl+Z desfaz)' }
                ]}
              />
              <p className="text-[11px] text-muted">{dest === 'copy' ? `Cria “${reframeName(project.name, aspect)}” e abre a cópia.` : 'Muda este projeto; Ctrl+Z desfaz.'}</p>
            </div>
          </div>

          {/* rodapé fixo: os botões ficam visíveis mesmo com o painel rolando (telas baixas) */}
          <div className="sticky -bottom-5 -mx-5 -mb-5 mt-5 flex justify-end gap-2 border-t border-border bg-surface px-5 py-3">
            <Button variant="ghost" size="sm" onClick={() => rf.close()}>
              Cancelar
            </Button>
            <Button variant="primary" size="sm" data-reframe-apply="" disabled={busy || aspect === current} onClick={() => void apply()}>
              {dest === 'copy' ? 'Criar cópia' : 'Reenquadrar'}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
