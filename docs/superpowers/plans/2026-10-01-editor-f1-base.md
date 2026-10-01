# Editor F1 — Base (modelo, motor, timeline, exportação) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o editor não-linear base (v1.1.0): projetos com mídia importada e gravações, timeline multifaixa com cortar/dividir/mover/ripple/separar áudio/desfazer, preview frame-exato por WebCodecs+WebGL2 e exportação MP4 pelo mesmo compositor.

**Architecture:** Modelo e operações em TS puro (`src/shared/editor/`, testados em vitest). Main cuida de projetos em disco, ingestão (ffprobe/ffmpeg: proxies, filmstrip, peaks) e protocolo `cialight-file://media/...`. Renderer: store zustand+immer com histórico; render worker (OffscreenCanvas WebGL2 + mediabunny) e audio worker (mixer PCM puro) usados tanto no preview quanto na exportação.

**Tech Stack:** Electron 43, React 19, TS, zustand 5, immer 11, zod 4, mediabunny (versão atualizada no F0), twgl.js 7, vitest, ffmpeg n8.1.2 embutido.

**Spec:** `docs/superpowers/specs/2026-10-01-editor-design.md` (ler §3–§9, §11–§14). Resultados do spike F0: `docs/research/2026-10-01-editor-spike-results.md` (ler antes das Tasks 8, 9 e 12 — contém nomes exatos de API do mediabunny, como carregar WASM e números medidos).

## Global Constraints

- Tempos do modelo em **microssegundos inteiros** (`Us`); nunca acumular float. Arredondar com `Math.round` em toda conversão.
- Coordenadas espaciais normalizadas 0–1 ao quadro do projeto; x/y do transform = centro do item.
- Funções em `src/shared/editor/` são **puras** (sem DOM, sem Electron, sem Node APIs) e retornam objetos novos (imutáveis).
- Não alterar o comportamento do fluxo v1 (Preparar → Gravar → Revisão → Exportar). Suíte existente (`npm test`, `npm run typecheck`) deve continuar verde em todo commit.
- Textos de UI em português do Brasil com acentuação correta; código/identificadores em inglês, comentários em português (padrão do repo).
- Testes colocados ao lado do código (`*.test.ts`), ambiente node (vitest).
- Padrão IPC do repo: tipos em `src/shared/ipc.ts` (`IpcApi` + `IPC`), implementação em `src/preload/index.ts`, handlers em `src/main/ipc.ts`.
- UI usa os primitivos existentes (`src/renderer/src/components/ui/*`, tokens Tailwind v4 de `styles.css`, lucide-react, sonner).
- Commits terminam com a linha `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Todo `VideoFrame`/`VideoSample` obtido deve ser fechado (`close()`) no mesmo frame em que é usado.

## Review Focus

- Projeto aberto cuja mídia importada foi movida/apagada → asset `missing`, editor abre e mostra "mídia indisponível" na camada, sem travar (Task 6 e Task 8 testam).
- Dividir exatamente na borda de um item, ou em item com velocidade ≠ 1 → nenhum item de duração 0, `inUs` correto (Task 2 testa).
- Mover item vinculado (vídeo+áudio) para cima de outro → nada se sobrepõe na faixa de destino; operação recusada ou empurra conforme o modo (Task 2 testa).
- Arquivo com rotação 90° (vídeo de celular em pé) → aparece em pé no preview e na exportação (Task 6 sonda `rotation`; Task 8 aplica; Task 12 verifica dimensões).
- Desfazer depois de arrastar um item por 200 eventos de mouse → um único passo de desfazer (Task 7 testa transação).

---

## Mapa de arquivos

```
src/shared/editor/
  project.ts        tipos do modelo (completo, inclusive tipos usados em fases futuras)
  schema.ts         zod + parseProject + validateProject + migrateProject
  time.ts           conversões Us/ms/frames, snap a frame
  anim.ts           Anim/Keyframe: evalAnim, easing, setKey, removeKey
  ids.ts            newId()
  ops.ts            operações de edição (puras)
  snap.ts           cálculo de pontos e snapping
  resolve.ts        resolveFrame(project, tUs) → Layer[]; sourceTimeUs
  audioPlan.ts      planAudio(project) → AudioSegment[]; gainAt
  fromSession.ts    projectFromSession(session, opts)
  factory.ts        createEmptyProject, createMediaItem, defaultVisual, defaultAudio
src/main/project/projectStore.ts     pasta por projeto, project.json atômico, versions/, lista
src/main/media/probe.ts               ffprobe → MediaInfo (parser puro + runner)
src/main/media/proxyPolicy.ts         needsProxy(info) puro
src/main/media/ingest.ts              fila de jobs (proxy, filmstrip, peaks), eventos de progresso
src/main/media/analysis.ts            filmstrip sprite + peaks binário via ffmpeg
src/main/fileProtocol.ts              + host "media" e "project"
src/renderer/src/editor/
  state/editorStore.ts                zustand+immer: project, histórico, seleção, playhead, zoom, transações
  state/history.ts                    pilha de snapshots (puro, testado)
  engine/protocol.ts                  mensagens main-thread ↔ workers
  engine/render.worker.ts             worker: DecoderPool + Compositor; modo preview/export
  engine/decoderPool.ts               mediabunny Inputs/sinks, LRU, getFrame
  engine/compositor/gl.ts             contexto WebGL2, programas, quad, FBOs
  engine/compositor/shaders.ts        GLSL
  engine/compositor/compositor.ts     draw(layers) → canvas
  engine/compositor/matrix.ts         matrizes 2D (puro, testado)
  engine/audio/mixer.ts               mixer PCM puro (testado)
  engine/audio/audio.worker.ts        lê PCM (mediabunny AudioSampleSink), usa mixer
  engine/PlaybackController.ts        AudioContext (relógio) + agenda blocos + dirige render worker
  ui/EditorScreen.tsx, ui/TopBar.tsx, ui/MediaBin.tsx, ui/Viewer.tsx, ui/Inspector/*.tsx
  ui/timeline/{Timeline.tsx,Ruler.tsx,TrackHeader.tsx,TrackLane.tsx,ItemView.tsx,Playhead.tsx,useTimelineDrag.ts,zoom.ts}
  ui/ExportDialog.tsx
  export/editorExport.ts              orquestra export (worker render + audio → mediabunny Output → IPC)
  shortcuts.ts                        mapa de atalhos
src/main/editorTestMode.ts            CIALIGHT_TEST=editor (integração real)
```

---

### Task 1: Modelo, schema, tempo e animação

**Files:**
- Create: `src/shared/editor/project.ts`, `schema.ts`, `time.ts`, `anim.ts`, `ids.ts`, `factory.ts`
- Test: `src/shared/editor/anim.test.ts`, `schema.test.ts`, `time.test.ts`
- Modify: `package.json` (adicionar `immer@^11`)

**Interfaces — Produces** (todas as tasks seguintes dependem disto; copiar exatamente):

```ts
// project.ts
export type Us = number
export type Ease = 'linear' | 'hold' | 'in' | 'out' | 'inOut' | { bezier: [number, number, number, number] }
export interface Keyframe<T> { tUs: Us; value: T; ease: Ease }
export interface Anim<T> { value: T; keys?: Keyframe<T>[] }
export type AssetKind = 'video' | 'audio' | 'image'
export type SessionStream = 'screen' | 'webcam' | 'mic' | 'system'
export type AssetSource =
  | { type: 'session'; sessionId: string; stream: SessionStream }
  | { type: 'file'; path: string; size: number; mtimeMs: number }
  | { type: 'generated'; file: string }
export interface AssetVideoInfo { width: number; height: number; fps: number; codec: string; rotation: 0 | 90 | 180 | 270; decodable: boolean; gopUs: number }
export interface AssetAudioInfo { channels: number; sampleRate: number; codec: string }
export interface Asset {
  id: string; name: string; kind: AssetKind; source: AssetSource
  durationUs: Us | null
  video?: AssetVideoInfo; audio?: AssetAudioInfo
  proxy?: string; intermediate?: string; filmstrip?: string; peaks?: string
  status: 'ready' | 'processing' | 'missing' | 'error'; error?: string
}
export type AnimPreset = 'fade' | 'slideL' | 'slideR' | 'slideU' | 'slideD' | 'zoom' | 'pop'
export interface Transform { x: Anim<number>; y: Anim<number>; scale: Anim<number>; rotation: Anim<number>; opacity: Anim<number> }
export interface VisualProps {
  transform: Transform
  crop: { l: number; t: number; r: number; b: number }
  fit: 'contain' | 'cover' | 'fill'
  fadeInUs: Us; fadeOutUs: Us
  animIn?: { preset: AnimPreset; durationUs: Us }; animOut?: { preset: AnimPreset; durationUs: Us }
  adjust?: { brightness: number; contrast: number; saturation: number }
  shape?: 'rect' | 'rounded' | 'circle'; radius?: number
  border?: { width: number; color: string }
  mirror?: boolean
}
export interface AudioProps { enabled: boolean; volume: Anim<number>; fadeInUs: Us; fadeOutUs: Us; preservePitch: boolean; denoise: boolean; normalize: boolean }
export type TransitionKind = 'crossfade' | 'dipBlack' | 'dipWhite' | 'slideL' | 'slideR' | 'slideU' | 'slideD' | 'wipeL' | 'wipeR' | 'zoomIn' | 'blur'
export interface Transition { kind: TransitionKind; durationUs: Us }
export interface ItemBase { id: string; startUs: Us; durationUs: Us; name?: string; linkId?: string }
export interface MediaItem extends ItemBase {
  type: 'media'; assetId: string; inUs: Us; speed: number; reverse: boolean
  freeze?: { atUs: Us }
  audio: AudioProps; visual?: VisualProps; transitionIn?: Transition
}
export interface TextStyle { font: string; size: number; weight: number; color: string; background?: string; stroke?: { width: number; color: string }; shadow?: boolean; align: 'left' | 'center' | 'right'; lineHeight: number }
export interface TextItem extends ItemBase { type: 'text'; text: string; style: TextStyle; visual: VisualProps; transitionIn?: Transition }
export interface ShapeItem extends ItemBase { type: 'shape'; shape: 'rect' | 'ellipse' | 'arrow'; fill: string; stroke: string; strokeWidth: number; visual: VisualProps }
export interface EffectRegion { shape: 'rect' | 'ellipse'; x: Anim<number>; y: Anim<number>; w: Anim<number>; h: Anim<number>; rotation: Anim<number> }
export interface EffectItem extends ItemBase {
  type: 'effect'; effect: 'blur' | 'pixelate' | 'solid'; region: EffectRegion
  strength: Anim<number>; feather: number; color: string; invert: boolean; scope: 'below' | 'track'
}
export interface AnnotationsItem extends ItemBase { type: 'annotations'; sessionId: string; inUs: Us }
export type Item = MediaItem | TextItem | ShapeItem | EffectItem | AnnotationsItem
export type TrackKind = 'video' | 'audio'
export interface Track { id: string; kind: TrackKind; name: string; muted: boolean; hidden: boolean; locked: boolean; volume: number; role?: 'voice' | 'music' | 'sfx'; items: Item[] }
export interface Marker { id: string; tUs: Us; label: string; color: string }
export interface ProjectCanvas { width: number; height: number; fps: number; background: string }
export interface Project {
  version: 1; id: string; name: string; createdAt: string; updatedAt: string
  canvas: ProjectCanvas; assets: Asset[]; tracks: Track[]; markers: Marker[]
  originSessionId?: string
}
export const MIN_ITEM_US = 33_334   // ~1 quadro a 30 fps; nenhuma operação cria item menor
export const MIN_SPEED = 0.1, MAX_SPEED = 16
```

```ts
// time.ts
export const msToUs = (ms: number): Us => Math.round(ms * 1000)
export const usToMs = (us: Us): number => us / 1000
export const usToSec = (us: Us): number => us / 1e6
export const secToUs = (s: number): Us => Math.round(s * 1e6)
export const frameDurUs = (fps: number): Us => Math.round(1e6 / fps)
export const usToFrame = (us: Us, fps: number): number => Math.floor((us * fps) / 1e6 + 1e-6)
export const frameToUs = (frame: number, fps: number): Us => Math.round((frame * 1e6) / fps)
export const snapToFrame = (us: Us, fps: number): Us => frameToUs(Math.round((us * fps) / 1e6), fps)
export const itemEndUs = (it: { startUs: Us; durationUs: Us }): Us => it.startUs + it.durationUs
export function formatTimecodeUs(us: Us, fps: number): string // "HH:MM:SS:FF" (sem horas se < 1h → "MM:SS:FF")
```

```ts
// anim.ts
export function easeValue(ease: Ease, p: number): number           // p∈[0,1] → [0,1]; hold → 0 até p<1
export function evalAnim(a: Anim<number>, tUs: Us): number           // sem keys → value; antes do 1º key → 1º; depois do último → último; entre → interp pelo ease do key ANTERIOR
export function hasKeys(a: Anim<number>): boolean
export function setKey(a: Anim<number>, tUs: Us, value: number, ease?: Ease): Anim<number>  // substitui se existir key a ±1 µs; mantém ordenado
export function removeKey(a: Anim<number>, tUs: Us): Anim<number>   // remove key a ±1 µs; se ficar vazio, value = valor removido e keys undefined
export function setValue(a: Anim<number>, tUs: Us, value: number): Anim<number> // sem keys → value; com keys → setKey(tUs)
export function shiftKeys<T>(a: Anim<T>, deltaUs: Us): Anim<T>       // usado no split
export function sliceKeys(a: Anim<number>, fromUs: Us, toUs: Us): Anim<number> // mantém keys em [from,to], reancora em 0, insere key de borda com valor avaliado se houver keys fora
```

```ts
// ids.ts
export function newId(prefix = ''): string  // crypto.randomUUID() se existir, senão Math.random base36; prefixo opcional
// factory.ts
export function defaultTransform(): Transform     // x .5, y .5, scale 1, rotation 0, opacity 1
export function defaultVisual(): VisualProps      // crop 0s, fit 'contain', fades 0
export function defaultAudio(): AudioProps        // enabled, volume 1, fades 0, preservePitch true, denoise false, normalize false
export function createEmptyProject(name: string, canvas?: Partial<ProjectCanvas>): Project  // 1920×1080@30 '#000000'; tracks: [Vídeo 1 (video), Áudio 1 (audio)]
export function createMediaItem(asset: Asset, startUs: Us, trackKind: TrackKind): MediaItem   // imagem → 5 s; visual só se trackKind==='video'
```

```ts
// schema.ts
export const ProjectSchema: z.ZodType<Project>
export function parseProject(json: unknown): Project               // migrateProject → ProjectSchema.parse; lança erro legível
export function migrateProject(json: unknown): unknown              // hoje identidade para version 1; lança se version > 1
export function validateProject(p: Project): string[]               // invariantes semânticas: sobreposição na faixa, durationUs ≥ MIN_ITEM_US, inUs+durationUs*speed ≤ asset.durationUs (+1 frame de tolerância), keys ordenados e dentro de [0,durationUs], assetId existe, item visual só em faixa video
```

- [ ] **Step 1: Instalar immer** — `npm i -D immer@^11` (o repo põe tudo em devDependencies porque o bundle do renderer é empacotado).
- [ ] **Step 2: Escrever testes que falham** (`anim.test.ts`):

```ts
import { describe, expect, it } from 'vitest'
import { evalAnim, easeValue, setKey, removeKey, sliceKeys, setValue } from './anim'
const a = (keys: [number, number][]) => ({ value: 0, keys: keys.map(([tUs, value]) => ({ tUs, value, ease: 'linear' as const })) })
describe('anim', () => {
  it('constante sem keys', () => expect(evalAnim({ value: 3 }, 999)).toBe(3))
  it('clamp antes/depois', () => { const x = a([[100, 1], [200, 2]]); expect(evalAnim(x, 0)).toBe(1); expect(evalAnim(x, 500)).toBe(2) })
  it('linear no meio', () => expect(evalAnim(a([[0, 0], [100, 10]]), 25)).toBeCloseTo(2.5))
  it('hold segura até o próximo key', () => expect(evalAnim({ value: 0, keys: [{ tUs: 0, value: 1, ease: 'hold' }, { tUs: 100, value: 5, ease: 'linear' }] }, 99)).toBe(1))
  it('inOut é simétrico', () => { expect(easeValue('inOut', 0.5)).toBeCloseTo(0.5); expect(easeValue('inOut', 0.25)).toBeLessThan(0.25) })
  it('bezier linear equivale a linear', () => expect(easeValue({ bezier: [0, 0, 1, 1] }, 0.3)).toBeCloseTo(0.3, 3))
  it('setKey substitui e ordena', () => { const x = setKey(setKey({ value: 0 }, 200, 2), 100, 1); expect(x.keys!.map((k) => k.tUs)).toEqual([100, 200]); expect(setKey(x, 100, 9).keys![0].value).toBe(9) })
  it('removeKey do último devolve constante', () => { const x = removeKey(setKey({ value: 0 }, 50, 7), 50); expect(x.keys).toBeUndefined(); expect(x.value).toBe(7) })
  it('setValue sem keys altera value', () => expect(setValue({ value: 1 }, 10, 4)).toEqual({ value: 4 }))
  it('sliceKeys reancora e cria bordas', () => {
    const s = sliceKeys(a([[0, 0], [100, 10]]), 50, 100)
    expect(s.keys!.map((k) => [k.tUs, k.value])).toEqual([[0, 5], [50, 10]])
  })
})
```

`time.test.ts`: `snapToFrame(16_000, 30)` → `0`, `snapToFrame(17_000,30)` → `33_333`; `usToFrame(frameToUs(123,30),30)` → `123`; `formatTimecodeUs(61_500_000, 30)` → `"01:01:15"`; `formatTimecodeUs(3_600_000_000,30)` → `"01:00:00:00"`.

`schema.test.ts`: `parseProject(createEmptyProject('x'))` round-trip; `parseProject({...p, version: 2})` lança; `validateProject` detecta sobreposição (dois itens 0–1 s e 0,5–1,5 s na mesma faixa) e retorna mensagem contendo `sobrepõe`; item com `inUs + durationUs*speed` > duração do asset gera mensagem contendo `excede`.

- [ ] **Step 3: Rodar e ver falhar** — `npx vitest run src/shared/editor` → FAIL (módulos inexistentes).
- [ ] **Step 4: Implementar** `project.ts` (tipos acima), `time.ts`, `anim.ts` (bezier por Newton-Raphson 8 iterações + bisseção como em CSS `cubic-bezier`; `in` = cubic (p³), `out` = 1−(1−p)³, `inOut` = p<.5 ? 4p³ : 1−(−2p+2)³/2), `ids.ts`, `factory.ts`, `schema.ts` (zod espelhando os tipos; `Anim` como `z.object({value, keys: z.array(...).optional()})`; `Ease` como union de enum e `{bezier: tuple}`).
- [ ] **Step 5: Rodar** `npx vitest run src/shared/editor` → PASS; `npm run typecheck` → OK.
- [ ] **Step 6: Commit** `feat(editor): modelo de projeto, schema, tempo e animação`.

---

### Task 2: Operações de edição e snapping

**Files:** Create `src/shared/editor/ops.ts`, `snap.ts`; Test `ops.test.ts`, `snap.test.ts`

**Interfaces — Consumes:** Task 1. **Produces:**

```ts
// ops.ts — todas puras: (project, ...) => Project; lançam EditError (class com .code) quando a operação é inválida
export class EditError extends Error { constructor(public code: 'overlap' | 'locked' | 'bounds' | 'notFound' | 'invalid', msg: string) }
export function findItem(p: Project, itemId: string): { track: Track; item: Item; trackIndex: number; itemIndex: number } | null
export function linkedIds(p: Project, itemId: string): string[]           // inclui o próprio; vazio se não existir
export function addAsset(p: Project, a: Asset): Project
export function updateAsset(p: Project, id: string, patch: Partial<Asset>): Project
export function removeAsset(p: Project, id: string): Project              // remove itens que o usam
export function addTrack(p: Project, kind: TrackKind, index?: number, name?: string): { project: Project; trackId: string }
export function removeTrack(p: Project, trackId: string): Project
export function moveTrack(p: Project, trackId: string, toIndex: number): Project
export function updateTrack(p: Project, trackId: string, patch: Partial<Omit<Track, 'id' | 'items' | 'kind'>>): Project
export type InsertMode = 'overwrite' | 'insert'
export function insertItems(p: Project, trackId: string, items: Item[], mode: InsertMode): Project
//   overwrite: recorta/divide o que estiver embaixo; insert: empurra tudo a partir de items[0].startUs pela soma das durações (todas as faixas desbloqueadas — ripple global para manter sincronia)
export function addMediaFromAsset(p: Project, assetId: string, atUs: Us, opts?: { videoTrackId?: string; audioTrackId?: string; mode?: InsertMode }): { project: Project; itemIds: string[] }
//   vídeo com áudio → item na faixa de vídeo + item de áudio vinculado (mesmo linkId, visual undefined no de áudio, audio.enabled no de áudio e audio.enabled=false no de vídeo); cria faixas se necessário
export function splitAt(p: Project, itemIds: string[] | 'all', atUs: Us): Project   // divide os itens (e vinculados) que contêm atUs (estritamente dentro, com ≥ MIN_ITEM_US dos dois lados); keyframes repartidos com sliceKeys; transitionIn fica no 1º pedaço; novos ids; linkId novo para os pedaços da direita (mantendo vínculo entre eles)
export function trimItem(p: Project, itemId: string, edge: 'start' | 'end', toUs: Us, opts?: { ripple?: boolean; includeLinked?: boolean }): Project
//   start: muda startUs e inUs (inUs += delta*speed), limitado por inUs ≥ 0 e vizinho anterior; end: muda durationUs limitado pela fonte e pelo próximo vizinho; ripple desloca os itens posteriores (todas as faixas) pela diferença; imagem/texto/efeito sem limite de fonte
export function moveItems(p: Project, itemIds: string[], deltaUs: Us, opts?: { toTrackId?: string; includeLinked?: boolean; mode?: InsertMode }): Project
//   default includeLinked true; startUs < 0 é limitado a 0; sobreposição no destino → mode 'overwrite' recorta os de baixo; sem mode → EditError('overlap')
export function deleteItems(p: Project, itemIds: string[], opts?: { ripple?: boolean; includeLinked?: boolean }): Project
//   ripple: fecha o buraco deslocando itens posteriores das faixas afetadas E das outras faixas desbloqueadas somente se o intervalo inteiro estiver vazio nelas (comportamento CapCut: só fecha se não causar dessincronia); retorna com o buraco se não for seguro
export function deleteRange(p: Project, fromUs: Us, toUs: Us, opts?: { trackIds?: string[] }): Project // apaga [from,to) em todas as faixas desbloqueadas (ou nas dadas) e desloca tudo depois de toUs por −(to−from); itens que cruzam são divididos
export function detachAudio(p: Project, itemId: string): Project      // item de vídeo com áudio próprio: cria item de áudio na faixa de áudio livre (cria faixa) com mesmo tempo, desativa audio no vídeo, linkId comum; se já vinculado, apenas remove o linkId (desvincula)
export function linkItems(p: Project, itemIds: string[]): Project
export function unlinkItems(p: Project, itemIds: string[]): Project
export function setSpeed(p: Project, itemId: string, speed: number, opts?: { ripple?: boolean }): Project // clamp MIN/MAX; durationUs = round(durationUs*oldSpeed/speed); keyframes escalados no tempo; vinculados recebem a mesma velocidade; colisão com próximo item → ripple (default true) desloca posteriores
export function updateItem<T extends Item>(p: Project, itemId: string, recipe: (draft: T) => void): Project // via immer produce; valida duração ≥ MIN_ITEM_US
export function duplicateItems(p: Project, itemIds: string[], atUs?: Us): { project: Project; itemIds: string[] }
export function closeGaps(p: Project, trackId: string): Project
export function addMarker(p: Project, tUs: Us, label?: string): Project
export function projectDurationUs(p: Project): Us                      // max fim de item de faixas não ocultas; 0 se vazio
```

```ts
// snap.ts
export interface SnapPoint { us: Us; kind: 'playhead' | 'itemStart' | 'itemEnd' | 'marker' | 'zero' }
export function snapPoints(p: Project, playheadUs: Us, excludeItemIds: string[]): SnapPoint[]
export function snapDelta(candidatesUs: Us[], points: SnapPoint[], toleranceUs: Us): { deltaUs: Us; point: SnapPoint | null } // menor ajuste que encaixa qualquer candidato (início/fim do bloco movido)
```

- [ ] **Step 1: Testes que falham** — `ops.test.ts` com um helper de fixture:

```ts
import { describe, expect, it } from 'vitest'
import { createEmptyProject } from './factory'
import type { Asset, MediaItem, Project } from './project'
import * as ops from './ops'
import { validateProject } from './schema'
const S = 1_000_000
const vid = (id = 'a1', dur = 10 * S): Asset => ({ id, name: id, kind: 'video', source: { type: 'file', path: `C:/${id}.mp4`, size: 1, mtimeMs: 1 }, durationUs: dur, video: { width: 1920, height: 1080, fps: 30, codec: 'avc1', rotation: 0, decodable: true, gopUs: S }, audio: { channels: 2, sampleRate: 48000, codec: 'mp4a' }, status: 'ready' })
function base(): { p: Project; v: string; a: string } {
  let p = ops.addAsset(createEmptyProject('t'), vid())
  const r = ops.addMediaFromAsset(p, 'a1', 0); p = r.project
  return { p, v: r.itemIds[0], a: r.itemIds[1] }
}
const items = (p: Project, ti: number) => p.tracks[ti].items as MediaItem[]
describe('ops', () => {
  it('addMediaFromAsset cria vídeo + áudio vinculados', () => {
    const { p } = base()
    expect(items(p, 0)).toHaveLength(1); expect(items(p, 1)).toHaveLength(1)
    expect(items(p, 0)[0].linkId).toBeDefined(); expect(items(p, 0)[0].linkId).toBe(items(p, 1)[0].linkId)
    expect(items(p, 0)[0].audio.enabled).toBe(false); expect(items(p, 1)[0].visual).toBeUndefined()
    expect(validateProject(p)).toEqual([])
  })
  it('splitAt divide vídeo e áudio vinculados', () => {
    const { p, v } = base(); const q = ops.splitAt(p, [v], 4 * S)
    expect(items(q, 0).map((i) => [i.startUs, i.durationUs, i.inUs])).toEqual([[0, 4 * S, 0], [4 * S, 6 * S, 4 * S]])
    expect(items(q, 1)).toHaveLength(2)
    expect(items(q, 0)[1].linkId).toBe(items(q, 1)[1].linkId); expect(items(q, 0)[1].linkId).not.toBe(items(q, 0)[0].linkId)
  })
  it('splitAt na borda não cria item vazio', () => { const { p, v } = base(); expect(ops.splitAt(p, [v], 0)).toEqual(p); expect(ops.splitAt(p, [v], 10 * S)).toEqual(p) })
  it('splitAt com speed 2 calcula inUs na fonte', () => {
    const { p, v } = base(); const q = ops.splitAt(ops.setSpeed(p, v, 2), [v], 2 * S)
    expect(items(q, 0)[1].inUs).toBe(4 * S); expect(items(q, 0)[1].durationUs).toBe(3 * S)
  })
  it('deleteRange apaga o meio e fecha o buraco em todas as faixas', () => {
    const { p } = base(); const q = ops.deleteRange(p, 2 * S, 5 * S)
    expect(items(q, 0).map((i) => [i.startUs, i.durationUs, i.inUs])).toEqual([[0, 2 * S, 0], [2 * S, 5 * S, 5 * S]])
    expect(ops.projectDurationUs(q)).toBe(7 * S); expect(validateProject(q)).toEqual([])
  })
  it('trimItem start respeita inUs ≥ 0 e move vinculados', () => {
    const { p, v } = base(); const q = ops.trimItem(p, v, 'start', 3 * S)
    expect(items(q, 0)[0]).toMatchObject({ startUs: 3 * S, inUs: 3 * S, durationUs: 7 * S }); expect(items(q, 1)[0]).toMatchObject({ startUs: 3 * S, inUs: 3 * S })
    const back = ops.trimItem(q, v, 'start', -5 * S); expect(items(back, 0)[0]).toMatchObject({ startUs: 0, inUs: 0 })
  })
  it('trimItem end não passa da fonte', () => { const { p, v } = base(); expect(items(ops.trimItem(p, v, 'end', 20 * S), 0)[0].durationUs).toBe(10 * S) })
  it('moveItems sobre outro item sem modo lança overlap; com overwrite recorta', () => {
    let { p } = base(); p = ops.addMediaFromAsset(p, 'a1', 10 * S).project
    const second = items(p, 0)[1].id
    expect(() => ops.moveItems(p, [second], -5 * S)).toThrow(ops.EditError)
    const q = ops.moveItems(p, [second], -5 * S, { mode: 'overwrite' })
    expect(items(q, 0).map((i) => [i.startUs, i.durationUs])).toEqual([[0, 5 * S], [5 * S, 10 * S]]); expect(validateProject(q)).toEqual([])
  })
  it('deleteItems ripple fecha buraco', () => {
    let { p, v } = base(); p = ops.addMediaFromAsset(p, 'a1', 10 * S).project
    const q = ops.deleteItems(p, [v], { ripple: true }); expect(items(q, 0)[0].startUs).toBe(0); expect(items(q, 1)[0].startUs).toBe(0)
  })
  it('detachAudio em item já vinculado desvincula', () => { const { p, v } = base(); const q = ops.detachAudio(p, v); expect(items(q, 0)[0].linkId).toBeUndefined(); expect(items(q, 1)[0].linkId).toBeUndefined() })
  it('setSpeed 0.5 dobra a duração e empurra posteriores', () => {
    let { p, v } = base(); p = ops.addMediaFromAsset(p, 'a1', 10 * S).project
    const q = ops.setSpeed(p, v, 0.5); expect(items(q, 0)[0].durationUs).toBe(20 * S); expect(items(q, 0)[1].startUs).toBe(20 * S); expect(validateProject(q)).toEqual([])
  })
  it('faixa bloqueada recusa edição', () => { const { p, v } = base(); const q = ops.updateTrack(p, p.tracks[0].id, { locked: true }); expect(() => ops.deleteItems(q, [v], { includeLinked: false })).toThrow(/bloquead/) })
})
```

`snap.test.ts`: pontos incluem 0, playhead, bordas e marcadores, exceto itens excluídos; `snapDelta([1_000_000, 3_000_000], [{us: 2_950_000, kind:'itemEnd'}], 100_000)` → `deltaUs: -50_000`; fora da tolerância → `{deltaUs: 0, point: null}`.

- [ ] **Step 2:** `npx vitest run src/shared/editor/ops.test.ts src/shared/editor/snap.test.ts` → FAIL.
- [ ] **Step 3: Implementar** com `produce` do immer; manter itens ordenados por `startUs` após cada operação (`sortItems`); helper interno `assertUnlocked(track)` lança `EditError('locked', 'Faixa bloqueada: <nome>')`; helper `overwriteRange(track, from, to)` recorta/divide itens existentes; `keyframes` de `visual.transform.*`, `audio.volume`, `effect.region.*`, `effect.strength` passam por `sliceKeys` no split e por escala de tempo no `setSpeed`.
- [ ] **Step 4:** testes PASS + `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(editor): operações de edição (split, trim, move, ripple, deleteRange, vínculo, speed) e snapping`.

---

### Task 3: resolveFrame e planAudio

**Files:** Create `src/shared/editor/resolve.ts`, `audioPlan.ts`; Test `resolve.test.ts`, `audioPlan.test.ts`

**Produces:**

```ts
// resolve.ts
export function sourceTimeUs(item: MediaItem, asset: Asset, tUs: Us): Us
//   local = tUs - item.startUs; freeze → freeze.atUs; reverse → inUs + (durationUs - local)*speed - 1 frame; senão inUs + local*speed; clamp [0, asset.durationUs-1]
export interface MediaLayer {
  kind: 'media'; itemId: string; trackId: string; assetId: string; srcUs: Us | null /* null = imagem */
  rect: { cx: number; cy: number; scale: number; rotation: number }  // já com animações de entrada/saída aplicadas
  opacity: number                                                   // transform.opacity × fades × animIn/Out
  crop: VisualProps['crop']; fit: VisualProps['fit']; shape: 'rect' | 'rounded' | 'circle'; radius: number
  border?: { width: number; color: string }; adjust?: VisualProps['adjust']; mirror: boolean
}
export interface AnnotationsLayer { kind: 'annotations'; itemId: string; sessionId: string; sessionMs: number }
export interface EffectLayer { kind: 'effect'; itemId: string; effect: EffectItem['effect']; region: { shape: 'rect'|'ellipse'; x: number; y: number; w: number; h: number; rotation: number }; strength: number; feather: number; color: string; invert: boolean; scope: 'below' | 'track' }
export interface TextLayer { kind: 'text'; itemId: string; text: string; style: TextStyle; rect: MediaLayer['rect']; opacity: number }
export interface ShapeLayer { kind: 'shape'; itemId: string; item: ShapeItem; rect: MediaLayer['rect']; opacity: number }
export interface TransitionLayer { kind: 'transition'; transition: TransitionKind; progress: number; from: Layer[]; to: Layer[] }
export type Layer = MediaLayer | AnnotationsLayer | EffectLayer | TextLayer | ShapeLayer | TransitionLayer
export function resolveFrame(p: Project, tUs: Us): Layer[]
//   percorre faixas de vídeo na ordem (índice 0 = fundo), ignora hidden; para cada faixa pega o item ativo em [start, end); assets missing/error → MediaLayer com srcUs e assetId (o compositor desenha placeholder); fadeIn/Out multiplicam opacity linearmente; animIn 'fade' idem, 'slideX' desloca cx/cy de ±1, 'zoom' escala 0.8→1, 'pop' 0.6→1.05→1 (F4 completa; F1 implementa fade e slides)
//   transições: se o item ativo tem transitionIn e tUs < start + duration/2... (F5) — em F1 apenas tipo exportado, sem geração
export function activeItemsAt(p: Project, tUs: Us): { track: Track; item: Item }[]
```

```ts
// audioPlan.ts
export interface GainPoint { tUs: Us; gain: number }    // tempo de timeline absoluto; linear entre pontos
export interface AudioSegment { itemId: string; assetId: string; startUs: Us; durationUs: Us; srcInUs: Us; speed: number; reverse: boolean; preservePitch: boolean; gain: GainPoint[] }
export function planAudio(p: Project): AudioSegment[]
//   itens media com audio.enabled em faixas não mudas e assets com áudio; gain = trackVolume × volume(anim) × fades (rampa linear); envelope com pontos no início, fim de fadeIn, keyframes de volume, início de fadeOut, fim
export function gainAt(seg: AudioSegment, tUs: Us): number
```

- [ ] **Step 1: Testes que falham:**
  - `sourceTimeUs` com speed 2, inUs 1 s, t = start+0,5 s → 2 s; reverse com duração 4 s, t=start → ≈ inUs+4 s−1 quadro; freeze → `atUs`.
  - `resolveFrame` com duas faixas de vídeo sobrepostas devolve `[fundo, topo]`; faixa `hidden` some; fora de qualquer item → `[]`; fadeIn 1 s em t=start+0,25 s → opacity 0,25.
  - item `annotations` vira `AnnotationsLayer` com `sessionMs = (inUs + local)/1000`.
  - `planAudio`: faixa muda some; volume de faixa 0,5 × item 0,5 → ganho 0,25; fadeIn 1 s: `gainAt(seg, start)` = 0, `gainAt(seg, start+0,5 s)` = 0,5; keyframes de volume aparecem no envelope.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS + typecheck. **Step 5: Commit** `feat(editor): resolveFrame e plano de áudio`.

---

### Task 4: Gravação → projeto

**Files:** Create `src/shared/editor/fromSession.ts`; Test `fromSession.test.ts`

**Produces:** `export function projectFromSession(session: Session, opts: { projectId: string; name: string; now: string }): Project`

Regras (spec §4 "Gravação → projeto"): canvas = `session.video.width×height@fps` (fps arredondado; mínimo 1×1); assets `screen`/`webcam`/`mic`/`system` (`type:'session'`, `durationUs = msToUs(session.durationMs)`, decodable true, gopUs 1 s, rotation 0); faixas na ordem: "Tela" (video), "Webcam" (video, só se houver webcam), "Anotações" (video, só se houver strokes) com `AnnotationsItem`, "Microfone" (audio, role 'voice'), "Sistema" (audio, role 'sfx'); itens de áudio vinculados ao item da tela (`linkId` comum). Webcam: `visual.shape` = shape do 1º PipKeyframe (`circle`→`circle`, `rounded`→`rounded`), `mirror = session.webcam.mirrored`, `fit: 'contain'`. **Regra de tamanho (vale para todo o editor):** o tamanho base de uma camada é a fonte (já cortada e rotacionada) encaixada por `fit` no quadro; `scale` multiplica esse tamanho base. Para a webcam: aspecto alvo `A = (w·W)/(h·H)` do 1º PipKeyframe (W,H = quadro); `crop` centralizado na fonte da webcam para que a fonte cortada tenha aspecto `A`; com `contain`, se `A ≥ W/H` o tamanho base tem largura W → `scale = w`, senão altura H → `scale = h`. transform x/y = centro (`x + w/2`, `y + h/2`). Se a sessão tiver PipKeyframes com aspectos diferentes, usa o do 1º (limitação documentada). Keyframes: para cada PipKeyframe i>0, key `hold` em `tMs` com valor anterior e key `linear` em `tMs+150ms` com o novo (igual a `pipRectAt` v1); `visible:false` → opacity 0 com hold. Marcadores da sessão → markers ("Marcador N", cor `#ff4d4f`).

- [ ] **Step 1: Testes que falham** usando uma `Session` fixture mínima (copiar a forma de `src/shared/schemas.test.ts`): sessão com webcam + mic + sistema + 2 strokes + PiP com 2 keyframes → 5 faixas, nomes acima, webcam com keys em `tMs` e `tMs+150ms`, `validateProject(p)` vazio; sessão só tela → 1 faixa de vídeo + 0 de áudio + nenhuma faixa vazia; sem `durationMs` → lança.
- [ ] **Step 2–4:** FAIL → implementar → PASS + typecheck. Teste extra: **para 30 instantes aleatórios**, `resolveFrame` da webcam reproduz o retângulo de `pipRectAt` (de `src/shared/compositor/pipMath.ts`) com erro < 0,5 % do quadro (garante paridade com a v1).
- [ ] **Step 5: Commit** `feat(editor): projeto a partir de gravação (paridade com PiP/anotações v1)`.

---

### Task 5: Projetos em disco, IPC e protocolo de mídia

**Files:**
- Create: `src/main/project/projectStore.ts`, test `projectStore.test.ts`
- Modify: `src/shared/ipc.ts` (domínio `project`), `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/index.ts` (instanciar store), `src/main/fileProtocol.ts`, `src/shared/types.ts` (+ `projectsDir: string | null` em Settings? **não** — usar `<pasta dos brutos>/../Projetos`, sem nova setting; expor caminho em `project.list`)

**Produces:**

```ts
// projectStore.ts
export interface ProjectSummary { id: string; name: string; updatedAt: string; durationUs: number; thumb?: string; originSessionId?: string }
export class ProjectStore {
  constructor(deps: { projectsRoot: () => string; trash: (p: string) => Promise<void>; log?: {...} })
  dirOf(id: string): string                       // valida /^[\w.-]+$/
  filePath(id: string, rel: string): string       // até 2 níveis (proxies/x.mp4, cache/strip.jpg), sem '..'
  create(p: Project): void                        // mkdir + subpastas proxies/ cache/ generated/ versions/ + save
  save(p: Project): void                          // grava project.json via tmp+rename; a cada save rotaciona versions/NNN.json (mantém 20; só grava versão se passaram ≥ 60 s desde a última)
  load(id: string): Project                       // parseProject; se falhar, tenta versions/ da mais nova para a mais antiga; lança se nenhuma
  list(): ProjectSummary[]                        // ordenado por updatedAt desc; ignora pastas inválidas
  remove(id: string): Promise<void>               // trash da pasta (nunca apaga originais importados)
  assetPath(p: Project, assetId: string, variant: 'original' | 'proxy' | 'intermediate', sessionsStore: SessionStore): string
  //  file → source.path; session → sessionsStore.filePath(sessionId, 'rec.mp4'); generated/proxy/intermediate → filePath(p.id, ...)
}
```

IPC (`IpcApi.project`): `list(): Promise<ProjectSummary[]>`, `create(p: Project): Promise<void>`, `load(id): Promise<Project>`, `save(p: Project): Promise<void>`, `remove(id): Promise<void>`, `fromSession(sessionId): Promise<Project>` (main lê a sessão, chama `projectFromSession`, cria e retorna), `pickMedia(): Promise<string[]>` (dialog de abrir arquivos com filtros da spec §8). Canais `project:list` etc.

Protocolo: `cialight-file://media/<projectId>/<assetId>?v=original|proxy|intermediate` → resolve com `assetPath` **somente** se o asset existir no `project.json` carregado (cache em memória do último load/save por projeto); `cialight-file://project/<projectId>/<rel>` → `filePath`. MIME adicionais: `.mov video/quicktime`, `.m4a audio/mp4`, `.mp3 audio/mpeg`, `.aac audio/aac`, `.flac audio/flac`, `.ogg audio/ogg`, `.opus audio/ogg`, `.webp image/webp`, `.gif image/gif`, `.bmp image/bmp`, `.avi video/x-msvideo`, `.ts video/mp2t`, `.m4v video/mp4`, `.bin application/octet-stream`. Hosts existentes (sessionId) continuam iguais.

- [ ] **Step 1: Testes que falham** (`projectStore.test.ts`, usando `os.tmpdir()` + `mkdtempSync`): create+load round-trip; `save` atômico (arquivo `.tmp` não sobra); `load` com `project.json` corrompido recupera a última versão; `list` ordena; `filePath(id,'../x')` lança; `dirOf('a/b')` lança.
- [ ] **Step 2–4:** implementar; registrar handlers; `npm test` + `npm run typecheck` PASS.
- [ ] **Step 5: Commit** `feat(editor): projetos em disco, IPC project e protocolo de mídia`.

---

### Task 6: Ingestão (probe, proxy, filmstrip, peaks)

**Files:** Create `src/main/media/probe.ts` (+test), `proxyPolicy.ts` (+test), `analysis.ts`, `ingest.ts`; Modify `src/shared/ipc.ts` (domínio `media`), preload, `src/main/ipc.ts`, `src/main/testMode.ts` (novo `CIALIGHT_TEST=ingest`), `package.json` (`test:ingest`).

**Produces:**

```ts
// probe.ts
export interface MediaInfo { durationUs: number | null; kind: AssetKind; video?: Omit<AssetVideoInfo, 'decodable'>; audio?: AssetAudioInfo; vfr: boolean; formatName: string }
export function parseFfprobe(json: unknown, path: string): MediaInfo   // puro; kind por extensão de imagem ou ausência de vídeo; rotation de side_data_list displaymatrix (−90 → 90) ou tags.rotate; fps de avg_frame_rate; vfr = |r_frame_rate − avg_frame_rate|/avg > 0.02; gopUs estimado via probeGop
export async function probe(path: string): Promise<MediaInfo>           // ffprobe -v error -print_format json -show_format -show_streams
export async function probeGopUs(path: string): Promise<number>         // ffprobe -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -read_intervals %+20 → média dos intervalos (fallback 10 s se 1 keyframe)
// proxyPolicy.ts
export type ProxyReason = 'undecodable' | 'longGop' | 'highRes' | 'vfr'
export function needsProxy(info: MediaInfo, decodable: boolean): { proxy: boolean; intermediate: boolean; reasons: ProxyReason[] }
//   undecodable → intermediate (full-res, -crf 18) e sem proxy separado; gop > 2 s, altura > 1440 ou vfr → proxy
export function proxyArgs(input: string, output: string, info: MediaInfo, encoder: HwEncoder): string[] // H.264 -g round(fps/2) -bf 0, altura 720 (ou 1080 se fonte ≤ 1080), yuv420p, AAC 128k, -fps_mode cfr quando vfr, -movflags +faststart; autorotate padrão do ffmpeg aplica a rotação
export function intermediateArgs(input: string, output: string, info: MediaInfo, encoder: HwEncoder): string[] // mesma resolução, -crf 18 (ou -cq 19 nvenc), GOP 1 s
// analysis.ts
export async function buildFilmstrip(input: string, outJpg: string, durationUs: number): Promise<{ file: string; frames: number; everyUs: number; tileW: number; tileH: number }> // 1 quadro a cada max(1 s, dur/300), altura 64, sprite horizontal (tile=Nx1)
export async function buildPeaks(input: string, outBin: string): Promise<{ file: string; samplesPerSec: 100 }> // ffmpeg -ac 1 -ar 8000 -f f32le pipe → min/max por 10 ms → Int8Array (min,max intercalados, ×127)
// ingest.ts
export interface IngestJob { projectId: string; assetId: string; step: 'probe' | 'proxy' | 'intermediate' | 'filmstrip' | 'peaks'; percent: number }
export class IngestQueue { enqueue(projectId: string, asset: Asset): void; cancel(projectId: string): void; on(ev: 'progress', fn: (j: IngestJob) => void): void; on(ev: 'done', fn: (projectId: string, assetId: string, patch: Partial<Asset>) => void): void }
//   concorrência 1 job pesado (proxy/intermediate) + 2 leves; usa runFfmpeg existente (cancelável) com encoder do lastEncoderProbe
```

IPC `media`: `import(projectId, paths: string[]): Promise<Asset[]>` (probe síncrono por arquivo + decisão; o renderer confirma `decodable` com `canDecode` antes — ver abaixo), `enqueue(projectId, assetId)`, `onProgress(cb)`, `onDone(cb)`, `relink(projectId, assetId, newPath)`. Fluxo de import: renderer chama `media.import` → main faz `probe` → devolve assets com `status:'processing'` → renderer testa `decodable` abrindo `Input` mediabunny no proxy de URL `?v=original` (`await track.canDecode()`) e chama `media.enqueue` com a informação (`media.enqueue(projectId, assetId, { decodable })`).

Ao `project.load`, main verifica `existsSync` + tamanho dos `file` assets → `status: 'missing'` quando ausentes.

- [ ] **Step 1: Testes puros que falham:** `parseFfprobe` com 3 fixtures JSON (celular H.264 com displaymatrix −90 e VFR; mp3; png) → kind/rotation/vfr/duração corretos; `needsProxy` para cada razão; `proxyArgs` contém `-g 15` para 30 fps e `scale=-2:720`.
- [ ] **Step 2: Teste de integração real** `CIALIGHT_TEST=ingest` (padrão de `src/main/testMode.ts`): gera com ffmpeg `testsrc2` 1920×1080 30 fps 6 s GOP 300 (+sine), uma versão com `-metadata:s:v rotate=90` / `-display_rotation 90`, um mp3 e um png; roda probe + needsProxy + proxy + filmstrip + peaks; verifica com ffprobe que o proxy tem GOP ≤ 0,5 s (keyframes a cada 15 quadros), altura 720, duração ±1 quadro; filmstrip existe com largura = frames×tileW; peaks tem 2×100×6 bytes ±2 %; o rotacionado tem `rotation: 90`. Script `"test:ingest": "electron-vite build && cross-env CIALIGHT_TEST=ingest CIALIGHT_RAW_DIR=test-out/raw electron ."`; sai com código 0/1.
- [ ] **Step 3–4:** implementar até `npm test`, `npm run test:ingest`, typecheck passarem.
- [ ] **Step 5: Commit** `feat(editor): ingestão de mídia (probe, proxy, intermediário, filmstrip, peaks)`.

---

### Task 7: Store do editor com histórico e transações

**Files:** Create `src/renderer/src/editor/state/history.ts` (+test), `editorStore.ts` (+test)

**Produces:**

```ts
// history.ts (puro)
export interface History<T> { past: T[]; present: T; future: T[] }
export function initHistory<T>(t: T): History<T>
export function commit<T>(h: History<T>, next: T, limit = 300): History<T>   // ignora se next === present
export function undo<T>(h: History<T>): History<T>
export function redo<T>(h: History<T>): History<T>
// editorStore.ts
export interface EditorState {
  history: History<Project>; project: Project | null           // project === history.present
  dirty: boolean; saving: boolean; lastSavedAt: number | null
  selection: string[]; playheadUs: Us; playing: boolean
  zoomPxPerSec: number; scrollUs: Us; snapping: boolean
  inUs: Us | null; outUs: Us | null
  txBase: Project | null                                       // transação aberta
  ingest: Record<string, { step: string; percent: number }>
  open(p: Project): void; close(): void
  apply(fn: (p: Project) => Project, opts?: { transient?: boolean }): boolean  // transient = dentro de transação (não grava histórico); captura EditError → toast e retorna false
  begin(): void; commitTx(): void; cancelTx(): void
  undo(): void; redo(): void; canUndo: boolean; canRedo: boolean
  select(ids: string[], mode?: 'set' | 'add' | 'toggle'): void
  setPlayhead(us: Us): void; setPlaying(b: boolean): void; setZoom(pxPerSec: number, anchorUs?: Us): void; setScroll(us: Us): void
  setInOut(inUs: Us | null, outUs: Us | null): void; toggleSnapping(): void
}
export const useEditorStore: UseBoundStore<StoreApi<EditorState>>
export function startAutosave(save: (p: Project) => Promise<void>): () => void  // subscribe; debounce 1 s após mudança de project; flush ao fechar
```

- [ ] **Step 1: Testes que falham:** `history.test.ts` (commit/undo/redo/limite/futuro limpo após commit); `editorStore.test.ts` (zustand roda em node): `apply` gera 1 entrada; `begin` + 200× `apply(transient)` + `commitTx` → `undo` volta ao estado anterior ao `begin` em **um** passo; `cancelTx` restaura `txBase`; `apply` que lança `EditError` retorna false e não altera; autosave com `vi.useFakeTimers` chama `save` uma vez após 1 s de 5 mudanças.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(editor): store do editor com histórico, transações e autosave`.

---

### Task 8: Render worker (decoders + compositor WebGL2)

**Files:** Create `engine/protocol.ts`, `engine/decoderPool.ts`, `engine/compositor/{gl.ts,shaders.ts,compositor.ts,matrix.ts}` (+`matrix.test.ts`), `engine/render.worker.ts`, `engine/RenderClient.ts`; Modify `src/main/index.ts` (`app.commandLine.appendSwitch('disable-features', 'ReclaimInactiveWebCodecs')` antes de `app.whenReady`), `package.json` (`twgl.js` se o F0 confirmou).

**Ler antes:** `docs/research/2026-10-01-editor-spike-results.md` (API exata de upload de `VideoSample`/`VideoFrame` e números).

**Produces:**

```ts
// protocol.ts
export type RenderIn =
  | { t: 'init'; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  | { t: 'project'; project: Project; mediaUrls: Record<string, { original: string; proxy?: string }>; useProxy: boolean }
  | { t: 'resize'; width: number; height: number }
  | { t: 'frame'; tUs: Us; seq: number; playing: boolean }     // pede render do quadro tUs
  | { t: 'overlay'; selection: string[]; guides: boolean }       // contorno do selecionado (só preview)
  | { t: 'exportStart'; width: number; height: number; fps: number; fromUs: Us; toUs: Us; jobId: string; video: { codec: 'avc' | 'hevc'; bitrate: number; hw: 'prefer-hardware' | 'prefer-software' } }
  | { t: 'exportCancel'; jobId: string } | { t: 'chunkAck'; seq: number }
export type RenderOut =
  | { t: 'ready' } | { t: 'rendered'; seq: number; tUs: Us; ms: number; missing: string[] }
  | { t: 'error'; message: string; fatal: boolean }
  | { t: 'exportFrame'; jobId: string; frame: number; total: number } // progresso
  | { t: 'exportVideoChunk'; jobId: string; seq: number; data: Uint8Array; meta: unknown }  // ver Task 12 (encoder vive no worker)
  | { t: 'exportDone'; jobId: string } | { t: 'exportError'; jobId: string; message: string }
// matrix.ts (puro)
export type Mat3 = Float32Array
export function layerMatrix(layer: { rect: { cx: number; cy: number; scale: number; rotation: number }; fit: 'contain'|'cover'|'fill'; crop: {l:number;t:number;r:number;b:number} }, src: { w: number; h: number; rotation: 0|90|180|270 }, canvas: { w: number; h: number }): { mat: Mat3; uv: [number, number, number, number] }
//   tamanho base = fit da fonte (já cortada e rotacionada) no canvas; escala; rotação em graus em torno do centro; saída em clip space (−1..1, y para cima)
// decoderPool.ts
export class DecoderPool {
  constructor(maxLive = 6)
  setSources(urls: Record<string, string>): void                 // assetId → URL (proxy ou original)
  async frameAt(assetId: string, srcUs: Us, sequential: boolean): Promise<VideoSample | null> // sequencial reaproveita iterador; seek usa getSample; null se fora/erro
  async image(assetId: string): Promise<ImageBitmap | null>
  prefetch(assetId: string, srcUs: Us): void
  dispose(): void
}
// compositor.ts
export class Compositor {
  constructor(canvas: OffscreenCanvas)
  resize(w: number, h: number): void
  draw(layers: Layer[], sources: Map<string, TexImageSource | VideoFrame | null>, background: string, extra?: { annotations?: (layer: AnnotationsLayer) => OffscreenCanvas | null; selectionOutline?: { itemId: string }[] }): void
  readPixels(x: number, y: number, w: number, h: number): Uint8Array  // testes
}
```

Shaders F1: `media` (textura, matriz, uv/crop, opacity, adjust brilho/contraste/saturação, máscara `rounded`/`circle` com antialias por `fwidth`, borda), `solid` (placeholder "mídia indisponível": xadrez cinza). Efeitos/transições vêm em F2/F5 — deixar `Compositor.draw` com `switch(layer.kind)` e `default:` ignorando.

Worker: em `frame`, chama `resolveFrame(project, tUs)` → coleta fontes (`frameAt` com `sequential = playing`) → `draw` → fecha samples → posta `rendered`. Se um `frame` chegar enquanto renderiza, guarda só o último (descarta intermediários). Anotações: usa `drawStrokes`/`visibleStrokesAt` existentes num `OffscreenCanvas` 2D (sessão carregada via `fetch('cialight-file://<sessionId>/session.json')`).

`RenderClient.ts` (main thread): cria o worker (`new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' })`), `transferControlToOffscreen`, API `setProject`, `requestFrame(tUs, playing): Promise<RenderOut>`, `dispose`.

- [ ] **Step 1: Teste puro que falha** `matrix.test.ts`: fonte 1920×1080 em canvas 1080×1920 com `contain` → largura ocupa 100 %, altura 1080/1920×(1080/1920); `cover` cobre; rotação 90 da fonte troca w/h; crop l=0.25 desloca uv para 0.25.
- [ ] **Step 2: Implementar** módulos acima.
- [ ] **Step 3: Teste de integração real** em `src/main/editorTestMode.ts` (`CIALIGHT_TEST=editor-render`): gera `testsrc2` + uma imagem vermelha; abre janela oculta carregando `index.html#editor-test` (rota que monta `RenderClient` sem UI — criar `src/renderer/src/editor/test/renderHarness.ts` acionado pelo hash); projeto com 2 faixas (vídeo cheio + imagem vermelha `scale 0.25` no canto `cx .875 cy .125`, `shape:'circle'`); pede quadro em t=1 s; `readPixels` no centro do círculo = vermelho (R>200,G<40,B<40); no canto do bounding box fora do círculo ≠ vermelho; asset com caminho inexistente → camada placeholder, sem exceção. Resultado em JSON → main valida → exit 0/1. Script `test:editor`.
- [ ] **Step 4:** `npm test`, `npm run test:editor`, typecheck PASS.
- [ ] **Step 5: Commit** `feat(editor): render worker com WebCodecs + compositor WebGL2`.

---

### Task 9: Motor de áudio e controle de reprodução

**Files:** Create `engine/audio/mixer.ts` (+test), `engine/audio/audio.worker.ts`, `engine/audio/AudioClient.ts`, `engine/PlaybackController.ts`

**Produces:**

```ts
// mixer.ts (puro, Float32 estéreo intercalado 48 kHz)
export const SR = 48000
export interface PcmSource { read(srcFromUs: Us, frames: number, speed: number, reverse: boolean): Float32Array /* estéreo intercalado, frames*2; zeros fora */ }
export function mixBlock(segments: AudioSegment[], fromUs: Us, frames: number, sources: Map<string, PcmSource>): Float32Array
//   para cada segmento que intersecta [fromUs, fromUs+frames/SR): calcula offset, lê frames da fonte em srcIn + (t−start)*speed, aplica gainAt por amostra (interpolado por bloco de 64 amostras), soma; limitador suave final: y = x se |x| ≤ 0.9; senão sign(x)*(0.9 + 0.1*tanh((|x|−0.9)/0.1))
export function resampleLinear(input: Float32Array, inRate: number, channels: number, outRate: number): Float32Array // → estéreo intercalado (mono duplica; >2 canais faz downmix L=avg(pares), R)
// audio.worker.ts — mensagens: {t:'project', project, mediaUrls} | {t:'render', fromUs, frames, seq} → {t:'block', seq, fromUs, pcm} (transfer)
//   PcmSource por asset: mediabunny AudioSampleSink → decodifica janela [src−0.2 s, src+bloco+0.2 s], cache LRU de 30 s por asset, reamostra para 48 kHz; speed≠1 em F1: reamostragem simples (pitch muda) — preservePitch real chega na F3
// PlaybackController.ts
export class PlaybackController {
  constructor(render: RenderClient, audio: AudioClient, store: typeof useEditorStore)
  play(): Promise<void>        // AudioContext resume; t0 = ctx.currentTime, us0 = playheadUs; agenda blocos de 100 ms com 300 ms de antecedência; rAF: tUs = us0 + (ctx.currentTime − t0 − outputLatency)·1e6 → render.requestFrame(tUs, true) e store.setPlayhead; para em projectDuration ou outUs
  pause(): void
  seek(us: Us): void           // pausa a agenda, limpa nós agendados, render.requestFrame(us, false)
  get levels(): { l: number; r: number }  // pico do último bloco (VU)
}
```

- [ ] **Step 1: Testes que falham** (`mixer.test.ts`): fonte senoidal sintética 1 kHz amplitude 0,5 em segmento com fadeIn 1 s → RMS do primeiro 100 ms < RMS de 900–1000 ms; dois segmentos de 0,8 somados → pico ≤ 1,0 (limitador) e > 0,9; segmento fora do bloco → zeros; `resampleLinear` 44,1→48 kHz de 441 amostras → 480 frames estéreo; mono duplica canais.
- [ ] **Step 2–3:** implementar.
- [ ] **Step 4: Teste real** (estende `test:editor`): harness toca 2 s de um projeto com `sine=1000` e registra `levels` > 0,1 e deriva de relógio (diferença entre `tUs` do vídeo e `ctx.currentTime`) < 1 quadro ao fim.
- [ ] **Step 5: Commit** `feat(editor): mixer de áudio, audio worker e controlador de reprodução`.

---

### Task 10: Tela do editor (estrutura, biblioteca, visualizador, inspetor) e navegação

**Files:** Create `ui/EditorScreen.tsx`, `ui/TopBar.tsx`, `ui/MediaBin.tsx`, `ui/Viewer.tsx`, `ui/Inspector/{Inspector.tsx,VideoPanel.tsx,AudioPanel.tsx,SpeedPanel.tsx,NumberField.tsx}`, `ui/ProjectsHome.tsx`, `editor/shortcuts.ts`; Modify `app/store.ts` (`Screen` += `'editor' | 'projects'`, `editorProjectId`), `app/App.tsx` (renderizar telas; `__navigate('editor:<projectId>')`), `screens/History/HistoryScreen.tsx` (botão **Editar** → `project.fromSession` → abre editor), `screens/Review/ReviewScreen.tsx` (botão **Abrir no editor**), `app/Titlebar.tsx` (entrada **Projetos**), `src/main/windows/recorderWindow.ts` (maximizar ao entrar no editor via IPC `app.setEditorMode(on)` e restaurar tamanho ao sair).

Comportamento (spec §9):
- `EditorScreen`: grid `[MediaBin 280px | Viewer flex | Inspector 320px]` em cima, `Timeline` (Task 11) embaixo com altura redimensionável (mín. 220 px, salvo em localStorage com try/catch). Monta `RenderClient`, `AudioClient`, `PlaybackController`, `startAutosave(window.api.project.save)`. Desmonta tudo ao sair (flush do autosave).
- `TopBar`: voltar (com flush), nome editável, desfazer/refazer (tooltips com atalho), indicador "Salvo há Xs / Salvando…", seletor de proporção (16:9, 9:16, 1:1, 4:5, 4:3, original da 1ª mídia) que altera `canvas` via `apply`, botão **Exportar** (abre Task 12).
- `MediaBin`: abas Mídia/Áudio/Gravações. Importar (botão `project.pickMedia`, drag-and-drop de arquivos do Explorer usando `webUtils.getPathForFile` exposto no preload); cartões com miniatura (1º tile do filmstrip), duração, badge de status (processando com % / ausente com botão "Localizar…" / erro); arrastar cartão para a timeline (dataTransfer `application/x-cialight-asset`), duplo clique adiciona no playhead (`addMediaFromAsset`). Aba Gravações lista `session.list` e importa como assets `session`.
- `Viewer`: `<canvas>` com `transferControlToOffscreen` (apenas uma vez), redimensiona com `ResizeObserver` mantendo proporção do projeto (letterbox), controles: ⏮ ◀︎quadro ▶/❚❚ quadro▶︎ ⏭, timecode atual/total (`formatTimecodeUs`), volume master, botão tela cheia. Manipulação direta do item selecionado: arrastar move (x/y), alças de canto escalam (Shift mantém centro), alça de rotação; tudo via `begin/apply(transient)/commitTx`; guias de centro com snap a 0,5 ± 1 %.
- `Inspector`: vazio → propriedades do projeto (resolução, fps, cor de fundo). Item media/vídeo → `VideoPanel` (posição X/Y %, escala %, rotação °, opacidade %, corte L/T/R/B %, ajuste, forma rect/rounded/circle + raio, borda, espelhar, fade in/out em s, botão "Redefinir"), `AudioPanel` (ativar, volume em dB −60…+12 com slider, fade in/out), `SpeedPanel` (presets 0,25/0,5/1/1,5/2/4/8×, campo livre; aviso "tom preservado chega na próxima versão" só se F3 ainda não entrou — remover na F3). `NumberField`: arrastar horizontalmente altera valor, roda do mouse, digitação com Enter, Esc cancela — todos em transação.
- `shortcuts.ts`: mapa da spec §9 aplicado com `keydown` no `EditorScreen` (ignorar quando foco em input/textarea/contenteditable).
- `ProjectsHome` (`screen: 'projects'`): **Novo projeto** (nome + proporção), lista de `project.list` com abrir/renomear/excluir (Dialog de confirmação) — e cartão "Editar uma gravação" que leva ao Histórico.

- [ ] **Step 1: Implementar** componentes.
- [ ] **Step 2: Verificação visual** via CDP: `npm run build` → `electron . --remote-debugging-port=9333` com `CIALIGHT_SCREEN=projects` e depois `__navigate('editor:<id>')` de um projeto de teste criado por `CIALIGHT_TEST`-fixture; `node scripts/qa/cdp.mjs shot docs/qa/editor-f1-*.png` em 1366×768 e 1920×1080; conferir sem sobreposição/corte de texto. Restaurar `%APPDATA%\cialight-gravador\settings.json` se alterado (ver memória do projeto).
- [ ] **Step 3:** `npm test`, typecheck PASS. **Commit** `feat(editor): tela do editor, biblioteca, visualizador, inspetor e navegação`.

---

### Task 11: Timeline

**Files:** Create `ui/timeline/{Timeline.tsx,Ruler.tsx,TrackHeader.tsx,TrackLane.tsx,ItemView.tsx,Playhead.tsx,useTimelineDrag.ts,zoom.ts}` + `zoom.test.ts`; decisão sobre `dnd-timeline`: **não usar** (o F0/pesquisa mostrou que todos os NLEs fazem a própria; nosso modelo já tem ops/snap puros) — implementação própria com Pointer Events.

**Produces:** `zoom.ts` puro: `usToPx(us, pxPerSec, scrollUs)`, `pxToUs(px, pxPerSec, scrollUs)`, `zoomAround(pxPerSec, factor, anchorUs, scrollUs, anchorPx) → {pxPerSec, scrollUs}` (anchor fica parado sob o mouse), `fitZoom(durationUs, widthPx)`, `rulerTicks(pxPerSec, fps) → {majorUs, minorUs}` (passos 1 quadro … 10 min escolhidos para major ≥ 80 px).

Comportamento:
- Régua com timecode e ticks; clicar/arrastar move o playhead (seek com `PlaybackController.seek`); marcadores (triângulos coloridos, duplo clique renomeia); faixa I/O destacada.
- Cabeçalhos: nome (duplo clique renomeia), mute/ocultar (ícones), cadeado, volume (popover com slider), menu (excluir faixa, mover para cima/baixo). Faixas de vídeo acima, áudio abaixo, separador.
- `ItemView`: posicionado por `usToPx`; vídeo/imagem mostram filmstrip (`background-image` do sprite com `background-position` calculado pelo `inUs`/speed e zoom), áudio mostra waveform desenhado em `<canvas>` a partir de `peaks` (carregado uma vez por asset via `fetch(cialight-file://project/...)`, cache em memória); nome, badge de velocidade (`2×`), ícone de vínculo; seleção com contorno de acento; virtualização: só renderiza itens visíveis (+ margem).
- Interações (`useTimelineDrag`): arrastar corpo move (com vinculados; Alt ignora vínculo; arrastar para outra faixa do mesmo tipo muda faixa; soltar acima da 1ª faixa de vídeo ou abaixo da última de áudio cria faixa nova), bordas fazem trim (cursor `ew-resize`, ripple com Ctrl), snap com tolerância 8 px (`snapPoints/snapDelta`) mostrando linha guia; durante o gesto usar transação; sobreposição ao soltar → `mode:'overwrite'` (padrão CapCut) — sem sobreposição durante o arraste exibe sombra vermelha se inválido em faixa bloqueada. Seleção por caixa no fundo; clique com Ctrl/Shift. Botão direito: menu contextual (Dividir, Excluir, Excluir com ripple, Separar áudio/Vincular, Duplicar, Velocidade…, Congelar quadro (F3 — oculto até lá)).
- Barra de ferramentas da timeline: dividir (S), apagar, desfazer/refazer, snap on/off (N), zoom −/slider/+ e "ajustar" (Shift+Z), marcador (M), I/O e "Apagar trecho I–O" (`deleteRange`).
- Rolagem: roda = rolar horizontal; Ctrl+roda = zoom ancorado no mouse; Shift+roda = vertical; durante a reprodução, auto-rolagem segue o playhead (página por página).
- Desempenho: 200 itens visíveis com zoom sem engasgos (medir via CDP `performance.now()` em 60 eventos de drag; meta < 8 ms por evento).

- [ ] **Step 1: Testes puros que falham** `zoom.test.ts`: ida-e-volta `pxToUs(usToPx(x))` ≈ x; `zoomAround` mantém `anchorUs` sob `anchorPx`; `rulerTicks(100, 30).majorUs` = 1 s; `fitZoom(60 s, 1200 px)` ≈ 20 px/s (com margem 5 %).
- [ ] **Step 2: Implementar** componentes.
- [ ] **Step 3: QA via CDP**: script `scripts/qa/editor-timeline.mjs` que, via `window.__qaEditor` (expor `store` e `controller` só fora do pacote, padrão de `app/qa.ts`), cria projeto com 3 assets de teste, executa dividir/mover/trim/ripple/undo por `dispatchEvent` de pointer events reais nos elementos e confere o estado do store; mede tempo por evento de drag; tira screenshots.
- [ ] **Step 4:** testes + typecheck PASS. **Commit** `feat(editor): timeline multifaixa (zoom, snap, trim, mover, ripple, seleção, menu)`.

---

### Task 12: Exportação do editor

**Files:** Create `export/editorExport.ts`, `ui/ExportDialog.tsx`, `src/main/export/editorExportJob.ts`; Modify `render.worker.ts` (modo export), `audio.worker.ts` (render streaming para export), `src/shared/ipc.ts` (`editorExport.open/write/close/finalize/cancel`), preload, main ipc; `src/main/export/encoderProbe.ts` + `src/shared/types.ts` (`HwEncoder` += `'amf'`: tentar `h264_amf` depois de qsv; testes de `encoderProbe.test.ts` atualizados).

Pipeline (spec §11): o **render worker** cria `Output` mediabunny (`Mp4OutputFormat({ fastStart: false })`, `StreamTarget` com chunks → `exportVideoChunk` com contrapressão por `chunkAck`, como `exportComposer.worker.ts`), `VideoSampleSource` (ou `CanvasSource` sobre o OffscreenCanvas de exportação — usar o que o F0 mediu como mais rápido) e `AudioSampleSource` alimentado por blocos que o worker pede ao audio worker via `MessageChannel` (transferido no `exportStart`). Loop `n = 0..N−1`, `tUs = fromUs + frameToUs(n, fps)`: `resolveFrame` → fontes (originais/intermediários, `sequential=true`) → `draw` → sample → `add`. Áudio: blocos de 100 ms em ordem, `AudioSample` f32 planar/interleaved conforme API. Fim: `finalize`. Main grava em `<saida>.part`, ao terminar roda `ffmpeg -i part -c copy -movflags +faststart saida.mp4`, apaga `.part`. Cancelamento: worker aborta, main apaga `.part`. Falha de encoder em `prefer-hardware` antes do 1º chunk → reinicia com `prefer-software`; falha em software → erro claro com sugestão.

`ExportDialog` (Radix Dialog): presets F1 — **Alta 1080p** (H.264, 12 Mbps @30/20 Mbps @60), **WhatsApp** (720p, alvo 64 MB via bitrate calculado), **Original** (resolução do projeto, 20 Mbps), **Vertical 9:16** (só muda resolução de saída para 1080×1920 se o projeto for 9:16; caso contrário avisa "mude a proporção do projeto"); intervalo (tudo / I–O se definidos); nome (`sanitizeFileName`, padrão `<nome do projeto>.mp4`) e pasta (padrão `settings.outputDir`); estimativa (`bitrate × duração`); progresso com %, ETA, velocidade (×tempo real), cancelar; concluído com Abrir pasta / Copiar arquivo (reusar handlers de `ExportDone`).

- [ ] **Step 1: Testes puros que falham:** cálculo de bitrate do preset WhatsApp (`targetBitrate(64 MB, durationUs, audioKbps 128)` com margem 4 %) e de número de quadros (`frameCount(fromUs, toUs, fps)` = ceil); `encoderProbe.test.ts` com AMF.
- [ ] **Step 2: Implementar.**
- [ ] **Step 3: Teste de integração real** (`test:editor`, cenário export): projeto com `testsrc2` 10 s (+ sine) cortado em [2 s, 5 s) apagado por `deleteRange`, imagem sobreposta 2 s, fadeIn de áudio 1 s → exporta 1280×720@30 → ffprobe: 1 stream H.264 + 1 AAC, duração 7,0 s ± 1 quadro, 210 ± 1 quadros; `astats` dos primeiros 100 ms com RMS < −30 dB e do segundo 3 > −20 dB; quadro em t=2,0 s corresponde ao quadro 5,0 s da fonte (comparar com `ffmpeg -ss 5 -frames:v 1` da fonte, PSNR > 30 dB); arquivo `+faststart` (`moov` antes de `mdat`). Gravação v1 → `projectFromSession` → export com webcam circular → quadro no centro da PiP ≈ quadro do v1 `__qaExport` (PSNR > 28 dB) — garante paridade.
- [ ] **Step 4:** `npm test`, `npm run test:editor`, `npm run test:ffmpeg` (regressão v1), typecheck PASS.
- [ ] **Step 5: Commit** `feat(editor): exportação pelo compositor (WebCodecs + faststart, fallback de encoder, AMF)`.

---

### Task 13: QA completa, documentação e release v1.1.0

**Files:** Modify `docs/qa-checklist.md` (seção Editor), `README.md` (Editor), `docs/superpowers/specs/2026-10-01-editor-design.md` (§ notas de implementação F1), `NOTICE` (atribuições: opencut-classic MIT se código adaptado; mediabunny MPL-2.0; twgl MIT; ffmpeg GPL já existente), `package.json` version via `npm version minor`.

- [ ] **Step 1: Regressão:** `npm test`, `npm run typecheck`, `npm run test:ffmpeg`, `npm run test:capture`, `npm run test:ingest`, `npm run test:editor` — todos verdes; colar saídas no relatório.
- [ ] **Step 2: E2E manual automatizado via CDP** (não usar SendKeys/mouse do SO — interfere com o usuário): fluxo gravar 10 s (via `test:capture` existente) → Histórico → Editar → dividir no meio, apagar 2 s, mover webcam, importar mp3 e png gerados, ajustar volume, exportar Alta → abrir resultado com ffprobe. Screenshots de cada etapa em `docs/qa/editor-f1/`.
- [ ] **Step 3: Revisão de código** da branch (skill `superpowers:requesting-code-review`) e correções.
- [ ] **Step 4: Release:** merge `feat/editor` → `main` (fast-forward ou merge commit), `npm version minor -m "release: v%s"` (faz push da tag), `npm run dist:win`, `gh release create v1.1.0 release/*.exe release/*.blockmap release/latest.yml --title "v1.1.0 — Editor de vídeo" --notes-file <notas em pt-BR>`; verificar que é release normal (não draft/pré-release) e que o app instalado recebe a atualização (Configurações → Atualizações → Verificar).
- [ ] **Step 5:** atualizar memória do projeto (`project_cialight_gravador.md`) com arquitetura do editor e comandos de teste novos.
