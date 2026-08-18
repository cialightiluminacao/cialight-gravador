import { ArrowUpRight, Eraser, Minus, PenLine, Undo2, X } from 'lucide-react'
import type { StrokeTool } from '@shared/types'
import type { DrawSettings } from './DrawSurface'

// Paleta mínima do modo desenho (canto superior direito). Não rouba o foco do canvas.
const COLORS: { c: string; k: string; name: string }[] = [
  { c: '#ff3b30', k: 'R', name: 'Vermelho' },
  { c: '#3ddc97', k: 'G', name: 'Verde' },
  { c: '#4d8dff', k: 'B', name: 'Azul' },
  { c: '#ffd23f', k: 'Y', name: 'Amarelo' },
  { c: '#ffffff', k: 'W', name: 'Branco' }
]
const TOOLS: { t: StrokeTool; icon: React.ReactNode; name: string; k: string }[] = [
  { t: 'pen', icon: <PenLine className="h-4 w-4" />, name: 'Caneta', k: 'P' },
  { t: 'line', icon: <Minus className="h-4 w-4" />, name: 'Linha (Shift)', k: 'L' },
  { t: 'arrow', icon: <ArrowUpRight className="h-4 w-4" />, name: 'Seta (Ctrl+Shift)', k: 'A' }
]

export function DrawPalette({ settings, onChange, onTool, onUndo, onClear, onExit }: { settings: DrawSettings; onChange: (s: DrawSettings) => void; onTool: (t: StrokeTool) => void; onUndo: () => void; onClear: () => void; onExit: () => void }): React.JSX.Element {
  const btn = 'flex h-8 w-8 items-center justify-center rounded-lg text-white/85 hover:bg-white/10 hover:text-white'
  return (
    <div className="fixed right-4 top-4 flex items-center gap-1 rounded-2xl border border-white/12 bg-black/75 p-1.5 shadow-2xl backdrop-blur" onPointerDown={(e) => e.stopPropagation()}>
      {TOOLS.map((t) => (
        <button key={t.t} className={btn} style={settings.tool === t.t ? { background: 'rgba(255,255,255,0.18)', color: '#fff' } : undefined} title={`${t.name} (${t.k})`} onClick={() => onTool(t.t)}>
          {t.icon}
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-white/15" />
      {COLORS.map((c) => (
        <button
          key={c.c}
          className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white/10"
          title={`${c.name} (${c.k})`}
          onClick={() => onChange({ ...settings, color: c.c })}
        >
          <span className="block h-4 w-4 rounded-full ring-2 ring-offset-2 ring-offset-black/80" style={{ background: c.c, boxShadow: settings.color === c.c ? `0 0 0 2px #000, 0 0 0 4px ${c.c}` : 'none' }} />
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-white/15" />
      <button className={btn} title="Mais fino ([)" onClick={() => onChange({ ...settings, width: Math.max(2, settings.width - 2) })}>
        <span className="block h-1 w-4 rounded-full bg-current" />
      </button>
      <span className="font-mono w-6 text-center text-[11px] text-white/80">{settings.width}</span>
      <button className={btn} title="Mais grosso (])" onClick={() => onChange({ ...settings, width: Math.min(24, settings.width + 2) })}>
        <span className="block h-2 w-4 rounded-full bg-current" />
      </button>
      <span className="mx-1 h-5 w-px bg-white/15" />
      <button className={btn} title="Desfazer (Ctrl+Z)" onClick={onUndo}>
        <Undo2 className="h-4 w-4" />
      </button>
      <button className={btn} title="Apagar tudo (E)" onClick={onClear}>
        <Eraser className="h-4 w-4" />
      </button>
      <button className={btn} title="Sair do modo anotação (Esc)" onClick={onExit}>
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
