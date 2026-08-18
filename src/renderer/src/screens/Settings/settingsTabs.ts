import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/app/store'

// Abas da tela de Configurações: mini-store da aba atual (persiste enquanto o app roda),
// "deep link" `settings:<aba>` (QA visual: CIALIGHT_SCREEN=settings:atalhos; banner de
// atualização; avisos de atalho) e leitura do contrato do App (`sessionStorage.settingsTab`).
//
// Dois caminhos levam a uma aba:
//  1. window.__navigate('settings:<aba>') no App → sessionStorage.setItem('settingsTab', aba)
//     + setScreen('settings'). Aqui consumimos essa chave ao entrar na tela e a cada
//     mudança do store enquanto Configurações está aberta (a tela já montada troca de aba).
//  2. Alguém grava `screen: 'settings:<aba>'` direto no store (valor fora do tipo Screen):
//     interceptamos, guardamos a aba e redirecionamos para 'settings'.

export const SETTINGS_TABS = ['geral', 'dispositivos', 'atalhos', 'anotacoes', 'avancado', 'atualizacao'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  geral: 'Geral',
  dispositivos: 'Dispositivos',
  atalhos: 'Atalhos',
  anotacoes: 'Anotações',
  avancado: 'Avançado',
  atualizacao: 'Atualização e sobre'
}

const DEEP_LINK_PREFIX = 'settings:'
/** Chave usada pelo App (window.__navigate) para pedir uma aba: `sessionStorage.settingsTab`. */
export const SETTINGS_TAB_STORAGE_KEY = 'settingsTab'

let currentTab: SettingsTab = 'geral'
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/** Converte um id livre (`atalhos`, `settings:atalhos`, `Atualização`) em aba válida; `null` se desconhecido. */
export function parseSettingsTab(raw: string): SettingsTab | null {
  const id = raw.startsWith(DEEP_LINK_PREFIX) ? raw.slice(DEEP_LINK_PREFIX.length) : raw
  const key = id.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  return (SETTINGS_TABS as readonly string[]).includes(key) ? (key as SettingsTab) : null
}

/** Lê e apaga o pedido de aba deixado pelo App em sessionStorage; `null` se não há pedido válido. */
function consumeStoredTab(): SettingsTab | null {
  try {
    const raw = sessionStorage.getItem(SETTINGS_TAB_STORAGE_KEY)
    if (raw === null) return null
    sessionStorage.removeItem(SETTINGS_TAB_STORAGE_KEY)
    return parseSettingsTab(raw)
  } catch {
    return null
  }
}

/** Troca a aba atual (UI ou deep link) e avisa quem estiver ouvindo. */
export function setSettingsTab(tab: SettingsTab): void {
  if (tab === currentTab) return
  currentTab = tab
  emit()
}

/** Aba atual (última usada ou a pedida por deep link). Sem efeitos: serve de snapshot. */
export function getSettingsTab(): SettingsTab {
  return currentTab
}

/** Aplica um pedido pendente do App (`sessionStorage.settingsTab`), se houver. */
export function applyStoredSettingsTab(): void {
  const stored = consumeStoredTab()
  if (stored) setSettingsTab(stored)
}

/** Assina mudanças da aba (para `useSyncExternalStore`). */
export function subscribeSettingsTab(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Aba atual reativa: reage à UI, ao deep link e ao pedido do App via sessionStorage. */
export function useSettingsTab(): SettingsTab {
  return useSyncExternalStore(subscribeSettingsTab, getSettingsTab, getSettingsTab)
}

let installed = false

/**
 * Observa o store:
 * - `screen: 'settings:<aba>'` → guarda a aba e redireciona para `settings`;
 * - qualquer mudança com Configurações aberta → consome `sessionStorage.settingsTab`
 *   (contrato do App), trocando a aba mesmo com a tela já montada.
 * Idempotente.
 */
export function installSettingsDeepLink(): void {
  if (installed) return
  installed = true
  const handle = (screen: string): void => {
    if (screen === 'settings') {
      applyStoredSettingsTab()
      return
    }
    if (!screen.startsWith(DEEP_LINK_PREFIX)) return
    const tab = parseSettingsTab(screen)
    if (tab) setSettingsTab(tab)
    // setState direto (não setScreen) para não gravar 'settings:<aba>' como returnScreen —
    // senão «Voltar» cairia no deep link de novo e o usuário ficaria preso em Configurações.
    useAppStore.setState({ screen: 'settings' })
  }
  useAppStore.subscribe((st) => handle(st.screen))
  handle(useAppStore.getState().screen)
}
