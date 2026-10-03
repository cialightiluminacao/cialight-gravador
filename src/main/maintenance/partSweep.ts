import { existsSync, promises as fsp, readdirSync, statSync } from 'fs'
import { join } from 'path'

// Limpeza de arquivos temporários (.part) que sobraram de uma queda/encerramento forçado: a ingestão grava
// <nome>.part-<pid>-<n>.<ext> em proxies/ e cache/ dos projetos e a exportação do editor grava
// <nome>.<mp4|gif|png|wav|mp3|m4a>.part (+ os temporários do GIF e da reserva libx264) na pasta de saída (que o numberedName
// ainda contaria como "ocupado"). Só arquivos com esse padrão e com mais de 1 dia: nada em uso por esta ou
// outra instância é tocado.

export const STALE_PART_MS = 86_400_000

const INGEST_PART = /\.part-\d+-\d+(\.[A-Za-z0-9]+)?$/
// <nome>.<ext>.part do arquivo final, os temporários do GIF (<nome>.gif.ffv1.part, <nome>.gif.palette.part) e o
// áudio PCM da reserva libx264 (<nome>.mp4.audio.part) — cada temporário só com a extensão que o gera
const EXPORT_PART = /\.((mp4|gif|png|wav|mp3|m4a)|gif\.(ffv1|palette)|mp4\.audio)\.part$/i

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

const MEDIA_EXT_END = /\.(mp4|mov|m4v|mkv|webm|gif|png|mp3|wav|m4a)$/i
const NUMBER_SUFFIX = /^( \(\d+\))?\./

/**
 * Parciais de exportação (`<nome>[ (n)].<ext>.part` e os temporários do GIF/x264) que pertencem a uma saída pedida
 * como `fileName` (com ou sem extensão). Só estes nomes: nada além do que aquela exportação gera.
 */
export function exportPartsFor(names: readonly string[], fileName: string): string[] {
  const stem = fileName.trim().replace(MEDIA_EXT_END, '')
  if (!stem) return []
  return names.filter((n) => isExportPart(n) && n.startsWith(stem) && NUMBER_SUFFIX.test(n.slice(stem.length)))
}

/** Apaga os parciais antigos das saídas dos itens da fila salva (pasta ausente/ilegível → nada). Devolve os apagados. */
export async function removeItemParts(items: readonly { outputDir: string; fileName: string }[], log?: { warn: (...a: unknown[]) => void }): Promise<string[]> {
  const removed: string[] = []
  const seen = new Set<string>()
  for (const it of items) {
    let names: string[] = []
    try {
      names = readdirSync(it.outputDir)
    } catch {
      continue
    }
    for (const n of exportPartsFor(names, it.fileName)) {
      const path = join(it.outputDir, n)
      if (seen.has(path)) continue
      seen.add(path)
      try {
        await fsp.rm(path, { force: true })
        removed.push(path)
      } catch (e) {
        log?.warn(`não foi possível apagar o temporário ${path}`, e)
      }
    }
  }
  return removed
}
