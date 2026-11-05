/**
 * TerrainFeaturePass — draws the map's terrain features (forests, rivers,
 * fords) between the terrain and territory passes, in its own pass so the
 * terrain shader stays untouched.
 *
 * The feature layer is static map data: it is uploaded once per map as one
 * TerrainFeature byte per tile. Maps without a feature layer never create
 * this pass.
 */

import featureFragSrc from "../shaders/terrain-feature/feature.frag.glsl?raw";
import featureVertSrc from "../shaders/terrain-feature/feature.vert.glsl?raw";
import {
  createMapQuad,
  createProgram,
  createTexture2D,
  shaderSrc,
} from "../utils/GlUtils";

export class TerrainFeaturePass {
  private program: WebGLProgram;
  private featureTex: WebGLTexture;
  private vao: WebGLVertexArrayObject;
  private uCamera: WebGLUniformLocation;
  private uFeatures: WebGLUniformLocation;
  private uTerrainBytes: WebGLUniformLocation;

  constructor(
    private gl: WebGL2RenderingContext,
    /** Terrain-bytes R8UI texture (shared with the map-layer passes). */
    private terrainBytesTex: WebGLTexture,
    /** One TerrainFeature per tile, mapW * mapH bytes. */
    features: Uint8Array,
    mapW: number,
    mapH: number,
  ) {
    this.program = createProgram(
      gl,
      shaderSrc(featureVertSrc, { MAP_W: mapW, MAP_H: mapH }),
      shaderSrc(featureFragSrc, { MAP_W: mapW, MAP_H: mapH }),
      "TerrainFeaturePass",
    );
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uFeatures = gl.getUniformLocation(this.program, "uFeatures")!;
    this.uTerrainBytes = gl.getUniformLocation(this.program, "uTerrainBytes")!;

    this.featureTex = createTexture2D(gl, {
      width: mapW,
      height: mapH,
      internalFormat: gl.R8UI,
      format: gl.RED_INTEGER,
      type: gl.UNSIGNED_BYTE,
      data: features,
      filter: gl.NEAREST,
    });

    this.vao = createMapQuad(gl, mapW, mapH);
  }

  draw(cam: Float32Array): void {
    const gl = this.gl;
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.featureTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.terrainBytesTex);
    gl.uniform1i(this.uFeatures, 0);
    gl.uniform1i(this.uTerrainBytes, 1);
    gl.uniformMatrix3fv(this.uCamera, false, cam);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteTexture(this.featureTex);
    gl.deleteVertexArray(this.vao);
  }
}
