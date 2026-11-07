/**
 * DetailTextures — the tileable ground detail the terrain shader layers over
 * the biome colours: grass, dry grass, sand, rock strata, snow, tundra,
 * dirt, and a wave normal map for water. Generated on the GPU at load
 * (shaders/relief/detail-gen.frag.glsl) into the layers of a mipmapped
 * TEXTURE_2D_ARRAY, so nothing is downloaded and the art is all our own.
 *
 * Per texel: R albedo multiplier / 2, GB normal xy, A height (crests on the
 * water layer). See the generator for each layer's recipe.
 */

import genFragSrc from "../shaders/relief/detail-gen.frag.glsl?raw";
import fullscreenVertSrc from "../shaders/shared/fullscreen.vert.glsl?raw";
import { createFullscreenQuad, createProgram } from "../utils/GlUtils";

/** Texels per side of each layer. */
export const DETAIL_SIZE = 256;

/** Layer indices (DETAIL_* in terrain.frag.glsl). */
export const DetailLayer = {
  Grass: 0,
  Dry: 1,
  Sand: 2,
  Rock: 3,
  Snow: 4,
  Tundra: 5,
  Dirt: 6,
  Water: 7,
} as const;
export const DETAIL_LAYERS = 8;

export function createDetailTextures(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  const levels = Math.log2(DETAIL_SIZE) + 1;
  gl.texStorage3D(
    gl.TEXTURE_2D_ARRAY,
    levels,
    gl.RGBA8,
    DETAIL_SIZE,
    DETAIL_SIZE,
    DETAIL_LAYERS,
  );
  gl.texParameteri(
    gl.TEXTURE_2D_ARRAY,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  const ext = gl.getExtension("EXT_texture_filter_anisotropic");
  if (ext !== null) {
    const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
    gl.texParameterf(
      gl.TEXTURE_2D_ARRAY,
      ext.TEXTURE_MAX_ANISOTROPY_EXT,
      Math.min(8, max),
    );
  }

  const program = createProgram(
    gl,
    fullscreenVertSrc,
    genFragSrc,
    "DetailTextures",
  );
  const uLayer = gl.getUniformLocation(program, "uLayer");
  gl.useProgram(program);
  gl.uniform1f(gl.getUniformLocation(program, "uSize"), DETAIL_SIZE);
  const vao = createFullscreenQuad(gl);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, DETAIL_SIZE, DETAIL_SIZE);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(vao);
  for (let layer = 0; layer < DETAIL_LAYERS; layer++) {
    gl.framebufferTextureLayer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      tex,
      0,
      layer,
    );
    gl.uniform1i(uLayer, layer);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteVertexArray(vao);
  gl.deleteProgram(program);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  return tex;
}
