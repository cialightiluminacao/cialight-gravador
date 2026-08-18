import { useEffect, useState } from 'react'

export function App(): React.JSX.Element {
  const [pong, setPong] = useState('...')
  useEffect(() => {
    void window.api.ping().then(setPong)
  }, [])
  return (
    <div className="flex h-full items-center justify-center">
      <div className="rounded-xl border border-border bg-surface p-8 text-center">
        <h1 className="text-2xl font-semibold">CiaLight Gravador</h1>
        <p className="mt-2 text-muted">IPC: {pong}</p>
      </div>
    </div>
  )
}
