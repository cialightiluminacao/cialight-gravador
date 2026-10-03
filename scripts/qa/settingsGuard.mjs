// Guarda do settings.json do usuário nos scripts de QA do editor (o app instalado compartilha o userData): lê o arquivo
// e o sha256 ANTES de abrir o app; no fim compara, restaura o backup se mudou e confere o hash de novo.
// Falha se o conteúdo mudou em qualquer chave além de `pip`: a tela Preparar do app (aberta ao iniciar) regrava a
// geometria do PiP da câmera quando a janela é redimensionada pela emulação de viewport do CDP — efeito do app, que
// nada tem a ver com o editor, intermitente e idêntico nos outros scripts de QA. Esse caso é restaurado e só avisa.
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'

/** sha256 em hex de um Buffer (null = 'ausente'). */
export const sha = (b) => (b ? createHash('sha256').update(b).digest('hex') : 'ausente')

/** Lê o settings.json agora (imprime o hash) e devolve { hashBefore, finish() → nº de falhas (0 ou 1) }. */
export function guardSettings(path) {
  const before = existsSync(path) ? readFileSync(path) : null
  const hashBefore = sha(before)
  console.log(`settings.json sha256 antes: ${hashBefore}`)
  return {
    hashBefore,
    finish() {
      const now = existsSync(path) ? readFileSync(path) : null
      const hashAfter = sha(now)
      console.log(`settings.json sha256 depois: ${hashAfter}`)
      if (hashAfter === hashBefore) {
        console.log('  ✔ settings.json intocado (hash igual)')
        return 0
      }
      let keys = []
      try {
        const a = JSON.parse(before?.toString() ?? '{}')
        const b = JSON.parse(now?.toString() ?? '{}')
        keys = Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
        for (const k of keys) console.log(`    ${k}: ${JSON.stringify(a[k])?.slice(0, 140)} → ${JSON.stringify(b[k])?.slice(0, 140)}`)
      } catch {
        keys = ['(ilegível)']
      }
      if (before) writeFileSync(path, before)
      const restored = sha(existsSync(path) ? readFileSync(path) : null)
      const benign = keys.length > 0 && keys.every((k) => k === 'pip')
      if (restored !== hashBefore) {
        console.log(`  ✘ settings.json mudou (${keys.join(', ')}) e a restauração não devolveu o hash original`)
        return 1
      }
      if (!benign) {
        console.log(`  ✘ settings.json mudou durante o teste (chaves: ${keys.join(', ')}); restaurado (hash ${restored.slice(0, 12)}…)`)
        return 1
      }
      console.log(`  ⚠ o app regravou só a geometria do PiP (pip) — restaurado; hash final igual ao de antes (${restored.slice(0, 12)}…)`)
      return 0
    }
  }
}
