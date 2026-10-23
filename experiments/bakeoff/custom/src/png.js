/**
 * PNG → RGBA8 for the car's embedded Kenney colormap.
 *
 * The engine asset library decodes PNG assets declared in its manifest, but
 * `car.glb` embeds its colormap inside the GLB and the engine's M0 glTF
 * loader rejects the car (five meshes). The contender therefore extracts the
 * PNG bytes with `extractImage` and decodes them here through the browser's
 * own decoder (`createImageBitmap` + a 2D canvas readback). No third-party
 * image decoder is bundled.
 */

/**
 * Decodes PNG bytes to tightly packed, unpremultiplied RGBA8, top row first.
 * @param {Uint8Array} bytes
 * @param {string} label used in error messages
 * @returns {Promise<{width: number, height: number, data: Uint8ClampedArray}>}
 */
export async function decodePngRgba(bytes, label) {
  if (typeof createImageBitmap !== "function") {
    throw new Error(`${label}: createImageBitmap is unavailable`);
  }
  const blob = new Blob([bytes], { type: "image/png" });
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (error) {
    throw new Error(`${label}: PNG decode failed: ${String(error)}`);
  }
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(width, height)
      : document.createElement("canvas");
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    bitmap.close?.();
    throw new Error(`${label}: 2D canvas is unavailable`);
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const image = context.getImageData(0, 0, width, height);
  if (image.data.length !== width * height * 4) {
    throw new Error(`${label}: unexpected RGBA length ${image.data.length}`);
  }
  return { width, height, data: image.data };
}

/**
 * Uploads decoded RGBA as an sRGB base-colour texture with repeat sampling.
 * `device` is the engine RenderDevice; the returned handle is a TextureHandle.
 */
export function createTextureFromRgba(device, label, image) {
  return device.createTexture({
    label,
    width: image.width,
    height: image.height,
    format: "rgba8unorm-srgb",
    usage: ["sample", "copy-dst"],
    mipLevels: 1,
    data: [
      {
        mipLevel: 0,
        layer: 0,
        bytes: image.data,
        bytesPerRow: image.width * 4,
      },
    ],
    sampler: {
      label: `${label}-sampler`,
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "nearest",
      addressU: "repeat",
      addressV: "repeat",
    },
  });
}
