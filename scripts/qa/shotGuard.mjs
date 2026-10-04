// Repo público: nenhuma captura de QA pode mostrar caminho local com a pasta do usuário. Antes de cada captura,
// troca na tela (só na exibição: nós de texto, title/placeholder ficam) o prefixo até a pasta do usuário por "…" e
// confere que o nome dela não aparece mais em lugar nenhum do texto visível; se aparecer, a captura é recusada.
import { homedir } from 'os'
import { basename } from 'path'

const HOME = homedir()
const USER = basename(HOME)

const HOME_SLASH = HOME.split(String.fromCharCode(92)).join('/')
const MASK = `(() => {
  const variants = ${JSON.stringify([HOME, HOME_SLASH, HOME.toLowerCase(), HOME_SLASH.toLowerCase()])}
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    let v = n.nodeValue
    for (const h of variants) if (v.includes(h)) v = v.split(h).join('…')
    if (v !== n.nodeValue) n.nodeValue = v
  }
  const text = document.body.innerText.toLowerCase()
  return ${JSON.stringify([String.fromCharCode(92) + USER.toLowerCase() + String.fromCharCode(92), '/' + USER.toLowerCase() + '/'])}.some((s) => text.includes(s))
})()`

/** Chamar logo antes de Page.captureScreenshot, com o `send` CDP do script. */
export async function guardShot(send) {
  const r = await send('Runtime.evaluate', { expression: MASK, returnByValue: true })
  const leak = r?.result?.result?.value
  if (leak !== false) throw new Error(`captura recusada: a tela ainda mostra a pasta do usuário (${JSON.stringify(r?.result?.exceptionDetails ?? leak)})`)
}
