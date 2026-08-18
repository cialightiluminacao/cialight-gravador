// Borda fina "gravando" no monitor (vermelha; âmbar quando pausado) + pílula de estado.
// Em modo janela (rect informado) a borda contorna a janela; sem rect, contorna a tela toda.
export function RecBorder({ paused, rect, drawing, windowMode, sourceName }: { paused: boolean; rect: { x: number; y: number; width: number; height: number } | null; drawing: boolean; windowMode?: boolean; sourceName?: string }): React.JSX.Element {
  const color = paused ? '#f5b301' : '#ff4d4f'
  const style: React.CSSProperties = rect
    ? { position: 'fixed', left: rect.x, top: rect.y, width: rect.width, height: rect.height }
    : { position: 'fixed', inset: 0 }
  if (windowMode && !rect) {
    // modo janela sem bounds conhecidos: só um indicador discreto no topo
    return (
      <div className="pointer-events-none fixed left-1/2 top-3 -translate-x-1/2 rounded-full border border-white/15 bg-black/70 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] backdrop-blur" style={{ color }}>
        {paused ? 'Pausado' : 'Gravando'} · janela{sourceName ? `: ${sourceName}` : ''}
      </div>
    )
  }
  return (
    <>
      <div className="rec-border pointer-events-none" style={{ ...style, border: `4px solid ${color}`, boxSizing: 'border-box', boxShadow: `inset 0 0 28px ${paused ? 'rgba(245,179,1,0.22)' : 'rgba(255,77,79,0.22)'}` }} />
      {paused || drawing ? (
        <div className="pointer-events-none fixed left-1/2 top-3 -translate-x-1/2 rounded-full border border-white/15 bg-black/70 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-white backdrop-blur" style={{ color: paused ? '#f5b301' : '#fff' }}>
          {paused ? 'Pausado' : 'Modo anotação — Esc para sair'}
        </div>
      ) : null}
    </>
  )
}
