// Cena sintética do teste real do "Seguir conteúdo" (F6, `npm run test:editor`): o main gera o vídeo com o ffmpeg e mede
// a exportação; o harness do renderer rastreia e exporta. Os dois usam estas constantes (um lugar só). Puro.
//
// 1280×720 a 30 fps, 4 s, fundo escuro liso: "CPF 123.456.789-00" (Consolas 48, branco) anda para a direita a
// 200 px/s, para de 1 s a 1,6 s, volta a andar; de 2,2 s a 2,7 s uma faixa cinza opaca cobre a linha do texto
// (oclusão: o rastreamento perde o conteúdo e o reencontra depois). Uma linha parecida, parada, fica mais abaixo
// ("CPF 123.456.789-01", fora da faixa medida): um distrator para a ambiguidade (R19).

export const TRACK_SCENE = {
  width: 1280,
  height: 720,
  fps: 30,
  durationS: 4,
  text: 'CPF 123.456.789-00',
  fontSize: 48,
  textY: 300,
  /** Faixa da oclusão (px do quadro) e o intervalo (s, inclusivo como o `between` do ffmpeg). */
  occluder: { y: 260, h: 140 },
  occludeFrom: 2.2,
  occludeTo: 2.7,
  /** Faixa horizontal medida na exportação (contém o texto e a oclusão). */
  band: { y: 240, h: 200 },
  /** Linha parecida (distrator), parada, abaixo da faixa medida. */
  lookAlike: { text: 'CPF 123.456.789-01', x: 300, y: 520 }
} as const

/** x (px) do texto no instante t (s) — a mesma conta da expressão do ffmpeg (TEXT_X_EXPR). */
export const textX = (t: number): number => (t < 1 ? 80 + 200 * t : t < 1.6 ? 280 : 280 + 200 * (t - 1.6))
/** Para usar entre aspas simples no filtro drawtext (x='…'). */
export const TEXT_X_EXPR = 'if(lt(t,1),80+200*t,if(lt(t,1.6),280,280+200*(t-1.6)))'

/** O texto está coberto no quadro n? (margem de meio quadro nas bordas: o ffmpeg arredonda o tempo do quadro). */
export const occludedFrame = (n: number): 'yes' | 'no' | 'edge' => {
  const t = n / TRACK_SCENE.fps, h = 0.5 / TRACK_SCENE.fps
  if (t > TRACK_SCENE.occludeFrom + h && t < TRACK_SCENE.occludeTo - h) return 'yes'
  if (t < TRACK_SCENE.occludeFrom - h || t > TRACK_SCENE.occludeTo + h) return 'no'
  return 'edge'
}
