"use strict";

/**
 * PocketPad GPU verification rig, scene v1.
 *
 * Renders one lit triangle offscreen at a fixed 256x256, reads the pixels back,
 * and hashes the top-down RGBA8 bytes with FNV-1a (32-bit). Every render is
 * done twice and the raw bytes must match, so a non-deterministic backend is
 * reported as an error instead of a hash.
 *
 * No time, randomness, input, network, or asset loading is involved. The
 * result is exposed as window.__GPU_RIG__ for the headless runner.
 */
(() => {
  const SCENE = "lit-triangle-v1";
  const WIDTH = 256;
  const HEIGHT = 256;
  const BYTES_PER_PIXEL = 4;
  const ROW_BYTES = WIDTH * BYTES_PER_PIXEL;
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;
  const WEBGPU_TIMEOUT_MS = 10000;

  let published = false;
  // The runner treats this flag as "the object is ready". It is set only after
  // window.__GPU_RIG__, so a true reading never sees a half-built result.
  window.__GPU_RIG_DONE__ = false;

  // Clear color is defined in bytes so both backends receive the same values.
  const CLEAR_BYTES = [18, 24, 38, 255];
  const CLEAR_FLOATS = CLEAR_BYTES.map((value) => value / 255);

  const REQUESTED = normalizeBackend(new URLSearchParams(location.search).get("backend"));
  const statusElement = document.getElementById("status");
  const viewCanvas = document.getElementById("view");

  const WGSL = `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-0.65, -0.55),
    vec2<f32>( 0.65, -0.55),
    vec2<f32>( 0.00,  0.75)
  );
  var colors = array<vec3<f32>, 3>(
    vec3<f32>(0.95, 0.25, 0.20),
    vec3<f32>(0.20, 0.85, 0.40),
    vec3<f32>(0.25, 0.45, 0.95)
  );
  var normals = array<vec3<f32>, 3>(
    vec3<f32>(-0.30, -0.20, 1.00),
    vec3<f32>( 0.40, -0.10, 1.00),
    vec3<f32>( 0.00,  0.50, 1.00)
  );

  var output: VertexOutput;
  output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  output.color = colors[vertexIndex];
  output.normal = normals[vertexIndex];
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let lightDirection = normalize(vec3<f32>(0.35, 0.45, 1.00));
  let lambert = max(dot(normalize(input.normal), lightDirection), 0.0);
  return vec4<f32>(input.color * (0.20 + 0.80 * lambert), 1.0);
}
`;

  const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
in vec3 aColor;
in vec3 aNormal;
out vec3 vColor;
out vec3 vNormal;

void main() {
  vColor = aColor;
  vNormal = aNormal;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

  const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vColor;
in vec3 vNormal;
out vec4 outColor;

void main() {
  vec3 lightDirection = normalize(vec3(0.35, 0.45, 1.00));
  float lambert = max(dot(normalize(vNormal), lightDirection), 0.0);
  outColor = vec4(vColor * (0.20 + 0.80 * lambert), 1.0);
}
`;

  function normalizeBackend(value) {
    return value === "webgpu" || value === "webgl2" ? value : "auto";
  }

  function errorMessage(error) {
    if (error && typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    return String(error);
  }

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms} ms`)),
        ms,
      );
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function fnv1a(bytes) {
    let hash = FNV_OFFSET_BASIS;
    for (let index = 0; index < bytes.length; index += 1) {
      hash ^= bytes[index];
      hash = Math.imul(hash, FNV_PRIME);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function sameBytes(left, right) {
    if (left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        return false;
      }
    }
    return true;
  }

  // WebGL's readPixels origin is bottom-left. Normalize every backend to
  // top-down RGBA8 so the hash and the on-page image have one orientation.
  function flipRowsToTopDown(bytes) {
    const output = new Uint8Array(bytes.length);
    for (let row = 0; row < HEIGHT; row += 1) {
      const sourceStart = (HEIGHT - 1 - row) * ROW_BYTES;
      output.set(
        bytes.subarray(sourceStart, sourceStart + ROW_BYTES),
        row * ROW_BYTES,
      );
    }
    return output;
  }

  function showPixels(rgba) {
    if (!viewCanvas) {
      return;
    }
    const context = viewCanvas.getContext("2d");
    if (!context || typeof ImageData !== "function") {
      return;
    }
    context.putImageData(
      new ImageData(new Uint8ClampedArray(rgba), WIDTH, HEIGHT),
      0,
      0,
    );
  }

  function setStatus(text) {
    if (statusElement) {
      statusElement.textContent = text;
    }
  }

  function publish(result) {
    if (published) {
      return;
    }
    published = true;
    const rig = {
      scene: SCENE,
      backend: result.backend,
      hash: result.hash ?? null,
      drawCalls: result.drawCalls ?? 0,
      width: WIDTH,
      height: HEIGHT,
      error: result.error ?? null,
      requestedBackend: REQUESTED,
      stable: result.stable === true,
      backendInfo: result.backendInfo ?? null,
      fallbackReason: result.fallbackReason ?? null,
    };
    window.__GPU_RIG__ = rig;
    window.__GPU_RIG_DONE__ = true;

    const adapterText = rig.backendInfo
      ? rig.backendInfo.description ||
        rig.backendInfo.renderer ||
        rig.backendInfo.device ||
        ""
      : "";
    const lines = [
      `backend: ${rig.backend}`,
      `hash: ${rig.hash ?? "none"}`,
      `stable: ${rig.stable}`,
      `draw calls per frame: ${rig.drawCalls}`,
      `size: ${rig.width}x${rig.height}`,
      adapterText ? `adapter: ${adapterText}` : "",
      rig.fallbackReason ? `fallback: ${rig.fallbackReason}` : "",
      rig.error ? `error: ${rig.error}` : "",
    ].filter(Boolean);

    setStatus(lines.join("\n"));
    document.title = `gpu-rig ${rig.backend} ${rig.hash ?? "error"}`;
  }

  function readAdapterInfo(adapter) {
    const info = {
      vendor: "",
      architecture: "",
      device: "",
      description: "",
      isFallbackAdapter: null,
    };
    try {
      const adapterInfo = adapter.info || {};
      info.vendor = adapterInfo.vendor || "";
      info.architecture = adapterInfo.architecture || "";
      info.device = adapterInfo.device || "";
      info.description = adapterInfo.description || "";
    } catch {
      // Adapter info is optional diagnostics; never fail the render over it.
    }
    try {
      if (typeof adapter.isFallbackAdapter === "boolean") {
        info.isFallbackAdapter = adapter.isFallbackAdapter;
      }
    } catch {
      // Ignore.
    }
    return info;
  }

  async function renderWebGPU() {
    if (!navigator.gpu) {
      throw new Error(
        "navigator.gpu is undefined (WebGPU is not available in this browser/headless configuration)",
      );
    }
    for (const globalName of [
      "GPUTextureUsage",
      "GPUBufferUsage",
      "GPUMapMode",
    ]) {
      if (typeof globalThis[globalName] === "undefined") {
        throw new Error(`WebGPU global ${globalName} is missing`);
      }
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error(
        "navigator.gpu.requestAdapter() returned null (no compatible WebGPU adapter)",
      );
    }

    let device;
    try {
      device = await adapter.requestDevice();
    } catch (error) {
      throw new Error(`adapter.requestDevice() failed: ${errorMessage(error)}`);
    }

    const backendInfo = { api: "webgpu", ...readAdapterInfo(adapter) };
    try {
      const work = (async () => {
        const texture = device.createTexture({
          size: [WIDTH, HEIGHT],
          format: "rgba8unorm",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });

        try {
          const textureView = texture.createView();
          const module = device.createShaderModule({ code: WGSL });
          if (typeof module.getCompilationInfo === "function") {
            const compilationInfo = await module.getCompilationInfo();
            for (const message of compilationInfo.messages) {
              if (message.type === "error") {
                throw new Error(`WGSL compile error: ${message.message}`);
              }
            }
          }

          device.pushErrorScope("validation");
          const pipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: { module, entryPoint: "vertexMain" },
            fragment: {
              module,
              entryPoint: "fragmentMain",
              targets: [{ format: "rgba8unorm" }],
            },
            primitive: { topology: "triangle-list" },
          });

          const renderOnce = async () => {
            const buffer = device.createBuffer({
              size: ROW_BYTES * HEIGHT,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
              colorAttachments: [
                {
                  view: textureView,
                  clearValue: {
                    r: CLEAR_FLOATS[0],
                    g: CLEAR_FLOATS[1],
                    b: CLEAR_FLOATS[2],
                    a: CLEAR_FLOATS[3],
                  },
                  loadOp: "clear",
                  storeOp: "store",
                },
              ],
            });
            pass.setPipeline(pipeline);
            pass.draw(3);
            pass.end();
            encoder.copyTextureToBuffer(
              { texture },
              {
                buffer,
                bytesPerRow: ROW_BYTES,
                rowsPerImage: HEIGHT,
              },
              { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            );
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const pixels = new Uint8Array(buffer.getMappedRange()).slice();
            buffer.unmap();
            buffer.destroy();
            return pixels;
          };

          const first = await renderOnce();
          const second = await renderOnce();
          const validationError = await device.popErrorScope();
          if (validationError) {
            throw new Error(
              `WebGPU validation error: ${validationError.message}`,
            );
          }
          if (!sameBytes(first, second)) {
            throw new Error(
              `WebGPU readback is not stable: ${fnv1a(first)} !== ${fnv1a(second)}`,
            );
          }
          showPixels(first);
          return {
            backend: "webgpu",
            hash: fnv1a(first),
            drawCalls: 1,
            stable: true,
            error: null,
            backendInfo,
            fallbackReason: null,
          };
        } finally {
          texture.destroy();
        }
      })();
      // Attach a handler immediately so a timeout or device loss cannot
      // surface as an unhandled rejection.
      work.catch(() => {});
      return await withTimeout(
        work,
        WEBGPU_TIMEOUT_MS,
        "WebGPU render/readback",
      );
    } finally {
      try {
        device.destroy();
      } catch {
        // Ignore device teardown failures.
      }
    }
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error("WebGL2 createShader returned null");
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || "unknown shader compile error";
      gl.deleteShader(shader);
      throw new Error(
        `WebGL2 ${type === gl.VERTEX_SHADER ? "vertex" : "fragment"} shader failed: ${log}`,
      );
    }
    return shader;
  }

  function checkGlError(gl, label) {
    const code = gl.getError();
    if (code !== gl.NO_ERROR) {
      throw new Error(`${label} failed with WebGL error 0x${code.toString(16)}`);
    }
  }

  function renderWebGL2Fallback(fallbackReason) {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      failIfMajorPerformanceCaveat: false,
    });
    if (!gl) {
      throw new Error(
        "WebGL2 context creation returned null (WebGL2 is unavailable)",
      );
    }

    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const backendInfo = {
      api: "webgl2",
      vendor: debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
        : gl.getParameter(gl.VENDOR),
      renderer: debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    };

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) {
      throw new Error("WebGL2 createProgram returned null");
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || "unknown program link error";
      throw new Error(`WebGL2 program link failed: ${log}`);
    }

    const vertexData = new Float32Array([
      // x, y, r, g, b, nx, ny, nz
      -0.65, -0.55, 0.95, 0.25, 0.2, -0.3, -0.2, 1.0,
      0.65, -0.55, 0.2, 0.85, 0.4, 0.4, -0.1, 1.0,
      0.0, 0.75, 0.25, 0.45, 0.95, 0.0, 0.5, 1.0,
    ]);
    const vertexArray = gl.createVertexArray();
    if (!vertexArray) {
      throw new Error("WebGL2 createVertexArray returned null");
    }
    gl.bindVertexArray(vertexArray);
    const vertexBuffer = gl.createBuffer();
    if (!vertexBuffer) {
      throw new Error("WebGL2 createBuffer returned null");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);

    const stride = 8 * 4;
    const positionLocation = gl.getAttribLocation(program, "aPosition");
    const colorLocation = gl.getAttribLocation(program, "aColor");
    const normalLocation = gl.getAttribLocation(program, "aNormal");
    if (positionLocation < 0 || colorLocation < 0 || normalLocation < 0) {
      throw new Error("WebGL2 vertex attribute location lookup failed");
    }
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(colorLocation);
    gl.vertexAttribPointer(colorLocation, 3, gl.FLOAT, false, stride, 2 * 4);
    gl.enableVertexAttribArray(normalLocation);
    gl.vertexAttribPointer(normalLocation, 3, gl.FLOAT, false, stride, 5 * 4);

    const targetTexture = gl.createTexture();
    if (!targetTexture) {
      throw new Error("WebGL2 createTexture returned null");
    }
    gl.bindTexture(gl.TEXTURE_2D, targetTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      WIDTH,
      HEIGHT,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      throw new Error("WebGL2 createFramebuffer returned null");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      targetTexture,
      0,
    );
    const framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (framebufferStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(
        `WebGL2 framebuffer incomplete: 0x${framebufferStatus.toString(16)}`,
      );
    }

    gl.viewport(0, 0, WIDTH, HEIGHT);
    gl.disable(gl.DITHER);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.clearColor(
      CLEAR_FLOATS[0],
      CLEAR_FLOATS[1],
      CLEAR_FLOATS[2],
      CLEAR_FLOATS[3],
    );
    gl.useProgram(program);
    gl.bindVertexArray(vertexArray);
    checkGlError(gl, "WebGL2 setup");

    const renderOnce = () => {
      if (gl.isContextLost()) {
        throw new Error("WebGL2 context lost during render");
      }
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.finish();
      const pixels = new Uint8Array(WIDTH * HEIGHT * BYTES_PER_PIXEL);
      gl.readPixels(
        0,
        0,
        WIDTH,
        HEIGHT,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      checkGlError(gl, "WebGL2 draw/readback");
      return flipRowsToTopDown(pixels);
    };

    const first = renderOnce();
    const second = renderOnce();
    if (!sameBytes(first, second)) {
      throw new Error(
        `WebGL2 readback is not stable: ${fnv1a(first)} !== ${fnv1a(second)}`,
      );
    }
    showPixels(first);
    return {
      backend: "webgl2",
      hash: fnv1a(first),
      drawCalls: 1,
      stable: true,
      error: null,
      backendInfo,
      fallbackReason,
    };
  }

  async function main() {
    if (REQUESTED === "webgl2") {
      return renderWebGL2Fallback(null);
    }

    if (!navigator.gpu) {
      const reason =
        "navigator.gpu is undefined (WebGPU is not available in this browser/headless configuration)";
      if (REQUESTED === "webgpu") {
        throw new Error(reason);
      }
      return renderWebGL2Fallback(reason);
    }

    try {
      return await renderWebGPU();
    } catch (error) {
      const reason = `WebGPU path failed: ${errorMessage(error)}`;
      if (REQUESTED === "webgpu") {
        throw new Error(reason);
      }
      return renderWebGL2Fallback(reason);
    }
  }

  window.addEventListener("error", (event) => {
    if (window.__GPU_RIG__) {
      return;
    }
    const detail =
      event.error && event.error.message ? event.error.message : event.message;
    publish({
      backend: REQUESTED === "webgpu" ? "webgpu" : "webgl2",
      hash: null,
      drawCalls: 0,
      stable: false,
      error: `uncaught page error: ${detail || "unknown"}`,
      backendInfo: null,
      fallbackReason: null,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (window.__GPU_RIG__) {
      return;
    }
    publish({
      backend: REQUESTED === "webgpu" ? "webgpu" : "webgl2",
      hash: null,
      drawCalls: 0,
      stable: false,
      error: `unhandled page rejection: ${errorMessage(event.reason)}`,
      backendInfo: null,
      fallbackReason: null,
    });
  });

  main()
    .then((result) => publish(result))
    .catch((error) => {
      publish({
        backend: REQUESTED === "webgpu" ? "webgpu" : "webgl2",
        hash: null,
        drawCalls: 0,
        stable: false,
        error: errorMessage(error),
        backendInfo: null,
        fallbackReason: null,
      });
    });
})();
