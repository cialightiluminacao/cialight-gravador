import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/app/store'
import { getInitialSettingsTab, installSettingsDeepLink, parseSettingsTab, rememberSettingsTab } from './settingsTabs'

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

describe('deep link settings:<aba>', () => {
  it('redireciona o store para a tela settings e lembra a aba pedida', () => {
    installSettingsDeepLink()
    rememberSettingsTab('geral')
    useAppStore.getState().setScreen('settings:avancado' as never)
    expect(useAppStore.getState().screen).toBe('settings')
    expect(getInitialSettingsTab()).toBe('avancado')
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
    rememberSettingsTab('atalhos')
    useAppStore.getState().setScreen('settings:inexistente' as never)
    expect(useAppStore.getState().screen).toBe('settings')
    expect(getInitialSettingsTab()).toBe('atalhos')
  })
})
