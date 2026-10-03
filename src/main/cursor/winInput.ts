import type { Rect } from '@shared/cursor'
import type { PhysicalButtonStates } from './buttonEdges'

// Acesso nativo do Windows para a trilha do cursor (F6), via koffi (FFI N-API pré-compilado, MIT): estado dos
// botões do mouse (GetAsyncKeyState, consultado no tick da amostragem — sem hook global, sem injeção de input) e
// limites da janela gravada (DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS), em px físicos porque o main do
// Electron é "per-monitor DPI aware"). Carregado sob demanda; qualquer falha devolve null (gravação segue só com
// amostras) — escolha documentada em docs/research/2026-10-02-f6-click-capture-spike.md.

export interface WinInput {
  readButtons(): PhysicalButtonStates
  buttonsSwapped(): boolean
  /** Limites visíveis da janela (px físicos de tela); null se a janela não existe ou está minimizada. */
  windowFrame(hwnd: number): Rect | null
}

const VK_LBUTTON = 0x01
const VK_RBUTTON = 0x02
const VK_MBUTTON = 0x04
const SM_SWAPBUTTON = 23
const DWMWA_EXTENDED_FRAME_BOUNDS = 9

interface RectOut { left: number; top: number; right: number; bottom: number }

let cached: WinInput | null | undefined
let loadError: unknown = null

function load(): WinInput {
  // require tardio (na 1ª gravação, depois de o relógio da trilha começar): ~45 ms; nunca na abertura do app
  const koffi = require('koffi') as typeof import('koffi')
  const user32 = koffi.load('user32.dll')
  const dwmapi = koffi.load('dwmapi.dll')
  koffi.struct('CialightRect', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)')
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)')
  const IsWindow = user32.func('int __stdcall IsWindow(intptr hWnd)')
  const IsIconic = user32.func('int __stdcall IsIconic(intptr hWnd)')
  const GetWindowRect = user32.func('int __stdcall GetWindowRect(intptr hWnd, _Out_ CialightRect *lpRect)')
  const DwmGetWindowAttribute = dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr hwnd, uint32_t dwAttribute, _Out_ CialightRect *pvAttribute, uint32_t cbAttribute)')
  return {
    readButtons: () => ({ left: GetAsyncKeyState(VK_LBUTTON) as number, right: GetAsyncKeyState(VK_RBUTTON) as number, middle: GetAsyncKeyState(VK_MBUTTON) as number }),
    buttonsSwapped: () => (GetSystemMetrics(SM_SWAPBUTTON) as number) !== 0,
    windowFrame: (hwnd) => {
      if (!IsWindow(hwnd) || IsIconic(hwnd)) return null
      const r: RectOut = { left: 0, top: 0, right: 0, bottom: 0 }
      // limites sem a borda invisível de redimensionamento (é o que a captura da janela mostra); GetWindowRect de reserva
      if ((DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) as number) !== 0 && !GetWindowRect(hwnd, r)) return null
      const width = r.right - r.left
      const height = r.bottom - r.top
      return width > 0 && height > 0 ? { x: r.left, y: r.top, width, height } : null
    }
  }
}

/** Binding nativo (carregado uma vez). null se indisponível (fora do Windows, módulo ausente ou falha ao carregar). */
export function loadWinInput(): WinInput | null {
  if (cached !== undefined) return cached
  if (process.platform !== 'win32') {
    cached = null
    return cached
  }
  try {
    cached = load()
  } catch (e) {
    loadError = e
    cached = null
  }
  return cached
}

export function winInputLoadError(): unknown {
  return loadError
}
