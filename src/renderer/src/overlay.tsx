import ReactDOM from 'react-dom/client'
import './styles.css'
import { OverlayApp } from './overlay/OverlayApp'

// Página da overlay transparente (uma por monitor). Fundo transparente é obrigatório.
document.documentElement.style.background = 'transparent'
document.body.style.background = 'transparent'

const isSpike = new URLSearchParams(location.search).has('spike')

function SpikeOverlay(): React.JSX.Element {
  return (
    <div className="fixed inset-0" style={{ background: 'transparent' }} onPointerDown={(e) => window.spikeApi.overlayReport(`pointerdown ${e.clientX},${e.clientY}`)}>
      <div className="absolute left-2 top-2 rounded bg-black/60 px-2 py-1 text-xs text-white">OVERLAY SPIKE (transparente, click-through)</div>
      <div className="absolute flex items-center justify-center rounded-lg text-white" style={{ left: '70%', top: '20%', width: '16%', height: '16%', background: 'rgba(255,0,0,0.45)', border: '3px solid rgba(255,255,255,0.8)' }}>
        alvo do clique
      </div>
      <div className="absolute inset-0 border-4 border-red-500/70 pointer-events-none" />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(isSpike ? <SpikeOverlay /> : <OverlayApp />)
