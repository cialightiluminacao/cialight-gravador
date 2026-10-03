import { useMemo, useState } from 'react'
import { ChevronDown, Copy, FileDown, TriangleAlert } from 'lucide-react'
import { chaptersFromMarkers } from '@shared/editor/chapters'
import type { Marker } from '@shared/editor/project'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { chaptersFileName, copyChaptersText, saveChaptersText } from './chaptersActions'

/**
 * "Capítulos (YouTube)": texto gerado dos marcadores do intervalo exportado, para colar na descrição do vídeo.
 * Recolhível; avisos (menos de 3 capítulos, trechos < 10 s) não alteram a lista.
 */
export function ChaptersSection({ markers, fromUs, toUs, projectName, folder, defaultOpen = false }: { markers: readonly Marker[]; fromUs: number; toUs: number; projectName: string; folder: string | null; defaultOpen?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const r = useMemo(() => chaptersFromMarkers(markers, { fromUs, toUs }), [markers, fromUs, toUs])
  const empty = r.chapters.length === 0
  return (
    <div className="rounded-xl border border-border" data-chapters="">
      <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-[12px] font-medium text-fg-2" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-chapters-toggle="">
        <span>
          Capítulos (YouTube) <span className="text-muted">· {r.chapters.length} {r.chapters.length === 1 ? 'capítulo' : 'capítulos'}</span>
        </span>
        <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2.5">
          {empty ? (
            <p className="text-[12px] text-muted" data-chapters-empty="">Adicione marcadores (M) na linha do tempo para gerar os capítulos.</p>
          ) : (
            <textarea
              readOnly
              aria-label="Capítulos do YouTube (texto para a descrição)"
              className="h-28 w-full resize-none rounded-lg border border-border-strong bg-bg-2 px-2.5 py-2 font-mono text-[12px] leading-5 text-fg outline-none focus:border-accent/60"
              value={r.text}
              onFocus={(e) => e.currentTarget.select()}
              data-chapters-text=""
            />
          )}
          {r.warnings.length && !empty ? (
            <ul className="flex flex-col gap-1 rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-2 text-[12px] text-warn" data-chapters-warnings="">
              {r.warnings.map((w) => (
                <li key={w} className="flex items-start gap-1.5">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{w}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={empty} aria-label="Copiar capítulos" onClick={() => void copyChaptersText(r.text)} data-chapters-copy="">
              <Copy className="h-4 w-4" /> Copiar
            </Button>
            <Button variant="secondary" size="sm" disabled={empty} aria-label={`Salvar capítulos como ${chaptersFileName(projectName)}`} onClick={() => void saveChaptersText(r.text, projectName, folder)} data-chapters-save="">
              <FileDown className="h-4 w-4" /> Salvar .txt
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
