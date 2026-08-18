// Contagem regressiva gigante, sem fundo (a overlay é transparente e excluída da captura).
export function Countdown({ count }: { count: number }): React.JSX.Element {
  return (
    <div className="pointer-events-none fixed inset-0 flex items-center justify-center">
      <div key={count} className="countdown-num font-mono tnum" aria-live="assertive">
        {count}
      </div>
      <style>{`
        .countdown-num {
          font-size: min(28vw, 360px);
          font-weight: 700;
          color: #fff;
          text-shadow: 0 0 40px rgba(255,77,79,0.85), 0 4px 30px rgba(0,0,0,0.7);
          animation: cd-pop 0.95s cubic-bezier(0.2, 0.8, 0.2, 1) both;
          line-height: 1;
        }
        @keyframes cd-pop {
          0% { transform: scale(0.6); opacity: 0; }
          18% { transform: scale(1.06); opacity: 1; }
          70% { transform: scale(1); opacity: 1; }
          100% { transform: scale(0.98); opacity: 0; }
        }
      `}</style>
    </div>
  )
}
