import { useCallback, useEffect, useState } from 'react'
import { BookmarkPlus, Clapperboard, Flag, Layers, ListEnd, ListStart, LoaderCircle, MapPin, Pencil, Stamp, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { BRAND_TEMPLATE_KINDS, type ApplyMode, type BrandTemplate, type BrandTemplateKind } from '@shared/editor/brand'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, Segmented, Tip } from '@/components/ui/primitives'
import { ipcErrorMessage } from '@/lib/ipcError'
import { useEditorStore } from '../state/editorStore'
import { applyBrandTemplate, saveSelectionAsTemplate } from './brandActions'
import { BRAND_KIND_LABEL, BRAND_MODE_LABEL, brandModes, formatBrandDuration } from './brandInfo'

// Aba "Modelos" da biblioteca: modelos de marca (spec §10) — logo/marca d'água, abertura/encerramento, terço inferior.
// "Salvar seleção como modelo…" (nome + tipo) guarda textos, formas e mídias importadas selecionados; cada modelo
// pode ser aplicado no playhead, como abertura (o projeto anda para a frente), como encerramento ou como marca d'água.
// Os modelos valem para todos os projetos (userData/brand-templates.json, fora do settings.json).

const KIND_ICON: Record<BrandTemplateKind, React.ReactNode> = {
  overlay: <Layers className="h-4 w-4" />,
  intro: <Clapperboard className="h-4 w-4" />,
  outro: <Flag className="h-4 w-4" />,
  watermark: <Stamp className="h-4 w-4" />
}
const MODE_ICON: Record<ApplyMode, React.ReactNode> = {
  playhead: <MapPin className="h-3.5 w-3.5" />,
  intro: <ListStart className="h-3.5 w-3.5" />,
  outro: <ListEnd className="h-3.5 w-3.5" />,
  watermark: <Stamp className="h-3.5 w-3.5" />
}
const INPUT = 'h-10 w-full rounded-xl border border-border-strong bg-bg-2 px-3 text-[13px] text-fg outline-none focus:border-accent/60'

export function BrandLibrary(): React.JSX.Element {
  const [list, setList] = useState<BrandTemplate[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [saving, setSaving] = useState<{ name: string; kind: BrandTemplateKind } | null>(null)
  const [renaming, setRenaming] = useState<{ t: BrandTemplate; name: string } | null>(null)
  const [deleting, setDeleting] = useState<BrandTemplate | null>(null)
  const hasSelection = useEditorStore((s) => s.selection.length > 0)

  const load = useCallback(async () => {
    try {
      const r = await window.api.brand.list()
      setList(r.templates)
      if (r.warning) toast.warning('Modelos de marca', { description: r.warning, duration: 12_000 })
    } catch (e) {
      setList([])
      toast.error(`Não foi possível ler os modelos: ${ipcErrorMessage(e)}`)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const save = async (): Promise<void> => {
    if (!saving) return
    setBusy('save')
    const t = await saveSelectionAsTemplate(saving.name, saving.kind)
    setBusy(null)
    if (t) {
      setSaving(null)
      await load()
    }
  }
  const apply = async (t: BrandTemplate, mode: ApplyMode): Promise<void> => {
    setBusy(`${t.id}:${mode}`)
    try {
      await applyBrandTemplate(t, mode)
    } finally {
      setBusy(null)
    }
  }
  const rename = async (): Promise<void> => {
    if (!renaming) return
    try {
      const t = await window.api.brand.rename(renaming.t.id, renaming.name)
      toast.success(`Modelo renomeado para “${t.name}”`)
      setRenaming(null)
      await load()
    } catch (e) {
      toast.error(`Não foi possível renomear: ${ipcErrorMessage(e)}`)
    }
  }
  const remove = async (): Promise<void> => {
    if (!deleting) return
    try {
      await window.api.brand.remove(deleting.id)
      toast.success(`Modelo “${deleting.name}” excluído`, { description: 'Projetos que já o usaram continuam iguais (têm cópia dos arquivos).' })
      setDeleting(null)
      await load()
    } catch (e) {
      toast.error(`Não foi possível excluir o modelo: ${ipcErrorMessage(e)}`)
    }
  }

  return (
    <div className="flex flex-col gap-2 p-2" data-brand-panel="">
      <Tip content={hasSelection ? 'Guarda os textos, formas e mídias importadas selecionados para usar em qualquer projeto' : 'Selecione na linha do tempo o que vai para o modelo'}>
        <span className="block">
          <Button variant="secondary" size="sm" className="w-full" disabled={!hasSelection} onClick={() => setSaving({ name: '', kind: 'overlay' })} data-brand-save="">
            <BookmarkPlus className="h-3.5 w-3.5" /> Salvar seleção como modelo…
          </Button>
        </span>
      </Tip>

      {list === null ? (
        <div className="flex h-24 items-center justify-center text-muted">
          <LoaderCircle className="h-4 w-4 animate-spin" />
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-muted">
          <Stamp className="h-6 w-6" />
          <span className="text-[11px] leading-relaxed">Nenhum modelo ainda. Monte um título, um logo ou uma vinheta, selecione os itens e clique em “Salvar seleção como modelo…”.</span>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {list.map((t) => (
            <li key={t.id} className="flex flex-col gap-1 rounded-lg border border-border p-1.5 hover:bg-white/4" data-brand-template={t.id} aria-label={`${t.name}, ${BRAND_KIND_LABEL[t.kind]}, ${formatBrandDuration(t.durationUs)}`}>
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-fg-2" aria-hidden>
                  {KIND_ICON[t.kind]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] font-semibold text-fg-2" data-brand-name="">
                    {t.name}
                  </div>
                  <div className="truncate text-[10px] text-muted">
                    {BRAND_KIND_LABEL[t.kind]} · {formatBrandDuration(t.durationUs)}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-0.5">
                {brandModes(t.kind).map((m) => (
                  <Tip key={m} content={BRAND_MODE_LABEL[m]}>
                    <button
                      type="button"
                      aria-label={`${BRAND_MODE_LABEL[m]}: ${t.name}`}
                      data-brand-action={m}
                      disabled={busy !== null}
                      onClick={() => void apply(t, m)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-40"
                    >
                      {busy === `${t.id}:${m}` ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : MODE_ICON[m]}
                    </button>
                  </Tip>
                ))}
                <span className="flex-1" />
                <Tip content="Renomear">
                  <button type="button" aria-label={`Renomear o modelo ${t.name}`} data-brand-action="rename" onClick={() => setRenaming({ t, name: t.name })} className="flex h-6 w-6 items-center justify-center rounded-md text-fg-2 hover:bg-white/8 hover:text-fg">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </Tip>
                <Tip content="Excluir">
                  <button type="button" aria-label={`Excluir o modelo ${t.name}`} data-brand-action="delete" onClick={() => setDeleting(t)} className="flex h-6 w-6 items-center justify-center rounded-md text-fg-2 hover:bg-danger/15 hover:text-danger">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </Tip>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="px-1 text-[10.5px] leading-relaxed text-muted">Os modelos valem para todos os projetos. Ao aplicar, os arquivos são copiados para o projeto: excluir o modelo não muda nada nele. Efeitos de privacidade e itens de gravação não entram em modelos.</p>

      <Dialog open={!!saving} onOpenChange={(o) => !o && setSaving(null)}>
        <DialogContent title="Salvar seleção como modelo" description="Textos, formas e mídias importadas selecionados, com as posições e os tempos entre eles." className="w-[min(460px,92vw)]">
          {saving ? (
            <form
              className="flex flex-col gap-4"
              data-brand-save-dialog=""
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-fg-2">Nome</span>
                <input autoFocus className={INPUT} value={saving.name} maxLength={80} placeholder="Ex.: Vinheta da empresa" onChange={(e) => setSaving({ ...saving, name: e.target.value })} data-brand-name-input="" spellCheck={false} />
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-fg-2" id="brand-kind-label">
                  Tipo
                </span>
                <Segmented size="sm" value={saving.kind} onValueChange={(kind) => setSaving({ ...saving, kind })} options={BRAND_TEMPLATE_KINDS.map((k) => ({ value: k, label: BRAND_KIND_LABEL[k] }))} />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setSaving(null)}>
                  Cancelar
                </Button>
                <Button variant="primary" type="submit" disabled={!saving.name.trim() || busy === 'save'} data-brand-save-confirm="">
                  {busy === 'save' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} Salvar modelo
                </Button>
              </div>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent title="Renomear modelo" className="w-[min(420px,92vw)]">
          {renaming ? (
            <form
              className="flex flex-col gap-4"
              data-brand-rename-dialog=""
              onSubmit={(e) => {
                e.preventDefault()
                void rename()
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-fg-2">Nome</span>
                <input autoFocus className={INPUT} value={renaming.name} maxLength={80} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} data-brand-rename-input="" spellCheck={false} />
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setRenaming(null)}>
                  Cancelar
                </Button>
                <Button variant="primary" type="submit" disabled={!renaming.name.trim()} data-brand-rename-confirm="">
                  Renomear
                </Button>
              </div>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent title="Excluir modelo" description={deleting ? `Excluir o modelo “${deleting.name}”? Os projetos que já o usaram não mudam.` : undefined} className="w-[min(420px,92vw)]">
          <div className="flex justify-end gap-2" data-brand-delete-dialog="">
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => void remove()} data-brand-delete-confirm="">
              Excluir
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
