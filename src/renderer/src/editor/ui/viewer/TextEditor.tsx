import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { evalAnim } from '@shared/editor/anim'
import { findItem, updateItem } from '@shared/editor/ops'
import type { TextItem } from '@shared/editor/project'
import { cssFont, fontPx } from '../../engine/text/textRaster'
import { useEditorStore } from '../../state/editorStore'
import type { ItemBox } from '../viewerGeometry'
import { editBackdrop, editBox, planTextEdit } from './textEdit'

// Edição direta do texto no visualizador (duplo clique): <textarea> sobre a caixa do texto, na escala do visualizador,
// com a fonte, o tamanho e a cor do estilo. Enter = nova linha; Ctrl+Enter ou clicar fora = confirma (UM passo de
// desfazer); Esc = cancela. É um campo de texto: os atalhos do editor não disparam enquanto o foco está nele
// (shortcuts.isEditableTarget).

export function TextEditor({ itemId, box, k, onClose }: { itemId: string; box: ItemBox; k: number; onClose: () => void }): React.JSX.Element | null {
  const project = useEditorStore((s) => s.project)
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  const item = project ? (findItem(project, itemId)?.item as TextItem | undefined) : undefined
  const exists = item?.type === 'text'
  // o item sumiu no meio da edição (desfazer, apagar): fecha sem gravar
  useEffect(() => {
    if (!exists && !done.current) {
      done.current = true
      onClose()
    }
  }, [exists, onClose])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [])
  if (!project || !item || item.type !== 'text') return null

  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    const typed = ref.current?.value ?? item.text
    if (commit) {
      const plan = planTextEdit(item.text, typed)
      if (plan.kind === 'empty') toast('O texto não pode ficar vazio: o anterior foi mantido.')
      else if (plan.kind === 'change') useEditorStore.getState().apply((p) => updateItem<TextItem>(p, itemId, (d) => { d.text = plan.text }))
    }
    onClose()
  }

  const st = useEditorStore.getState()
  const local = Math.min(Math.max(0, st.playheadUs - item.startUs), item.durationUs)
  const style = item.style
  const scale = evalAnim(item.visual.transform.scale, local)
  const px = fontPx(Math.max(1, evalAnim(style.size, local)), { W: project.canvas.width, H: project.canvas.height }) * scale * k
  const pad = style.background ? (style.padding ?? 0.3) * px : 0
  const r = editBox(box, k)

  return (
    <textarea
      ref={ref}
      data-text-editor={itemId}
      aria-label="Editar texto. Ctrl+Enter confirma, Esc cancela"
      defaultValue={item.text}
      spellCheck={false}
      className="absolute z-20 resize-none overflow-auto rounded-sm border-0 outline-2 outline-accent"
      style={{
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        transform: `rotate(${box.rotation}deg)`,
        font: cssFont(style, px),
        lineHeight: style.lineHeight,
        textAlign: style.align,
        color: style.color,
        background: editBackdrop(style.color),
        padding: pad,
        whiteSpace: 'pre-wrap',
        boxSizing: 'border-box'
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation() // o teclado é desta caixa: nenhum atalho do editor (nem Esc = desmarcar) roda
        if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          finish(true)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}
