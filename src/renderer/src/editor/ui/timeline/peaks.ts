import { useEffect, useState } from 'react'

// Peaks de áudio (Int8 min/max intercalados, 100 por segundo) carregados via
// fetch(cialight-file://project/...) e guardados em memória por asset + caminho. Falhas não ficam
// em cache (tenta de novo na próxima montagem) e invalidatePeaks(assetId) força reler um arquivo
// regenerado pela ingestão (mesmo caminho, conteúdo novo).

const cache = new Map<string, Int8Array>()
const pending = new Map<string, Promise<Int8Array | null>>()
const listeners = new Set<() => void>()

const keyOf = (assetId: string, url: string): string => `${assetId}|${url}`

function load(key: string, url: string): Promise<Int8Array | null> {
  let p = pending.get(key)
  if (!p) {
    p = fetch(url, { cache: 'no-store' })
      .then(async (r) => (r.ok ? new Int8Array(await r.arrayBuffer()) : null))
      .catch(() => null)
      .then((data) => {
        if (pending.get(key) === p) {
          pending.delete(key)
          if (data) cache.set(key, data)
        }
        return data
      })
    pending.set(key, p)
  }
  return p
}

/** Esquece os peaks do asset (a ingestão gravou um arquivo novo); quem estiver usando relê. */
export function invalidatePeaks(assetId: string): void {
  const prefix = `${assetId}|`
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k)
  for (const k of [...pending.keys()]) if (k.startsWith(prefix)) pending.delete(k)
  for (const l of listeners) l()
}

/** Peaks do asset (null enquanto carrega, sem url ou se falhar). */
export function usePeaks(assetId: string, url: string | null): Int8Array | null {
  const [gen, setGen] = useState(0)
  const key = url ? keyOf(assetId, url) : null
  useEffect(() => {
    const bump = (): void => setGen((g) => g + 1)
    listeners.add(bump)
    return () => {
      listeners.delete(bump)
    }
  }, [])
  useEffect(() => {
    if (!key || !url || cache.has(key)) return
    let alive = true
    void load(key, url).then((data) => {
      // falha: sem novo render (nada de laço de tentativas); a próxima montagem tenta de novo
      if (alive && data) setGen((g) => g + 1)
    })
    return () => {
      alive = false
    }
  }, [key, url, gen])
  return key ? (cache.get(key) ?? null) : null
}
