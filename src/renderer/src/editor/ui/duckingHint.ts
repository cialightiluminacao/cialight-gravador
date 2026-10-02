import type { MediaItem, Project } from '@shared/editor/project'

// Diagnóstico do ducking para o inspetor do projeto (puro).

/**
 * Por que o ducking não terá efeito (ou null se está tudo certo). `speechFailed`: assets cujo speech.json não carregou
 * no audio worker (contam como sem análise de fala).
 */
export function duckingHint(p: Project, speechFailed: Readonly<Record<string, true>> = {}): string | null {
  const audible = (role: 'voice' | 'music'): MediaItem[] =>
    p.tracks.filter((t) => t.role === role && !t.muted).flatMap((t) => t.items.filter((i): i is MediaItem => i.type === 'media' && i.enabled !== false && i.audio.enabled))
  const music = audible('music')
  const voice = audible('voice')
  if (!music.length) return 'Nenhuma música na linha do tempo. Músicas importadas na aba Áudio vão para a faixa Música.'
  if (!voice.length) return 'Nenhuma faixa de Voz com som. Defina o papel de uma faixa de áudio como Voz (ícone ao lado do nome da faixa).'
  const missing = new Set(voice.map((i) => p.assets.find((a) => a.id === i.assetId)).filter((a) => a && (!a.speech || speechFailed[a.id])).map((a) => a!.id))
  if (missing.size) return missing.size === 1 ? 'Uma mídia de voz ainda sem análise de fala: ela não abaixa a música.' : `${missing.size} mídias de voz ainda sem análise de fala: elas não abaixam a música.`
  return null
}
