// Edição do cursorFx (F6) do clipe da tela. O campo pode faltar (gravação importada, projeto regravado pela v1.3): a
// 1ª mudança o cria a partir de DEFAULT_CURSOR_FX, dentro da mesma edição (um passo de desfazer).
import { updateItem } from '@shared/editor/ops'
import { DEFAULT_CURSOR_FX, type CursorFx, type MediaItem, type Project } from '@shared/editor/project'

export function updateCursorFx(p: Project, itemId: string, recipe: (fx: CursorFx) => void): Project {
  return updateItem<MediaItem>(p, itemId, (d) => {
    if (!d.cursorFx) d.cursorFx = { highlight: { ...DEFAULT_CURSOR_FX.highlight }, cursor: { ...DEFAULT_CURSOR_FX.cursor } }
    recipe(d.cursorFx)
  })
}
