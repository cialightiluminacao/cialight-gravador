import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/app/store'
import {
  SETTINGS_TAB_STORAGE_KEY,
  applyStoredSettingsTab,
  getSettingsTab,
  installSettingsDeepLink,
  parseSettingsTab,
  setSettingsTab,
  subscribeSettingsTab
} from './settingsTabs'

// sessionStorage mínimo (vitest roda em Node): o suficiente para o contrato do App.
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v))
  }
}

describe('parseSettingsTab', () => {
  it('aceita id puro, com prefixo settings: e com acentos/maiúsculas', () => {
    expect(parseSettingsTab('atalhos')).toBe('atalhos')
    expect(parseSettingsTab('settings:atalhos')).toBe('atalhos')
    expect(parseSettingsTab('Anotações')).toBe('anotacoes')
    expect(parseSettingsTab('settings:Atualização')).toBe('atualizacao')
  })
  it('devolve null para abas desconhecidas', () => {
    expect(parseSettingsTab('settings:nada')).toBeNull()
    expect(parseSettingsTab('')).toBeNull()
  })
})

describe('mini-store da aba', () => {
  it('setSettingsTab troca a aba e notifica só quando muda', () => {
    setSettingsTab('geral')
    const spy = vi.fn()
    const off = subscribeSettingsTab(spy)
    setSettingsTab('avancado')
    setSettingsTab('avancado')
    expect(getSettingsTab()).toBe('avancado')
    expect(spy).toHaveBeenCalledTimes(1)
    off()
    setSettingsTab('geral')
    expect(getSettingsTab()).toBe('geral')
  })
})

describe('deep link settings:<aba> pelo store', () => {
  beforeAll(() => vi.stubGlobal('sessionStorage', fakeStorage()))
  afterAll(() => vi.unstubAllGlobals())
  beforeEach(() => {
    sessionStorage.clear()
    setSettingsTab('geral')
  })

  it('redireciona o store para a tela settings e abre a aba pedida', () => {
    installSettingsDeepLink()
    useAppStore.getState().setScreen('settings:avancado' as never)
    expect(useAppStore.getState().screen).toBe('settings')
    expect(getSettingsTab()).toBe('avancado')
  })
  it('preserva a tela de retorno: «Voltar» não cai no deep link de novo', () => {
    useAppStore.setState({ screen: 'prepare', returnScreen: 'prepare' })
    useAppStore.getState().setScreen('settings:atalhos' as never)
    expect(useAppStore.getState().screen).toBe('settings')
    expect(useAppStore.getState().returnScreen).toBe('prepare')
    useAppStore.getState().goBack()
    expect(useAppStore.getState().screen).toBe('prepare')
  })
  it('mantém a última aba quando o deep link não é reconhecido', () => {
    setSettingsTab('atalhos')
    useAppStore.getState().setScreen('settings:inexistente' as never)
    expect(useAppStore.getState().screen).toBe('settings')
    expect(getSettingsTab()).toBe('atalhos')
  })
})

describe('contrato do App: sessionStorage.settingsTab + setScreen("settings")', () => {
  beforeAll(() => vi.stubGlobal('sessionStorage', fakeStorage()))
  afterAll(() => vi.unstubAllGlobals())
  beforeEach(() => {
    sessionStorage.clear()
    setSettingsTab('geral')
    useAppStore.setState({ screen: 'prepare', returnScreen: 'prepare' })
  })

  it('ao entrar em Configurações consome a chave e abre a aba pedida', () => {
    installSettingsDeepLink()
    sessionStorage.setItem(SETTINGS_TAB_STORAGE_KEY, 'atualizacao')
    useAppStore.getState().setScreen('settings')
    expect(getSettingsTab()).toBe('atualizacao')
    expect(sessionStorage.getItem(SETTINGS_TAB_STORAGE_KEY)).toBeNull()
  })
  it('troca a aba mesmo com Configurações já aberta', () => {
    useAppStore.getState().setScreen('settings')
    setSettingsTab('geral')
    const spy = vi.fn()
    const off = subscribeSettingsTab(spy)
    sessionStorage.setItem(SETTINGS_TAB_STORAGE_KEY, 'atalhos')
    useAppStore.getState().setScreen('settings')
    expect(getSettingsTab()).toBe('atalhos')
    expect(spy).toHaveBeenCalled()
    off()
  })
  it('applyStoredSettingsTab aplica um pedido pendente e ignora valores inválidos', () => {
    sessionStorage.setItem(SETTINGS_TAB_STORAGE_KEY, 'dispositivos')
    applyStoredSettingsTab()
    expect(getSettingsTab()).toBe('dispositivos')
    sessionStorage.setItem(SETTINGS_TAB_STORAGE_KEY, 'nada')
    applyStoredSettingsTab()
    expect(getSettingsTab()).toBe('dispositivos')
    expect(sessionStorage.getItem(SETTINGS_TAB_STORAGE_KEY)).toBeNull()
  })
})
