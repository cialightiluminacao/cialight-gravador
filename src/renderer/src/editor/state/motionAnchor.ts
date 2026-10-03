import { anchorBeforeMotion, attachEffects } from '@shared/editor/followTransform'
import type { Project } from '@shared/editor/project'
import { useEditorStore } from './editorStore'

// "Ancorar" / "Vincular e ancorar" oferecidos logo depois de um movimento (zoom da ferramenta, Ken Burns, zoom
// automático — ZoomTool.warnLinkedEffects). Revisão final da F6, C1: as keys da região (rastreadas no clipe parado,
// keyframes do F4) foram feitas na pose de ANTES do movimento; convertê-las com a pose do zoom deixava a região onde o
// key do quadro estava enquanto o conteúdo andava, e o aviso sumia.

/**
 * O movimento recém-aplicado: `after` = o projeto logo depois dele (o present do histórico); `edit` = o mesmo
 * movimento, aplicável a outro projeto.
 */
export interface MotionRedo { after: Project; edit: (p: Project) => Project }

/**
 * Ancora `ids` no clipe. Logo depois do movimento (o projeto ainda é `redo.after`): desfaz o movimento, ancora no
 * projeto de antes e refaz o movimento, num passo só no lugar do passo do movimento (anchorBeforeMotion; falhou → o
 * movimento volta como estava). Sem `redo` ou com o projeto já mudado: attachEffects no atual (com keys num trecho em
 * que o clipe se move e que não o acompanha, ele recusa com EditError → toast). false = não ancorou.
 */
export function anchorAfterMotion(itemId: string, ids: string[], redo: MotionRedo | undefined): boolean {
  const st = useEditorStore.getState()
  if (redo && st.project === redo.after && st.canUndo && !st.txBase) {
    st.undo()
    const ok = useEditorStore.getState().apply((before) => anchorBeforeMotion(before, itemId, ids, redo.edit))
    if (!ok) useEditorStore.getState().redo()
    return ok
  }
  return st.apply((r) => attachEffects(r, itemId, ids))
}
