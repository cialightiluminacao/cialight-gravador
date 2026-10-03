// Relink automático (F7): ao abrir um projeto com mídia importada ausente, o main procura os arquivos em segundo plano
// (project.findRelinks: mesmo nome + tamanho na pasta original, irmãs, pasta-mãe, pastas dos outros assets); achando,
// o diálogo "Mídia encontrada em outro local" lista caminho antigo → novo, todas marcadas. Nada é reapontado sem
// confirmar: "Reapontar selecionadas" aplica cada uma pelo mesmo caminho do "Localizar" (media.relink → probe, mesmo
// tipo, derivados zerados → enqueueAsset), uma por vez, com um toast de resumo e um de erro por mídia. "Agora não" (ou
// fechar o diálogo) não pergunta de novo para esse projeto nesta sessão. Depois de um "Localizar" manual, a busca roda
// de novo para as que faltam, também na pasta do arquivo escolhido (ela é a de um asset presente agora).
import { toast } from 'sonner'
import { create } from 'zustand'
import type { Asset } from '@shared/editor/project'
import { ipcErrorMessage } from '@/lib/ipcError'
import { useEditorStore } from '../state/editorStore'
import { relinkTo } from './mediaImport'
import { relinkApplyList, relinkRows, relinkSummary, setRowChecked, type RelinkRow } from './relinkPlan'

interface RelinkPrompt {
  projectId: string | null
  rows: RelinkRow[]
  applying: boolean
}

export const useRelinkPrompt = create<RelinkPrompt>(() => ({ projectId: null, rows: [], applying: false }))

// projetos (id em minúsculas) com "Agora não" nesta sessão
const declined = new Set<string>()
// busca mais recente: resultado de uma anterior (outro projeto, outra busca) é descartado
let searchSeq = 0

const hasMissingFiles = (assets: Asset[]): boolean => assets.some((a) => a.source.type === 'file' && a.status === 'missing')

/**
 * Busca no main e, achando, abre o diálogo. `manual`: depois de um "Localizar" (pergunta mesmo após "Agora não", o
 * usuário está reapontando); `extraRoots`: pastas a incluir (a do arquivo localizado). Falha na busca: só no console
 * (é segundo plano; o "Localizar" continua disponível em cada mídia).
 */
export async function offerRelinks(projectId: string, opts: { manual?: boolean; extraRoots?: string[] } = {}): Promise<void> {
  if (!opts.manual && declined.has(projectId.toLowerCase())) return
  if (useRelinkPrompt.getState().projectId) return // diálogo já aberto
  const st0 = useEditorStore.getState()
  if (st0.project?.id !== projectId || !hasMissingFiles(st0.project.assets)) return
  const seq = ++searchSeq
  let candidates
  try {
    candidates = await window.api.project.findRelinks(projectId, opts.extraRoots ? { extraRoots: opts.extraRoots } : undefined)
  } catch (e) {
    console.warn('[editor] busca de mídias ausentes falhou', e)
    return
  }
  const st = useEditorStore.getState()
  if (seq !== searchSeq || st.project?.id !== projectId || useRelinkPrompt.getState().projectId) return
  const rows = relinkRows(candidates, st.project.assets)
  if (rows.length) useRelinkPrompt.setState({ projectId, rows, applying: false })
}

export function toggleRelinkRow(assetId: string, checked: boolean): void {
  useRelinkPrompt.setState((s) => ({ rows: setRowChecked(s.rows, assetId, checked) }))
}

/** "Agora não" / fechar: não pergunta de novo para este projeto nesta sessão. */
export function declineRelinks(): void {
  const { projectId, applying } = useRelinkPrompt.getState()
  if (applying) return
  if (projectId) declined.add(projectId.toLowerCase())
  useRelinkPrompt.setState({ projectId: null, rows: [], applying: false })
}

/** Fecha sem decidir (saída do editor) e descarta buscas em andamento. */
export function closeRelinkPrompt(): void {
  searchSeq++
  useRelinkPrompt.setState({ projectId: null, rows: [], applying: false })
}

/** "Reapontar selecionadas": uma por vez pelo media.relink; toasts de resumo e de erro por mídia. */
export async function applyRelinks(): Promise<void> {
  const { projectId, rows, applying } = useRelinkPrompt.getState()
  if (!projectId || applying) return
  useRelinkPrompt.setState({ applying: true })
  const outcomes: { name: string; error?: string }[] = []
  for (const { assetId, newPath } of relinkApplyList(rows)) {
    const st = useEditorStore.getState()
    if (st.project?.id !== projectId) break // saiu do projeto no meio
    const a = st.project.assets.find((x) => x.id === assetId)
    if (!a || a.status !== 'missing') continue // reapontada à mão no meio
    try {
      await relinkTo(projectId, a, newPath)
      outcomes.push({ name: a.name })
    } catch (e) {
      outcomes.push({ name: a.name, error: ipcErrorMessage(e) })
    }
  }
  useRelinkPrompt.setState({ projectId: null, rows: [], applying: false })
  const s = relinkSummary(outcomes)
  if (s.success) toast.success(s.success)
  for (const e of s.errors) toast.error(e)
}

/** "Localizar" (mídia ausente): o usuário escolhe o novo caminho; o asset volta a processar e as que faltam são procuradas. */
export async function relinkAsset(projectId: string, a: Asset): Promise<void> {
  const [path] = await window.api.project.pickMedia()
  if (!path) return
  try {
    await relinkTo(projectId, a, path)
  } catch (e) {
    toast.error(`Não foi possível localizar a mídia: ${ipcErrorMessage(e)}`)
    return
  }
  const dir = path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')))
  void offerRelinks(projectId, { manual: true, extraRoots: dir ? [dir] : undefined })
}
