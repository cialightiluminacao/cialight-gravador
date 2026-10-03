// "Trocar para Manrope" (G4): troca a família ausente (um passo de desfazer) e avisa por toast.
import { toast } from 'sonner'
import { DEFAULT_TEXT_FONT, patchTextStyle } from '@shared/editor/factory'
import { replaceFontFamily } from '@shared/editor/fontMissing'
import { updateItem } from '@shared/editor/ops'
import type { TextItem } from '@shared/editor/project'
import { useEditorStore } from '../state/editorStore'

export const missingFontMessage = (family: string): string => `A fonte “${family}” não está instalada; usando a fonte padrão sem serifa.`

const done = (skipped: number): void => {
  toast('Fonte trocada para Manrope', { description: skipped ? 'Ctrl+Z desfaz. Textos em faixas bloqueadas não foram alterados.' : 'Ctrl+Z desfaz.' })
}

/** Inspetor: só o texto selecionado. */
export function replaceItemFont(itemId: string): void {
  if (useEditorStore.getState().apply((p) => updateItem<TextItem>(p, itemId, (d) => { d.style = patchTextStyle(d.style, { font: DEFAULT_TEXT_FONT }) }))) done(0)
}

/** Exportação: todos os textos (legendas incluídas) da família `family`, num passo. */
export function replaceProjectFont(family: string): void {
  let skipped = 0
  const ok = useEditorStore.getState().apply((p) => {
    const r = replaceFontFamily(p, family, DEFAULT_TEXT_FONT)
    skipped = r.skippedLocked
    return r.project
  })
  if (ok || skipped) done(skipped)
}
