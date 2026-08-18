import { useState } from 'react'
import { CircleCheckBig, ClipboardCopy, Copy, FileVolume2, Film, FolderOpen, RotateCcw, Trash2, TriangleAlert, Video } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, Tip } from '@/components/ui/primitives'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/cn'

// Estado "concluído" da exportação: arquivos gerados e ações (abrir pasta, copiar arquivo,
// copiar caminho, reexportar, nova gravação, excluir gravação bruta).

interface Props {
  outputs: string[]
  /** Tamanho em bytes por caminho, quando conhecido. */
  sizes?: Record<string, number>
  /** Aviso vindo do job (ex.: qualidade baixa para o alvo). */
  warning: string | null
  onReexport: () => void
  onNewRecording: () => void
  onDeleteRaw: () => Promise<void>
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p
const extOf = (p: string): string => (baseName(p).split('.').pop() ?? '').toLowerCase()
/** Pasta real dos arquivos gerados (dirname do primeiro output). */
const dirName = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))) || p

export function ExportDone({ outputs, sizes, warning, onReexport, onNewRecording, onDeleteRaw }: Props): React.JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const first = outputs[0]
  const outputDir = first ? dirName(first) : ''
  const api = window.api

  const copyFile = async (p: string): Promise<void> => {
    await api.app.copyFile(p)
    toast.success('Arquivo copiado — cole no WhatsApp, e-mail ou Explorer.')
  }
  const copyPath = async (p: string): Promise<void> => {
    await api.app.copyText(p)
    toast.success('Caminho copiado.')
  }

  return (
    <div className="flex h-full flex-col rise-in">
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="card p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ok/15 text-ok">
              <CircleCheckBig className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Concluído</div>
              <div className="mt-0.5 text-base font-semibold">{outputs.length === 1 ? 'Vídeo exportado' : `${outputs.length} arquivos exportados`}</div>
            </div>
          </div>
          {warning ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{warning}</span>
            </div>
          ) : null}
          <ul className="mt-4 divide-y divide-border rounded-xl border border-border bg-bg-2/60">
            {outputs.map((p) => {
              const ext = extOf(p)
              const size = sizes?.[p]
              return (
                <li key={p} className="flex items-center gap-2.5 px-3 py-2">
                  <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-2', ext === 'wav' ? 'text-info' : 'text-fg-2')}>
                    {ext === 'wav' ? <FileVolume2 className="h-4 w-4" /> : <Film className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium" title={p}>
                      {baseName(p)}
                    </span>
                    <span className="block text-[11px] text-muted">
                      {ext.toUpperCase()}
                      {size !== undefined ? ` · ${formatBytes(size)}` : ''}
                    </span>
                  </span>
                  <Tip content="Copiar arquivo">
                    <button type="button" className="rounded-md p-1.5 text-muted hover:bg-white/5 hover:text-fg" onClick={() => void copyFile(p)} aria-label="Copiar arquivo">
                      <Copy className="h-4 w-4" />
                    </button>
                  </Tip>
                  <Tip content="Copiar caminho">
                    <button type="button" className="rounded-md p-1.5 text-muted hover:bg-white/5 hover:text-fg" onClick={() => void copyPath(p)} aria-label="Copiar caminho">
                      <ClipboardCopy className="h-4 w-4" />
                    </button>
                  </Tip>
                </li>
              )
            })}
          </ul>
          {outputDir ? (
            <button type="button" className="mt-2 flex w-full items-center gap-1.5 truncate rounded-md px-1 py-1 text-left text-[11px] text-muted hover:text-fg" title={outputDir} onClick={() => void api.app.openPath(outputDir)}>
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate">{outputDir}</span>
            </button>
          ) : null}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="primary" size="lg" className="col-span-2" onClick={() => first && void api.app.showItemInFolder(first)} disabled={!first}>
            <FolderOpen className="h-4 w-4" /> Abrir pasta
          </Button>
          <Button variant="secondary" onClick={() => first && void copyFile(first)} disabled={!first}>
            <Copy className="h-4 w-4" /> Copiar arquivo
          </Button>
          <Button variant="secondary" onClick={onReexport}>
            <RotateCcw className="h-4 w-4" /> Reexportar
          </Button>
        </div>
      </div>

      <div className="mt-4 flex gap-2 border-t border-border pt-4">
        <Button variant="ghost" className="text-danger hover:bg-danger/10 hover:text-danger" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="h-4 w-4" /> Excluir bruto
        </Button>
        <Button variant="success" className="ml-auto" onClick={onNewRecording}>
          <Video className="h-4 w-4" /> Nova gravação
        </Button>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title="Excluir gravação bruta?"
          description="Os arquivos brutos desta gravação (tela, webcam e áudios separados) vão para a Lixeira. Os vídeos já exportados continuam na pasta de destino."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                disabled={deleting}
                onClick={() => {
                  setDeleting(true)
                  void onDeleteRaw().finally(() => {
                    setDeleting(false)
                    setConfirmDelete(false)
                  })
                }}
              >
                <Trash2 className="h-4 w-4" /> Excluir
              </Button>
            </>
          }
        />
      </Dialog>
    </div>
  )
}
