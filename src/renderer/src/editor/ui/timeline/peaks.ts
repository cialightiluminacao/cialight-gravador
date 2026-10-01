import { useEffect, useState } from 'react'

// Peaks de áudio (Int8 min/max intercalados, 100 por segundo) carregados uma vez por arquivo via
// fetch(cialight-file://project/...) e guardados em memória enquanto o app roda.

const cache = new Map<string, Int8Array | null>()
const pending = new Map<string, Promise<Int8Array | null>>()

function load(url: string): Promise<Int8Array | null> {
  let p = pending.get(url)
  if (!p) {
    p = fetch(url)
      .then(async (r) => (r.ok ? new Int8Array(await r.arrayBuffer()) : null))
      .catch(() => null)
      .then((data) => {
        cache.set(url, data)
        pending.delete(url)
        return data
      })
    pending.set(url, p)
  }
  return p
}

/** Peaks do arquivo (null enquanto carrega, sem url ou se falhar). */
export function usePeaks(url: string | null): Int8Array | null {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!url || cache.has(url)) return
    let alive = true
    void load(url).then(() => {
      if (alive) setTick((t) => t + 1)
    })
    return () => {
      alive = false
    }
  }, [url])
  return url ? (cache.get(url) ?? null) : null
}
