// Shaders GLSL ES 3.0 do compositor F1. Quad local a ∈ [0,1]² (x para a direita, y para baixo);
// a matriz da camada (matrix.ts) leva ao clip space. Saída com alpha pré-multiplicado
// (blend ONE, ONE_MINUS_SRC_ALPHA).

export const VS_QUAD = `#version 300 es
in vec2 a_pos;
uniform mat3 u_mat;
out vec2 v_a;
void main() {
  v_a = a_pos;
  gl_Position = vec4((u_mat * vec3(a_pos, 1.0)).xy, 0.0, 1.0);
}`

// Máscara de forma por distância com sinal, em pixels do canvas; antialias por fwidth.
// u_shape: 0 retângulo, 1 arredondado (u_radius px), 2 círculo inscrito (lado = menor dimensão).
const SHAPE = `
uniform vec2 u_size;
uniform float u_shape;
uniform float u_radius;
float shapeDist(vec2 a) {
  vec2 q = (a - 0.5) * u_size;
  float m = 0.5 * min(u_size.x, u_size.y);
  if (u_shape > 1.5) return length(q) - m;
  float r = u_shape > 0.5 ? min(u_radius, m) : 0.0;
  vec2 d = abs(q) - (0.5 * u_size - r);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
float coverage(float dist, float fw) { return clamp(0.5 - dist / fw, 0.0, 1.0); }
`

// Mídia: recorte (u_uv na imagem exibida), rotação da fonte (u_rot: 0..3 = 0/90/180/270° horário),
// espelho, ajuste (brilho/contraste/saturação, neutros em 0, faixa −1..1), opacidade, forma e borda interna.
export const FS_MEDIA = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec4 u_uv;
uniform float u_rot;
uniform float u_mirror;
uniform float u_opacity;
uniform vec3 u_adjust;
uniform float u_border;
uniform vec4 u_borderColor;
in vec2 v_a;
out vec4 o;
${SHAPE}
void main() {
  vec2 d = mix(u_uv.xy, u_uv.zw, vec2(u_mirror > 0.5 ? 1.0 - v_a.x : v_a.x, v_a.y));
  vec2 tc = d;
  if (u_rot > 2.5) tc = vec2(1.0 - d.y, d.x);
  else if (u_rot > 1.5) tc = 1.0 - d;
  else if (u_rot > 0.5) tc = vec2(d.y, 1.0 - d.x);
  vec4 c = texture(u_tex, tc);
  vec3 rgb = c.rgb + u_adjust.x;
  rgb = (rgb - 0.5) * (1.0 + u_adjust.y) + 0.5;
  float g = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = clamp(mix(vec3(g), rgb, 1.0 + u_adjust.z), 0.0, 1.0);
  float a = c.a;
  float dist = shapeDist(v_a);
  float fw = max(fwidth(dist), 1e-4);
  if (u_border > 0.0) {
    float b = clamp(0.5 + (dist + u_border) / fw, 0.0, 1.0) * u_borderColor.a;
    rgb = mix(rgb, u_borderColor.rgb, b);
    a = mix(a, 1.0, b);
  }
  float alpha = a * coverage(dist, fw) * u_opacity;
  o = vec4(rgb * alpha, alpha);
}`

// Sólido: placeholder "mídia indisponível" (xadrez cinza, u_checker = 1) ou cor (contorno de seleção).
// u_mask = 0 desliga a máscara de forma (linhas).
export const FS_SOLID = `#version 300 es
precision highp float;
uniform float u_checker;
uniform vec4 u_color;
uniform float u_opacity;
uniform float u_mask;
in vec2 v_a;
out vec4 o;
${SHAPE}
void main() {
  vec3 rgb = u_color.rgb;
  float a = u_color.a;
  if (u_checker > 0.5) {
    vec2 p = floor(v_a * u_size / 16.0);
    rgb = mix(vec3(0.33), vec3(0.45), mod(p.x + p.y, 2.0));
    a = 1.0;
  }
  float cov = 1.0;
  if (u_mask > 0.5) {
    float dist = shapeDist(v_a);
    cov = coverage(dist, max(fwidth(dist), 1e-4));
  }
  float alpha = a * cov * u_opacity;
  o = vec4(rgb * alpha, alpha);
}`

// ---- passe de efeitos (effects.ts) ----
// Passes de tela cheia: o quad [0,1]² cobre o alvo inteiro e o scissor limita a área processada.
// Coordenadas por gl_FragCoord (px do alvo, origem embaixo à esquerda); texturas na convenção GL.

/** Máximo de amostras de cada lado do kernel do blur (tamanho do array de pesos). */
export const BLUR_MAX_TAPS = 32

export const VS_FULL = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0); }`

// Cópia 1:1 do texel (composição premultiplicada de uma camada isolada sobre o acumulado).
export const FS_COPY = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
out vec4 o;
void main() { o = texelFetch(u_tex, ivec2(gl_FragCoord.xy), 0); }`

// Redução u_ds× (2/4/8) alinhada ao quadro inteiro: média da caixa ds×ds com (ds/2)² amostras bilineares
// (cada uma já é a média de 2×2). Fora do quadro: CLAMP_TO_EDGE (borda repetida, sem preto).
export const FS_DOWN = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_srcSize;
uniform int u_ds;
out vec4 o;
void main() {
  vec2 c = (floor(gl_FragCoord.xy) + 0.5) * float(u_ds);
  int n = u_ds / 2;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    if (j >= n) break;
    for (int i = 0; i < 4; i++) {
      if (i >= n) break;
      vec2 off = vec2(float(2 * i - n + 1), float(2 * j - n + 1));
      acc += texture(u_src, (c + off) / u_srcSize);
    }
  }
  o = acc / float(n * n);
}`

// Blur gaussiano separável (u_dir = (1,0) ou (0,1)); pesos calculados na CPU (effectsMath.gaussianWeights),
// u_w[0] = centro. Amostras clampadas à textura (região que sai do quadro repete a borda).
export const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform ivec2 u_dir;
uniform int u_n;
uniform float u_w[${BLUR_MAX_TAPS + 1}];
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 mx = textureSize(u_tex, 0) - 1;
  vec4 acc = texelFetch(u_tex, p, 0) * u_w[0];
  for (int i = 1; i <= ${BLUR_MAX_TAPS}; i++) {
    if (i > u_n) break;
    acc += (texelFetch(u_tex, clamp(p + u_dir * i, ivec2(0), mx), 0) + texelFetch(u_tex, clamp(p - u_dir * i, ivec2(0), mx), 0)) * u_w[i];
  }
  o = acc;
}`

// Pixelização: bloco de u_q/256 px (effectsMath.pixelCellQ). O pixel i (centro i + ½) é do bloco
// ((2i + 1)·128) / u_q em inteiros: conta exata, idêntica nos três shaders e no teste (com divisão em float a GPU
// arredondava diferente em cada shader e a linha da borda do bloco caía no bloco vizinho).
// Passe 1 (horizontal): texel (bx, j) = média dos pixels da linha j do bloco bx (grade presa ao quadro). Média da
// caixa inteira, não um ponto: com conteúdo andando sob a grade, cada quadro amostrar pontos diferentes refaria o detalhe.
export const FS_PIXH = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform int u_q;
out vec4 o;
void main() {
  int bx = int(gl_FragCoord.x);
  int j = int(gl_FragCoord.y);
  int mx = textureSize(u_src, 0).x - 1;
  int x0 = max(0, bx * u_q / 256 - 1);
  int x1 = min(mx, (bx + 1) * u_q / 256 + 1);
  vec4 acc = vec4(0.0);
  float n = 0.0;
  for (int x = x0; x <= x1; x++) {
    if ((2 * x + 1) * 128 / u_q != bx) continue;
    acc += texelFetch(u_src, ivec2(x, j), 0);
    n += 1.0;
  }
  o = n > 0.0 ? acc / n : vec4(0.0);
}`

// Pixelização, passe 2 (vertical): texel (bx, by) = média das linhas do bloco by (by contado de CIMA, como pd em
// FS_APPLY: linha GL j ↔ k = H − 1 − j) no resultado do passe 1 → média exata do bloco.
export const FS_PIXV = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform int u_q;
uniform int u_h;
out vec4 o;
void main() {
  int bx = int(gl_FragCoord.x);
  int by = int(gl_FragCoord.y);
  int k0 = max(0, by * u_q / 256 - 1);
  int k1 = min(u_h - 1, (by + 1) * u_q / 256 + 1);
  vec4 acc = vec4(0.0);
  float n = 0.0;
  for (int k = k0; k <= k1; k++) {
    if ((2 * k + 1) * 128 / u_q != by) continue;
    acc += texelFetch(u_tex, ivec2(bx, u_h - 1 - k), 0);
    n += 1.0;
  }
  o = n > 0.0 ? acc / n : vec4(0.0);
}`

// Aplicação do efeito com máscara: u_src = cópia do que está abaixo (W×H), u_fx = resultado do blur (escala 1/ds)
// ou, na pixelização, a média de cada bloco (texel (bx, by), by de cima).
// Região em px do quadro com y para baixo: centro, meia-largura/altura, rotação horária (cos, sin); máscara
// 1 dentro, borda suave para FORA com largura u_feather (0 = borda dura, cobre exatamente a região);
// u_invert: efeito fora da região, borda suave para DENTRO dela (fora = 100 % efeito). u_mode: 0 blur, 1 pixelização (média do bloco, grade presa ao quadro), 2 sólido
// (cor exata; × alpha do que está abaixo, que no acumulado é 1). mix com m ∈ {0,1} devolve os pixels exatos.
export const FS_APPLY = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_fx;
uniform vec2 u_fxScale;
uniform vec2 u_frame;
uniform int u_mode;
uniform int u_q;
uniform vec3 u_color;
uniform vec2 u_center;
uniform vec2 u_half;
uniform vec2 u_rot;
uniform int u_shape;
uniform float u_feather;
uniform int u_invert;
out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = texelFetch(u_src, ivec2(p), 0);
  vec2 pd = vec2(p.x, u_frame.y - p.y);
  vec2 d = pd - u_center;
  vec2 l = vec2(u_rot.x * d.x + u_rot.y * d.y, -u_rot.y * d.x + u_rot.x * d.y);
  vec2 hl = max(u_half, vec2(1e-3));
  float dist;
  if (u_shape == 1) {
    // distância aproximada à elipse (f·(f−1)/|∇f|); fora, nunca abaixo da cota (f−1)·min(a,b) — garante a cauda
    // do feather dentro da caixa de regionScissor (mesma conta em effectsMath.regionDistPx)
    float f = length(l / hl);
    float g = length(l / (hl * hl));
    dist = g > 1e-6 ? f * (f - 1.0) / g : -min(hl.x, hl.y);
    if (f > 1.0) dist = max(dist, (f - 1.0) * min(hl.x, hl.y));
  } else {
    vec2 q = abs(l) - hl;
    dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  }
  float m;
  if (u_invert == 1) {
    // invertido: a borda suave cresce para DENTRO da região; tudo fora dela recebe o efeito por inteiro
    m = u_feather > 0.0 ? smoothstep(-u_feather, 0.0, dist) : (dist <= 0.0 ? 0.0 : 1.0);
  } else {
    m = u_feather > 0.0 ? 1.0 - smoothstep(0.0, u_feather, dist) : (dist <= 0.0 ? 1.0 : 0.0);
  }
  vec4 e;
  if (u_mode == 0) {
    e = texture(u_fx, p * u_fxScale);
  } else if (u_mode == 1) {
    // pixel (i, k), k contado de cima como pd; bloco pela mesma conta inteira dos passes
    ivec2 ik = ivec2(int(p.x), int(u_frame.y) - 1 - int(p.y));
    e = texelFetch(u_fx, (2 * ik + 1) * 128 / u_q, 0);
  } else {
    e = vec4(u_color * s.a, s.a);
  }
  o = mix(s, e, m);
}`
