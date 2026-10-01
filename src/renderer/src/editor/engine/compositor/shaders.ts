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
