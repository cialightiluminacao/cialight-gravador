// "Trocar para Manrope" (G4): troca a família ausente (um passo de desfazer) e avisa por toast.
import { toast } from 'sonner'
import { DEFAULT_TEXT_FONT, patchTextStyle } from '@shared/editor/factory'
import { replaceFontFamily } from '@shared/editor/fontMissing'
import { updateItem } from '@shared/editor/ops'
import type { TextItem } from '@shared/editor/project'
import { useEditorStore } from '../state/editorStore'

export const missingFontMessage = (family: string): string => `A fonte “${family}” não está instalada; usando a fonte padrão sem serifa.`

/**
 * Toast da troca (puro): algo trocado → "Fonte trocada…" (citando as faixas bloqueadas puladas); nada trocado porque
 * todos os textos com a família estão em faixas bloqueadas → "Nenhum texto foi alterado" (nunca "trocada" sem troca);
 * nada trocado e nada pulado → nenhum toast.
 */
export function fontReplaceToast(changed: boolean, skippedLocked: number): { title: string; description: string } | null {
  if (changed) return { title: 'Fonte trocada para Manrope', description: skippedLocked ? 'Ctrl+Z desfaz. Textos em faixas bloqueadas não foram alterados.' : 'Ctrl+Z desfaz.' }
  if (skippedLocked) return { title: 'Nenhum texto foi alterado', description: 'Os textos com essa fonte estão em faixas bloqueadas.' }
  return null
}

const show = (changed: boolean, skipped: number): void => {
  const t = fontReplaceToast(changed, skipped)
  if (t) toast(t.title, { description: t.description })
}

/** Inspetor: só o texto selecionado. */
export function replaceItemFont(itemId: string): void {
  if (useEditorStore.getState().apply((p) => updateItem<TextItem>(p, itemId, (d) => { d.style = patchTextStyle(d.style, { font: DEFAULT_TEXT_FONT }) }))) show(true, 0)
}

/** Exportação: todos os textos (legendas incluídas) da família `family`, num passo. */
export function replaceProjectFont(family: string): void {
  let skipped = 0
  let changed = 0
  // apply devolve true também quando nada mudou: o que conta é o que replaceFontFamily trocou
  const ok = useEditorStore.getState().apply((p) => {
    const r = replaceFontFamily(p, family, DEFAULT_TEXT_FONT)
    skipped = r.skippedLocked
    changed = r.changed
    return r.project
  })
  show(ok && changed > 0, skipped)
}
