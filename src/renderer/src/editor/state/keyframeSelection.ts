import { create } from 'zustand'
import { ANIM_PATHS, getAnim, type AnimPath } from '@shared/editor/animPaths'
import { findItem, type KeyRef } from '@shared/editor/ops'
import type { Item, Us } from '@shared/editor/project'
import { useEditorStore } from './editorStore'

// Keyframes selecionados na linha do tempo (fora do histórico), sempre de um item só: losangos da linha
// combinada do item (path null = todas as propriedades naquele instante) e/ou das linhas por propriedade
// do item expandido. Delete remove, Ctrl+C copia, arrastar move o grupo. Vale só enquanto o item é a
// seleção única; keys que deixam de existir (desfazer, edição no inspetor…) saem da seleção.

/** Um losango: path null = o combinado (todas as propriedades com key no instante). tUs = instante local. */
export interface SelKey { path: AnimPath | null; tUs: Us }
export interface KeyframeSel { itemId: string; keys: SelKey[] }

export const useKeyframeSelection = create<{ sel: KeyframeSel | null; set(sel: KeyframeSel | null): void }>()((set) => ({
  sel: null,
  set: (sel) => set({ sel })
}))

const near = (a: Us, b: Us): boolean => Math.abs(a - b) <= 1
const sameKey = (a: SelKey, b: SelKey): boolean => a.path === b.path && near(a.tUs, b.tUs)
const hasKeyAt = (item: Item, path: AnimPath, tUs: Us): boolean => (getAnim(item, path)?.keys ?? []).some((k) => near(k.tUs, tUs))

/** Clique com Shift/Ctrl: soma ou tira o losango (no mesmo item); outro item recomeça; vazia → null. */
export function toggleKey(sel: KeyframeSel | null, itemId: string, key: SelKey): KeyframeSel | null {
  if (!sel || sel.itemId !== itemId) return { itemId, keys: [key] }
  const keys = sel.keys.some((k) => sameKey(k, key)) ? sel.keys.filter((k) => !sameKey(k, key)) : [...sel.keys, key]
  return keys.length ? { itemId, keys } : null
}

/** O losango (path null = combinado) está selecionado? Um combinado selecionado vale para todas as propriedades no instante. */
export function isKeySelected(sel: KeyframeSel | null, itemId: string, path: AnimPath | null, tUs: Us): boolean {
  if (!sel || sel.itemId !== itemId) return false
  return sel.keys.some((k) => near(k.tUs, tUs) && (k.path === null || k.path === path))
}

/** Os keys de verdade (por propriedade) da seleção: o combinado vira as propriedades com key no instante; sem repetir. */
export function concreteRefs(item: Item, keys: readonly SelKey[]): KeyRef[] {
  const out: KeyRef[] = []
  const add = (path: AnimPath, tUs: Us): void => {
    if (hasKeyAt(item, path, tUs) && !out.some((r) => r.path === path && near(r.tUs, tUs))) out.push({ path, tUs })
  }
  for (const k of keys) {
    if (k.path) add(k.path, k.tUs)
    else for (const pt of ANIM_PATHS) add(pt, k.tUs)
  }
  return out
}

/** Keys das linhas lane0..lane1 (índices em `paths`) com instante local em [fromUs, toUs] (em qualquer ordem). */
export function keysInLaneBox(item: Item, paths: readonly AnimPath[], fromUs: Us, toUs: Us, lane0: number, lane1: number): SelKey[] {
  const a = Math.min(fromUs, toUs), b = Math.max(fromUs, toUs)
  const out: SelKey[] = []
  for (let i = Math.max(0, Math.min(lane0, lane1)); i <= Math.min(paths.length - 1, Math.max(lane0, lane1)); i++) {
    for (const k of getAnim(item, paths[i])?.keys ?? []) if (k.tUs >= a && k.tUs <= b) out.push({ path: paths[i], tUs: k.tUs })
  }
  return out
}

/** Depois de arrastar o grupo: os mesmos losangos, deslocados. */
export function shiftSelKeys(keys: readonly SelKey[], deltaUs: Us): SelKey[] {
  return keys.map((k) => ({ ...k, tUs: k.tUs + deltaUs }))
}

/** Só os losangos que ainda têm key no item (combinado: em qualquer propriedade); nada mudou → o mesmo objeto. */
export function pruneSel(sel: KeyframeSel, item: Item): KeyframeSel | null {
  const keys = sel.keys.filter((k) => (k.path ? hasKeyAt(item, k.path, k.tUs) : ANIM_PATHS.some((pt) => hasKeyAt(item, pt, k.tUs))))
  if (keys.length === sel.keys.length) return sel
  return keys.length ? { itemId: sel.itemId, keys } : null
}

useEditorStore.subscribe((s, prev) => {
  // no meio de um gesto (arrastar o losango) quem decide é o gesto, ao terminar
  if (s.txBase || (s.selection === prev.selection && s.project === prev.project)) return
  const sel = useKeyframeSelection.getState().sel
  if (!sel) return
  // outra seleção, ou keys que sumiram (desfazer, edição no inspetor…): sem nenhum, Delete volta a apagar o item
  const item = s.project ? findItem(s.project, sel.itemId)?.item : undefined
  const next = item && s.selection.length === 1 && s.selection[0] === sel.itemId ? pruneSel(sel, item) : null
  if (next !== sel) useKeyframeSelection.getState().set(next)
})
