/**
 * The camera uniform block shared by every map shader (shaders/shared/
 * camera.glsl). Pure layout code; CameraUniforms owns the GL buffer.
 *
 * A shader opts in with `#include "camera"` (expanded by createProgram) and
 * places geometry with groundToClip / anchoredToClip / billboardToClip. No
 * pass uploads a camera uniform of its own: the renderer fills and binds this
 * block once per frame, so a new pass only has to include it.
 */

import type { CameraFrame } from "./CameraMath";

/** The `#include` line createProgram replaces with camera.glsl. */
export const CAMERA_INCLUDE = '#include "camera"';
/** Name of the uniform block in camera.glsl. */
export const CAMERA_BLOCK_NAME = "CameraBlock";
/**
 * Uniform-buffer binding point. Every block starts bound to 0 after link,
 * and the camera block is the only one, so programs need no binding call.
 */
export const CAMERA_BLOCK_BINDING = 0;
/** Texture unit the height map lives on for vertex shaders (passes use 0-9). */
export const HEIGHT_MAP_UNIT = 15;
/** Sampler name in camera.glsl, pointed at HEIGHT_MAP_UNIT by createProgram. */
export const HEIGHT_MAP_SAMPLER = "uHeightMap";

/** Floats in the std140 block: mat4 + five vec4. */
export const CAMERA_BLOCK_FLOATS = 16 + 4 * 5;

export interface SurfaceParams {
  mapW: number;
  mapH: number;
  /**
   * World height per unit of the height-map R channel (0..1), or 0 when the
   * ground is flat (no texture reads in the vertex shaders).
   */
  heightScale: number;
  /** Stand labels and icons upright, facing the camera. */
  billboard: boolean;
}

/** Fill `out` with the block contents for a frame (std140 layout). */
export function writeCameraBlock(
  frame: CameraFrame,
  surface: SurfaceParams,
  out: Float32Array,
): Float32Array {
  out.set(frame.viewProj, 0);
  out[16] = frame.right[0];
  out[17] = frame.right[1];
  out[18] = frame.right[2];
  out[19] = frame.clipScale;
  out[20] = frame.up[0];
  out[21] = frame.up[1];
  out[22] = frame.up[2];
  out[23] = frame.perspective ? frame.focusDist : 0;
  out[24] = frame.forward[0];
  out[25] = frame.forward[1];
  out[26] = frame.forward[2];
  out[27] = 0;
  out[28] = frame.eye[0];
  out[29] = frame.eye[1];
  out[30] = frame.eye[2];
  out[31] = 0;
  out[32] = 1 / Math.max(1, surface.mapW);
  out[33] = 1 / Math.max(1, surface.mapH);
  out[34] = surface.heightScale;
  out[35] = surface.billboard ? 1 : 0;
  return out;
}
