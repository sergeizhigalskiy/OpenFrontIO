/**
 * Sprite atlases uploaded side by side, left to right, into one texture.
 *
 * The art for the naval-defense and conventional-war units lives in small
 * extension atlases (unit-atlas-ext.png, icon-atlas-ext.png, drawn by
 * scripts/genUnitArt.ts) rather than in the base atlases, so the base PNGs
 * never need re-packing. A pass loads its base atlas and its extension and
 * uploads them as one strip, so its columns continue across the seam: the
 * extension's first column comes right after the base atlas's last.
 */

/** Loads and decodes the images, in order. */
export function loadAtlasImages(
  urls: readonly string[],
): Promise<HTMLImageElement[]> {
  return Promise.all(
    urls.map(async (url) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = url;
      await img.decode();
      return img;
    }),
  );
}

/**
 * Uploads `images` (all the same height) left to right into the texture bound
 * to TEXTURE_2D, sized to fit them all.
 */
export function uploadAtlasStrip(
  gl: WebGL2RenderingContext,
  images: readonly HTMLImageElement[],
): void {
  const width = images.reduce((w, img) => w + img.width, 0);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    images[0].height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  let x = 0;
  for (const img of images) {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, 0, gl.RGBA, gl.UNSIGNED_BYTE, img);
    x += img.width;
  }
}
