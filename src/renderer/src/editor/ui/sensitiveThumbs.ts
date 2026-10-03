import { ALL_FORMATS, CanvasSink, Input, UrlSource } from 'mediabunny'
import type { Project } from '@shared/editor/project'
import { occurrenceRegionAt } from '@shared/editor/sensitiveScan'
import { mediaUrlsFor } from '../engine/mediaUrls'
import { thumbCrop, type ReviewRow } from './sensitiveReview'

// Miniaturas da revisão do "Procurar dados sensíveis": o quadro da FONTE em `firstSeenUs`, recortado em volta da caixa,
// 160×60. Tudo no renderer (mediabunny/WebCodecs, a mesma leitura do preview); nenhum pixel vai ao main e as imagens
// ficam só na memória do diálogo (data URLs no estado dele, apagadas ao fechar).

export const THUMB_W = 160
export const THUMB_H = 60

export async function makeThumbs(p: Project, rows: readonly ReviewRow[], signal: AbortSignal, onThumb: (rowId: string, url: string) => void): Promise<void> {
  const urls = mediaUrlsFor(p, 'preview')
  const byAsset = new Map<string, ReviewRow[]>()
  for (const r of rows) {
    const l = byAsset.get(r.assetId)
    if (l) l.push(r)
    else byAsset.set(r.assetId, [r])
  }
  const out = document.createElement('canvas')
  out.width = THUMB_W
  out.height = THUMB_H
  const ctx = out.getContext('2d')
  if (!ctx) return
  for (const [assetId, list] of byAsset) {
    if (signal.aborted) return
    const asset = p.assets.find((a) => a.id === assetId)
    const url = urls[assetId]?.original
    if (!asset || !url) continue
    // intermediário só tem 0:v:0 (como o render worker); o original multi-faixa usa a faixa do asset
    const trackIndex = asset.intermediate ? null : (asset.videoTrackIndex ?? null)
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
    try {
      const track = trackIndex === null ? await input.getPrimaryVideoTrack() : ((await input.getVideoTracks())[trackIndex] ?? null)
      if (!track || !(await track.canDecode())) continue
      const firstS = await track.getFirstTimestamp()
      const sorted = [...list].sort((a, b) => a.occ.firstSeenUs - b.occ.firstSeenUs)
      const sink = new CanvasSink(track, { poolSize: 1 })
      let i = 0
      for await (const wc of sink.canvasesAtTimestamps(sorted.map((r) => Math.max(firstS, r.occ.firstSeenUs / 1e6)))) {
        const r = sorted[i++]
        if (signal.aborted) return
        if (!wc || !r) continue
        const src = wc.canvas
        const box = occurrenceRegionAt(r.occ, r.occ.firstSeenUs) ?? r.box
        const c = thumbCrop(box, src.width, src.height, THUMB_W / THUMB_H)
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, THUMB_W, THUMB_H)
        ctx.drawImage(src, c.x, c.y, c.w, c.h, 0, 0, THUMB_W, THUMB_H)
        onThumb(r.id, out.toDataURL('image/png'))
      }
    } catch {
      // sem miniatura (a linha mostra só o tipo e o texto mascarado)
    } finally {
      input.dispose()
    }
  }
}
