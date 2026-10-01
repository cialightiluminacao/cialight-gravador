import { describe, expect, it } from 'vitest'
import { ipcErrorMessage } from './ipcError'

describe('ipcErrorMessage', () => {
  it('tira o prefixo do invoke do Electron', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'editorExport:open': Error: Espaço insuficiente na pasta de destino"))).toBe('Espaço insuficiente na pasta de destino')
    expect(ipcErrorMessage(new Error("Error invoking remote method 'media:relink': TypeError: x"))).toBe('x')
    expect(ipcErrorMessage(new Error("Error invoking remote method 'project:load': Projeto ilegível"))).toBe('Projeto ilegível')
  })
  it('mantém mensagens comuns e valores que não são Error', () => {
    expect(ipcErrorMessage(new Error('falhou'))).toBe('falhou')
    expect(ipcErrorMessage('texto')).toBe('texto')
  })
})
