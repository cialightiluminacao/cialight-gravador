import { ArrowRight, FileSearch } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent } from '@/components/ui/primitives'
import { relinkApplyList, shortPath } from './relinkPlan'
import { applyRelinks, declineRelinks, toggleRelinkRow, useRelinkPrompt } from './relinkFlow'

// Diálogo do relink automático (relinkFlow.ts): mídias ausentes achadas em outro local (mesmo nome e tamanho), com o
// caminho antigo → novo e uma caixa por mídia (todas marcadas). Nada muda sem "Reapontar selecionadas".

export function RelinkDialog(): React.JSX.Element {
  const { projectId, rows, applying } = useRelinkPrompt()
  const selected = relinkApplyList(rows).length
  const n = rows.length
  return (
    <Dialog open={!!projectId} onOpenChange={(o) => !o && declineRelinks()}>
      <DialogContent
        title="Mídia encontrada em outro local"
        description={
          n === 1
            ? 'Uma mídia ausente foi encontrada com o mesmo nome e tamanho. Confira o caminho antes de reapontar.'
            : `${n} mídias ausentes foram encontradas com o mesmo nome e tamanho. Confira os caminhos antes de reapontar.`
        }
        className="w-[min(640px,92vw)]"
        footer={
          <>
            <Button variant="secondary" onClick={declineRelinks} disabled={applying}>
              Agora não
            </Button>
            <Button variant="primary" onClick={() => void applyRelinks()} disabled={applying || selected === 0} autoFocus>
              {applying ? 'Reapontando…' : 'Reapontar selecionadas'}
            </Button>
          </>
        }
      >
        <ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto" data-relink-dialog="">
          {rows.map((r) => {
            const id = `relink-${r.assetId}`
            return (
              <li key={r.assetId} className="rounded-lg border border-border bg-bg-2 px-3 py-2">
                <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
                  <input
                    id={id}
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
                    checked={r.checked}
                    disabled={applying}
                    onChange={(e) => toggleRelinkRow(r.assetId, e.currentTarget.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
                      <FileSearch className="h-3.5 w-3.5 shrink-0 text-accent-2" aria-hidden />
                      <span className="truncate">{r.name}</span>
                    </span>
                    <span className="mt-1 block truncate font-mono text-[11px] text-muted" title={r.oldPath}>
                      {shortPath(r.oldPath)}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-fg-2" title={r.newPath}>
                      <ArrowRight className="h-3 w-3 shrink-0 text-ok" aria-label="novo local" />
                      <span className="truncate">{shortPath(r.newPath)}</span>
                    </span>
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
