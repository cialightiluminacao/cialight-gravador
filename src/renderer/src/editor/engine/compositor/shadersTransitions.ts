// Transições do compositor (F5): A e B já desenhados, cada um no seu FBO transparente W×H (alpha pré-multiplicado),
// misturados sobre o alvo atual por um passe de tela cheia (VS_FULL; blend ONE, ONE_MINUS_SRC_ALPHA). Escrito para
// este projeto (não deriva de gl-transitions). p = progress da TransitionLayer (0–1, já suavizado pelo resolve).
// Coordenadas: uv = gl_FragCoord / tamanho, convenção GL (y para CIMA); o FBO guarda a imagem com a linha de cima
// no topo (as camadas usam a mesma matriz do canvas), então "subir" é +y aqui.
import type { TransitionKind } from '@shared/editor/project'

/** Modo do shader: 0 mistura, 1 mergulho na cor, 2 deslizar, 3 cortina (wipe), 4 zoom. */
export interface TransitionMode { mode: 0 | 1 | 2 | 3 | 4; dir: [number, number]; color: [number, number, number] }

const NONE: [number, number] = [0, 0]
const BLACK: [number, number, number] = [0, 0, 0]

/**
 * Por tipo: `dir` (uv GL) = para onde A sai no deslizar; na cortina, o sentido em que a borda anda (wipeL: da direita
 * para a esquerda). blur = mistura, desfocada depois pelo blur separável dos efeitos (EffectPass.blurOnto): como o
 * desfoque é linear, desfocar a mistura = misturar A e B desfocados (24·sin(πp) px), com metade do custo.
 */
export const TRANSITION_MODES: Record<TransitionKind, TransitionMode> = {
  crossfade: { mode: 0, dir: NONE, color: BLACK },
  blur: { mode: 0, dir: NONE, color: BLACK },
  dipBlack: { mode: 1, dir: NONE, color: [0, 0, 0] },
  dipWhite: { mode: 1, dir: NONE, color: [1, 1, 1] },
  slideL: { mode: 2, dir: [-1, 0], color: BLACK },
  slideR: { mode: 2, dir: [1, 0], color: BLACK },
  slideU: { mode: 2, dir: [0, 1], color: BLACK },
  slideD: { mode: 2, dir: [0, -1], color: BLACK },
  wipeL: { mode: 3, dir: [-1, 0], color: BLACK },
  wipeR: { mode: 3, dir: [1, 0], color: BLACK },
  zoomIn: { mode: 4, dir: NONE, color: BLACK }
}

/** Largura da borda suave da cortina (fração da largura do quadro). */
export const WIPE_SOFT = 0.01
/** Raio máximo do desfoque da transição 'blur' (px de um quadro de 1080 de altura; no meio, p = 0,5). */
export const TRANSITION_BLUR_PX = 24
/** Zoom: A vai de 1 a 1 + ZOOM_A_GROW; B de ZOOM_B_FROM a 1. */
export const ZOOM_A_GROW = 0.5
export const ZOOM_B_FROM = 0.85

/** Raio (px de saída) do desfoque da transição 'blur' em p, numa saída de altura H: 24·sin(πp) na referência 1080. */
export function transitionBlurPx(p: number, H: number): number {
  return (TRANSITION_BLUR_PX * Math.sin(Math.PI * Math.min(1, Math.max(0, p))) * H) / 1080
}

export const FS_TRANSITION = `#version 300 es
precision highp float;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform vec2 u_frame;
uniform int u_mode;
uniform float u_p;
uniform vec2 u_dir;
uniform vec3 u_color;
out vec4 o;

// Lê a textura em q (uv GL) com cobertura antisserrilhada da borda dela: s = escala da imagem na saída (px de saída por
// px da textura). Fora da imagem: transparente (o que está abaixo aparece).
vec4 at(sampler2D t, vec2 q, float s) {
  vec2 d = min(q, 1.0 - q) * u_frame * s;
  vec2 cov = clamp(d + 0.5, 0.0, 1.0);
  return texture(t, clamp(q, 0.0, 1.0)) * cov.x * cov.y;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_frame;
  float p = clamp(u_p, 0.0, 1.0);
  if (u_mode == 1) {
    // mergulho: A → cor opaca (até a metade) → B; no meio a cor cobre tudo, inclusive o que está abaixo
    vec4 c = vec4(u_color, 1.0);
    o = p < 0.5 ? mix(texture(u_a, uv), c, 2.0 * p) : mix(c, texture(u_b, uv), 2.0 * p - 1.0);
  } else if (u_mode == 2) {
    // deslizar: A deslocado p·dir, B deslocado (p − 1)·dir (entra pelo lado oposto). As coberturas são disjuntas e
    // complementares (na coluna da emenda somam 1): soma simples — com "over" a emenda deixaria ver 25 % do que está abaixo
    vec4 a = at(u_a, uv - u_dir * p, 1.0);
    vec4 b = at(u_b, uv - u_dir * (p - 1.0), 1.0);
    o = a + b;
  } else if (u_mode == 3) {
    // cortina: s = posição ao longo do sentido da borda (0 onde ela começa); B atrás da borda, borda suave de ${WIPE_SOFT}
    // da largura; a borda vai de −½ suave a 1 + ½ suave (p = 0 é só A, p = 1 só B)
    float w = ${WIPE_SOFT};
    float s = u_dir.x > 0.0 ? uv.x : 1.0 - uv.x;
    float e = p * (1.0 + w) - 0.5 * w;
    float m = 1.0 - smoothstep(e - 0.5 * w, e + 0.5 * w, s);
    o = mix(texture(u_a, uv), texture(u_b, uv), m);
  } else if (u_mode == 4) {
    // zoom: A cresce de 1 a ${1 + ZOOM_A_GROW} em torno do centro e some; B aparece crescendo de ${ZOOM_B_FROM} a 1
    float sa = 1.0 + ${ZOOM_A_GROW.toFixed(2)} * p;
    float sb = ${ZOOM_B_FROM.toFixed(2)} + ${(1 - ZOOM_B_FROM).toFixed(2)} * p;
    vec4 a = at(u_a, 0.5 + (uv - 0.5) / sa, sa);
    vec4 b = at(u_b, 0.5 + (uv - 0.5) / sb, sb);
    o = mix(a, b, p);
  } else {
    o = mix(texture(u_a, uv), texture(u_b, uv), p);
  }
}`
