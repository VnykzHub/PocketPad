/**
 * GLSL ES 3.00 forward-lit program and fixed define registry (05 §4.3).
 *
 * M0 scope: one directional light, Lambert shading, one base-colour texture.
 * Metallic-roughness PBR, normal mapping, shadows, skinning and post are M1/M2
 * and are not declared here. Sources are checked in, never generated from
 * asset data, and variants are produced only by prepending fixed `#define`
 * lines.
 */

export const PROGRAM_FORWARD_LIT = "forward-lit";

/** Fixed compile-time variant list; bit positions are part of the ABI. */
export const FORWARD_DEFINES = {
  USE_INSTANCING: 1,
  ALPHA_TEST: 2,
  UNLIT: 4,
} as const;

export type ForwardDefineName = keyof typeof FORWARD_DEFINES;

export const FORWARD_DEFINE_LIST: readonly ForwardDefineName[] = [
  "USE_INSTANCING",
  "ALPHA_TEST",
  "UNLIT",
];

export const FRAME_UBO_BINDING = 0;
export const MATERIAL_UBO_BINDING = 1;
export const FRAME_UBO_BYTES = 128;
export const MATERIAL_UBO_BYTES = 64;

/** std140 frame block shared by the vertex and fragment stages. */
const FRAME_BLOCK_GLSL = `layout(std140) uniform FrameBlock {
  mat4 uViewProjection;
  vec4 uCameraPosition;
  vec4 uLightDirection;
  vec4 uLightColor;
  vec4 uTimeResolution;
};`;

const MATERIAL_BLOCK_GLSL = `layout(std140) uniform MaterialBlock {
  vec4 uBaseColorFactor;
  vec4 uMaterialParams;
  vec4 uEmissiveFactor;
  vec4 uTextureParams;
};`;

const VERTEX_BODY = `#version 300 es
precision highp float;
${FRAME_BLOCK_GLSL}
uniform mat4 uModel;
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
#ifdef USE_INSTANCING
layout(location = 3) in vec4 aModel0;
layout(location = 4) in vec4 aModel1;
layout(location = 5) in vec4 aModel2;
layout(location = 6) in vec4 aModel3;
#endif
out vec3 vNormal;
out vec2 vUv;
void main() {
#ifdef USE_INSTANCING
  mat4 model = mat4(aModel0, aModel1, aModel2, aModel3);
#else
  mat4 model = uModel;
#endif
  vec4 worldPosition = model * vec4(aPosition, 1.0);
  vNormal = mat3(model) * aNormal;
  vUv = aUv;
  gl_Position = uViewProjection * worldPosition;
}
`;

const FRAGMENT_BODY = `#version 300 es
precision highp float;
${FRAME_BLOCK_GLSL}
${MATERIAL_BLOCK_GLSL}
uniform sampler2D uBaseColorTexture;
in vec3 vNormal;
in vec2 vUv;
out vec4 outColor;
// The default framebuffer is not sRGB (measured in 2026-10-23: clear and
// shader 0.5 both read back 127, and EXT_sRGB_write_control is absent), so
// encode linear light to sRGB once here. SRGB8_ALPHA8 base-colour textures are
// decoded by the sampler; do not decode again. Alpha stays linear.
vec3 encodeSrgb(vec3 value) {
  vec3 linear = max(value, vec3(0.0));
  vec3 low = linear * 12.92;
  vec3 high = 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055;
  return mix(high, low, lessThanEqual(linear, vec3(0.0031308)));
}
void main() {
  vec4 baseColor = texture(uBaseColorTexture, vUv) * uBaseColorFactor;
#ifdef ALPHA_TEST
  if (baseColor.a < uMaterialParams.z) discard;
#endif
#ifdef UNLIT
  outColor = vec4(encodeSrgb(baseColor.rgb), baseColor.a);
#else
  vec3 normal = normalize(vNormal);
  float diffuse = max(dot(normal, normalize(uLightDirection.xyz)), 0.0);
  vec3 ambient = uLightColor.w * uLightColor.rgb;
  vec3 lit = baseColor.rgb * (ambient + diffuse * uLightDirection.w * uLightColor.rgb);
  outColor = vec4(encodeSrgb(lit), baseColor.a);
#endif
}
`;

function defineLines(mask: number): string {
  let lines = "";
  for (let index = 0; index < FORWARD_DEFINE_LIST.length; index += 1) {
    const name = FORWARD_DEFINE_LIST[index];
    if (name === undefined) continue;
    const bit = FORWARD_DEFINES[name];
    if ((mask & bit) !== 0) lines += `#define ${name} 1\n`;
  }
  return lines;
}

/** Prepends the variant defines after the mandatory `#version` line. */
export function withForwardDefines(source: string, mask: number): string {
  const defines = defineLines(mask);
  if (defines.length === 0) return source;
  const versionEnd = source.indexOf("\n");
  if (versionEnd < 0) return `${source}\n${defines}`;
  return `${source.slice(0, versionEnd + 1)}${defines}${source.slice(versionEnd + 1)}`;
}

/** Whether a bit mask uses only declared variant bits. */
export function isForwardDefineMask(mask: number): boolean {
  const all = FORWARD_DEFINES.USE_INSTANCING | FORWARD_DEFINES.ALPHA_TEST | FORWARD_DEFINES.UNLIT;
  return Number.isInteger(mask) && mask >= 0 && (mask & ~all) === 0;
}

export function forwardLitVertexSource(mask: number): string {
  return withForwardDefines(VERTEX_BODY, mask);
}

export function forwardLitFragmentSource(mask: number): string {
  return withForwardDefines(FRAGMENT_BODY, mask);
}

/** Source without variant defines; the fixed ABI attribute set. */
export const FORWARD_LIT_VERTEX_SOURCE = VERTEX_BODY;
export const FORWARD_LIT_FRAGMENT_SOURCE = FRAGMENT_BODY;
