/**
 * CameraUniforms — owns the camera uniform buffer (CameraBlock.ts) and the
 * height-map texture unit, and binds both for a frame.
 *
 * Bind once at the start of a frame, before any pass draws. The binding is
 * context state, so it holds for every program that includes the camera.
 */

import { createTexture2D } from "../utils/GlUtils";
import {
  CAMERA_BLOCK_BINDING,
  CAMERA_BLOCK_FLOATS,
  HEIGHT_MAP_UNIT,
  type SurfaceParams,
  writeCameraBlock,
} from "./CameraBlock";
import type { CameraFrame } from "./CameraMath";

export class CameraUniforms {
  private ubo: WebGLBuffer;
  private data = new Float32Array(CAMERA_BLOCK_FLOATS);
  /** Bound when there is no height map, so the sampler never reads unit 15 empty. */
  private flatHeight: WebGLTexture;

  constructor(private gl: WebGL2RenderingContext) {
    this.ubo = gl.createBuffer()!;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    this.flatHeight = createTexture2D(gl, {
      width: 1,
      height: 1,
      internalFormat: gl.RG8,
      format: gl.RG,
      type: gl.UNSIGNED_BYTE,
      data: new Uint8Array(2),
    });
  }

  /** Upload this frame's camera and bind it (plus the height map) for drawing. */
  bind(
    frame: CameraFrame,
    surface: SurfaceParams,
    heightMap: WebGLTexture | null,
  ): void {
    const gl = this.gl;
    writeCameraBlock(frame, surface, this.data);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.data);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, CAMERA_BLOCK_BINDING, this.ubo);
    gl.activeTexture(gl.TEXTURE0 + HEIGHT_MAP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, heightMap ?? this.flatHeight);
    // Leave unit 0 active so later texture binds don't clobber the height map.
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(): void {
    this.gl.deleteBuffer(this.ubo);
    this.gl.deleteTexture(this.flatHeight);
  }
}
