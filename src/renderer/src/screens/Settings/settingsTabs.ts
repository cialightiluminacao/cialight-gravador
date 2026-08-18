import { useAppStore } from '@/app/store'

// Abas da tela de Configurações + "deep link" via window.__navigate('settings:<aba>')
// (usado pelo QA visual: CIALIGHT_SCREEN=settings:atalhos) e memória da última aba
// aberta enquanto o app está em execução.

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

let currentTab: SettingsTab = 'geral'

/** Converte um id livre (`atalhos`, `settings:atalhos`, `Atualização`) em aba válida; `null` se desconhecido. */
export function parseSettingsTab(raw: string): SettingsTab | null {
  const id = raw.startsWith(DEEP_LINK_PREFIX) ? raw.slice(DEEP_LINK_PREFIX.length) : raw
  const key = id.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  return (SETTINGS_TABS as readonly string[]).includes(key) ? (key as SettingsTab) : null
}

/** Aba a abrir ao entrar na tela (última usada ou a pedida por deep link). */
export function getInitialSettingsTab(): SettingsTab {
  return currentTab
}

export function rememberSettingsTab(tab: SettingsTab): void {
  currentTab = tab
}

let installed = false

/**
 * Observa o store: se alguém navegar para `settings:<aba>` (valor fora do tipo `Screen`),
 * guarda a aba pedida e redireciona para a tela `settings`. Idempotente.
 */
export function installSettingsDeepLink(): void {
  if (installed) return
  installed = true
  const handle = (screen: string): void => {
    if (!screen.startsWith(DEEP_LINK_PREFIX)) return
    const tab = parseSettingsTab(screen)
    if (tab) currentTab = tab
    // setState direto (não setScreen) para não gravar 'settings:<aba>' como returnScreen —
    // senão «Voltar» cairia no deep link de novo e o usuário ficaria preso em Configurações.
    useAppStore.setState({ screen: 'settings' })
  }
  useAppStore.subscribe((st, prev) => {
    if (st.screen !== prev.screen) handle(st.screen)
  })
  handle(useAppStore.getState().screen)
}
