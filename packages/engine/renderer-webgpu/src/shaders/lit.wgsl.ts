/**
 * Built-in ABI 1 lit shader (04 §4, §5.14 M0 scope).
 *
 * One directional light, one ambient term, one base-colour texture, object
 * tint and per-object normal matrix. No shadows, point lights, IBL, normal
 * maps, skinning or morph targets: those are M1/M2.
 *
 * `static-pbr-v1` uses `vs_main`; `instanced-transform-v1` uses
 * `vs_instanced_main` with model columns at locations 3–6.
 */

export const LIT_VERTEX_ENTRY = "vs_main";
export const LIT_INSTANCED_VERTEX_ENTRY = "vs_instanced_main";
export const LIT_FRAGMENT_ENTRY = "fs_main";
export const LIT_UNLIT_FRAGMENT_ENTRY = "fs_unlit_main";

export const LIT_WGSL = /* wgsl */ `
struct FrameUniforms {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  time: vec4<f32>,
  ambient: vec4<f32>,
  resolution: vec4<f32>,
  fog: vec4<f32>,
  clip: vec4<f32>,
  reserved0: vec4<f32>,
  reserved1: vec4<f32>,
  reserved2: vec4<f32>,
  reserved3: vec4<f32>,
  reserved4: vec4<f32>,
  reserved5: vec4<f32>,
};

struct DirectionalLight {
  direction: vec4<f32>,
  colorIntensity: vec4<f32>,
};

struct PointLight {
  position: vec4<f32>,
  colorRange: vec4<f32>,
};

struct LightUniforms {
  counts: vec4<u32>,
  directional: array<DirectionalLight, 4>,
  cascadeMatrices: array<mat4x4<f32>, 3>,
  cascadeSplits: vec4<f32>,
  point: array<PointLight, 32>,
  shadowAtlas: vec4<f32>,
  reserved: array<vec4<f32>, 41>,
};

struct ObjectUniforms {
  model: mat4x4<f32>,
  normal0: vec4<f32>,
  normal1: vec4<f32>,
  normal2: vec4<f32>,
  tint: vec4<f32>,
  reserved: array<vec4<f32>, 8>,
};

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(1) @binding(0) var<uniform> lights: LightUniforms;
@group(2) @binding(0) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(1) var baseColorSampler: sampler;
@group(3) @binding(0) var<uniform> object: ObjectUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

struct InstanceInput {
  @location(3) model0: vec4<f32>,
  @location(4) model1: vec4<f32>,
  @location(5) model2: vec4<f32>,
  @location(6) model3: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) uv: vec2<f32>,
};

// Canvas formats exposed by the browser are not sRGB (measured in 2026-10-23;
// probing bgra8unorm-srgb / rgba8unorm-srgb throws in Chrome). The swapchain
// therefore stores exactly what the fragment shader writes, so encode linear
// light to sRGB once here. Base-colour textures are sampled through
// rgba8unorm-srgb and the sampler has already decoded them: do not decode
// again. Applied to the final colour only, never to alpha.
fn encodeSrgb(value: vec3<f32>) -> vec3<f32> {
  let linear = max(value, vec3<f32>(0.0));
  let low = linear * 12.92;
  let high = 1.055 * pow(linear, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(high, low, linear <= vec3<f32>(0.0031308));
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let world = object.model * vec4<f32>(input.position, 1.0);
  output.position = frame.viewProjection * world;
  let normalMatrix = mat3x3<f32>(
    object.normal0.xyz,
    object.normal1.xyz,
    object.normal2.xyz,
  );
  output.normal = normalMatrix * input.normal;
  output.uv = input.uv;
  return output;
}

@vertex
fn vs_instanced_main(input: VertexInput, instance: InstanceInput) -> VertexOutput {
  var output: VertexOutput;
  let instanceModel = mat4x4<f32>(
    instance.model0,
    instance.model1,
    instance.model2,
    instance.model3,
  );
  let model = object.model * instanceModel;
  let world = model * vec4<f32>(input.position, 1.0);
  output.position = frame.viewProjection * world;
  let normalMatrix = mat3x3<f32>(
    model[0].xyz,
    model[1].xyz,
    model[2].xyz,
  );
  output.normal = normalMatrix * input.normal;
  output.uv = input.uv;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let baseTexture = textureSample(baseColorTexture, baseColorSampler, input.uv);
  let normal = normalize(input.normal);
  let lightDirection = normalize(lights.directional[0].direction.xyz);
  let ndotl = max(dot(normal, lightDirection), 0.0);
  let ambient = frame.ambient.rgb * frame.ambient.w;
  let direct = lights.directional[0].colorIntensity.rgb
    * lights.directional[0].colorIntensity.w
    * ndotl;
  let lit = baseTexture.rgb * object.tint.rgb * (ambient + direct);
  return vec4<f32>(encodeSrgb(lit), 1.0);
}

// Opaque unlit path: base colour texture x tint, no light terms.
@fragment
fn fs_unlit_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let baseTexture = textureSample(baseColorTexture, baseColorSampler, input.uv);
  return vec4<f32>(encodeSrgb(baseTexture.rgb * object.tint.rgb), 1.0);
}
`;
