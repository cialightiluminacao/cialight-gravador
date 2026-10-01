// Uma execução por vez de uma tarefa cara (probe de encoders): sem `force`, quem chega durante uma execução
// recebe a mesma promessa; com `force`, espera a atual terminar e roda de novo (nunca duas ao mesmo tempo).

export function singleFlight<T>(run: (force: boolean) => Promise<T>): (force?: boolean) => Promise<T> {
  let inFlight: Promise<T> | null = null
  return (force = false) => {
    if (inFlight && !force) return inFlight
    const prev = inFlight
    const p = (async () => {
      if (prev) await prev.catch(() => {})
      return run(force)
    })()
    inFlight = p
    const clear = (): void => {
      if (inFlight === p) inFlight = null
    }
    p.then(clear, clear)
    return p
  }
}
