// Ponte TS → .mjs do QA de privacidade do G3 (scripts/qa/editor-g3-privacy.mjs): o script empacota este arquivo com o
// esbuild (em test-out/e2e-g3) e usa o MESMO código do app — helper de OCR do Windows (ocrHelper), ladrilhos e
// normalização (sensitiveScan), detector (sensitive) e os geradores de valores falsos válidos (sensitiveFakes) —, em vez
// de reimplementar nada no script.
import { OcrHelper } from '../../src/main/sensitive/ocrHelper'
import { detectSensitive, type OcrLine } from '../../src/shared/editor/sensitive'
import { helperLinesToOcr, tilePlan } from '../../src/shared/editor/sensitiveScan'
export { fakeCard, fakeCep, fakeCnpj, fakeCpf, fakeEmail, fakeIpv4, fakePhone, formatCard, formatCnpj, formatCpf } from '../../src/shared/editor/__fixtures__/sensitiveFakes'

/** Sobreposição dos ladrilhos (a mesma da varredura, src/main/sensitive/scan.ts). */
const TILE_OVERLAP = 256

export interface Ocr {
  /** Valores detectados (com o valor: só no processo do QA, nunca gravados) num quadro cinza w×h. */
  detect(data: Uint8Array, w: number, h: number): Promise<{ kind: string; value: string; box: { x: number; y: number; w: number; h: number } }[]>
  lang: string
  close(): Promise<void>
}

/** Inicia o helper (resources/ocr/ocr-winrt.ps1) como a varredura: um processo, quadros ladrilhados se passarem do maxDim. */
export async function startOcr(script: string, onSpawn?: (pid: number) => void): Promise<Ocr> {
  const h = await OcrHelper.start({ script, onSpawn })
  return {
    lang: h.lang,
    async detect(data, w, h2) {
      const tiles = tilePlan(w, h2, h.maxDim, TILE_OVERLAP)
      const lines: OcrLine[] = []
      if (tiles.length === 1) lines.push(...helperLinesToOcr(await h.recognize(data, w, h2), w, h2))
      else for (const t of tiles) {
        const buf = new Uint8Array(t.w * t.h)
        for (let y = 0; y < t.h; y++) buf.set(data.subarray((t.y + y) * w + t.x, (t.y + y) * w + t.x + t.w), y * t.w)
        lines.push(...helperLinesToOcr(await h.recognize(buf, t.w, t.h), w, h2, t))
      }
      return detectSensitive(lines).map((d) => ({ kind: d.kind, value: d.value, box: d.box }))
    },
    close: () => h.close()
  }
}
