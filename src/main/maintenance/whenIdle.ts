// Tarefa de manutenção pesada (probe de encoders: encode-teste em cada encoder de GPU) só com o app ocioso:
// gravando ou exportando, adia e confere de novo a cada `retryMs`, até ficar ocioso ou o app sair.

export async function runWhenIdle(
  task: () => Promise<void>,
  opts: { isBusy: () => boolean; retryMs: number; stopped?: () => boolean; onPostpone?: () => void }
): Promise<void> {
  for (;;) {
    if (opts.stopped?.()) return
    if (!opts.isBusy()) return task()
    opts.onPostpone?.()
    await new Promise<void>((r) => setTimeout(r, opts.retryMs))
  }
}
