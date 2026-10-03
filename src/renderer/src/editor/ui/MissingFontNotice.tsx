import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { missingFontMessage } from './fontActions'

/** Aviso de fonte ausente com o botão de troca (inspetor e exportação). */
export function MissingFontNotice({ family, onReplace, disabled, className }: { family: string; onReplace: () => void; disabled?: boolean; className?: string }): React.JSX.Element {
  return (
    <div className={className ?? 'flex flex-col gap-1.5 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2.5 text-[12px] text-warn'} role="status" data-missing-font={family}>
      <div className="flex items-start gap-1.5">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{missingFontMessage(family)}</span>
      </div>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={onReplace}>
        Trocar para Manrope
      </Button>
    </div>
  )
}
