import { existsSync, promises as fsp, readdirSync, statSync } from 'fs'
import { join } from 'path'

// Limpeza de arquivos temporários (.part) que sobraram de uma queda/encerramento forçado: a ingestão grava
// <nome>.part-<pid>-<n>.<ext> em proxies/ e cache/ dos projetos e a exportação do editor grava
// <nome>.mp4.part na pasta de saída (que o numberedName ainda contaria como "ocupado"). Só arquivos com
// esse padrão e com mais de 1 dia: nada em uso por esta ou outra instância é tocado.

export const STALE_PART_MS = 86_400_000

const INGEST_PART = /\.part-\d+-\d+(\.[A-Za-z0-9]+)?$/
const EXPORT_PART = /\.mp4\.part$/i

export const isIngestPart = (name: string): boolean => INGEST_PART.test(name)
export const isExportPart = (name: string): boolean => EXPORT_PART.test(name)

export interface SweepTarget {
  dir: string
  kind: 'ingest' | 'export'
}

/** .part antigos de uma pasta (sem apagar). Pasta ausente/ilegível → nenhum. */
export function staleParts(target: SweepTarget, now: number, maxAgeMs = STALE_PART_MS): string[] {
  if (!existsSync(target.dir)) return []
  const match = target.kind === 'ingest' ? isIngestPart : isExportPart
  const out: string[] = []
  let names: string[] = []
  try {
    names = readdirSync(target.dir)
  } catch {
    return []
  }
  for (const name of names) {
    if (!match(name)) continue
    const path = join(target.dir, name)
    try {
      const st = statSync(path)
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) out.push(path)
    } catch {
      // sumiu no meio: ignora
    }
  }
  return out
}

/** Apaga os .part antigos das pastas; devolve os apagados (falha ao apagar um não interrompe os outros). */
export async function sweepStaleParts(targets: SweepTarget[], opts: { now?: () => number; maxAgeMs?: number; log?: { warn: (...a: unknown[]) => void } } = {}): Promise<string[]> {
  const now = (opts.now ?? Date.now)()
  const removed: string[] = []
  for (const t of targets) {
    for (const path of staleParts(t, now, opts.maxAgeMs)) {
      try {
        await fsp.rm(path, { force: true })
        removed.push(path)
      } catch (e) {
        opts.log?.warn(`não foi possível apagar o temporário ${path}`, e)
      }
    }
  }
  return removed
}
