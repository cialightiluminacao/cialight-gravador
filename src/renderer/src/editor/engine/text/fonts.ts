// Fontes do texto no render worker (F5). As famílias do sistema funcionam pelo nome (o FontFaceSet não as conhece:
// `check` dá pronta); a fonte do app (Manrope Variable, @fontsource-variable/manrope — na página ela vem do CSS) é
// registrada no worker por FontFace com a URL do arquivo do bundle. Ao receber o projeto o worker pede o carregamento
// das fontes usadas; a exportação espera por elas antes do primeiro quadro; o preview desenha com a reserva e
// redesenha quando `load` resolve (textRaster.fontReady / Compositor.pendingFonts).
import manropeLatin from '@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?url'
import manropeLatinExt from '@fontsource-variable/manrope/files/manrope-latin-ext-wght-normal.woff2?url'
import type { FontRequest } from './fontRequests'
import { fontReady, fontSet } from './textRaster'

// mesmas faixas Unicode do CSS do pacote (latim cobre o português; latin-ext, nomes estrangeiros)
const APP_FONTS: { family: string; url: string; weight: string; unicodeRange: string }[] = [
  { family: 'Manrope Variable', url: manropeLatin, weight: '200 800', unicodeRange: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' },
  { family: 'Manrope Variable', url: manropeLatinExt, weight: '200 800', unicodeRange: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' }
]

let registered = false

/** Registra as fontes do app no FontFaceSet do worker (uma vez; sem carregar — `load` carrega sob demanda). */
export function registerAppFonts(): void {
  const set = fontSet()
  if (registered || !set || typeof FontFace === 'undefined') return
  registered = true
  for (const f of APP_FONTS) set.add(new FontFace(f.family, `url(${JSON.stringify(f.url)}) format('woff2')`, { weight: f.weight, style: 'normal', unicodeRange: f.unicodeRange }))
}

/** Carrega as fontes pedidas (falha ou demora além de `timeoutMs`: segue com a reserva). */
export async function loadFonts(reqs: readonly FontRequest[], timeoutMs = 10_000): Promise<FontRequest[]> {
  const set = fontSet()
  if (!set || reqs.length === 0) return []
  let timer: ReturnType<typeof setTimeout> | undefined
  const all = Promise.allSettled(reqs.map((r) => set.load(r.font, r.text)))
  await Promise.race([all, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]).finally(() => clearTimeout(timer))
  return reqs.filter((r) => !fontReady(r.font, r.text))
}
