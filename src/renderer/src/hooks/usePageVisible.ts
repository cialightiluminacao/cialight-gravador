import { useEffect, useState } from 'react'

/** true enquanto a janela está visível (não minimizada/oculta) — pausa trabalho periódico. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const on = (): void => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

/**
 * true enquanto a janela está visível E em foco. Para capturas periódicas da tela
 * (desktopCapturer): a janela atrás de outras continua "visível", e capturar
 * monitores/janelas sem parar faz o ponteiro do mouse engasgar no Windows todo.
 */
export function useWindowActive(): boolean {
  const visible = usePageVisible()
  const [focused, setFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const on = (): void => setFocused(true)
    const off = (): void => setFocused(false)
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])
  return visible && focused
}
