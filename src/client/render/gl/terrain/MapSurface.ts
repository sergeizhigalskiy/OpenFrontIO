/**
 * MapSurface — the 3D terrain mesh on the GPU, and the one draw call every
 * full-map pass goes through.
 *
 * Passes that cover the whole map (terrain, territory, borders, trails,
 * railroads, map layers, grid, glow composites) used to draw a 2-triangle map
 * quad. They now call drawMapSurface(gl, quadVao): in 3D mode that draws the
 * chunked LOD mesh built by SurfaceMesh.ts (location 0 = world xy, as the
 * quad had), otherwise the pass's own quad. Their vertex shaders use
 * groundToClip, so the same geometry drapes every overlay onto the terrain.
 *
 * The active surface is kept per GL context, so passes don't need a handle.
 *
 * Occlusion: passes drape their overlays on the same mesh, each in its own
 * draw, so without a depth test a border or a lake on a slope behind a
 * ridge would show through the ridge (the ridge's own fragments of that
 * overlay are transparent and cover nothing). drawDepth() lays the mesh's
 * depth down first; every drawMapSurface() then tests against it (LEQUAL,
 * no depth writes), so only the front-most surface takes each pass's
 * colour. Every camera vertex shader computes gl_Position invariantly
 * (GlUtils.createProgram), so the visible surface always passes. A pass
 * whose overlay must stay readable behind ridges (defense coverage, range
 * rings) asks for a see-through draw: the hidden part again, faintly.
 * Offscreen targets without a depth buffer pass every fragment, as before.
 */

import type { CameraFrame } from "../camera/CameraMath";
import depthFragSrc from "../shaders/terrain/surface-depth.frag.glsl?raw";
import depthVertSrc from "../shaders/terrain/surface-depth.vert.glsl?raw";
import { createProgram } from "../utils/GlUtils";
import {
  buildSurfaceMesh,
  selectSurfaceChunks,
  surfaceOrderFor,
  type SurfaceMeshData,
  type SurfaceOptions,
  type SurfaceOrder,
  type SurfaceSelection,
} from "./SurfaceMesh";

const activeSurfaces = new WeakMap<WebGL2RenderingContext, MapSurface>();

/**
 * For a see-through draw: called with true before the hidden part draws
 * (set the pass's faint opacity) and with false after (restore it).
 */
export type SeeThrough = (hidden: boolean) => void;

/**
 * Draw the map surface: the 3D mesh when active (depth-tested against
 * drawDepth, see above), else the pass's map quad. With `seeThrough`, the
 * parts hidden behind ridges draw too, between its two calls.
 */
export function drawMapSurface(
  gl: WebGL2RenderingContext,
  quadVao: WebGLVertexArrayObject,
  seeThrough?: SeeThrough,
): void {
  const surface = activeSurfaces.get(gl);
  if (surface !== undefined && surface.draw(seeThrough)) return;
  gl.bindVertexArray(quadVao);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

/** True while the 3D mesh is the surface passes draw (a relief view). */
export function mapSurfaceActive(gl: WebGL2RenderingContext): boolean {
  return activeSurfaces.has(gl);
}

/**
 * Draw geometry that lies on the ground without being the surface mesh (a
 * ring strip lifted a little toward the camera), depth-tested against the
 * surface while it is active: `draw` once for the visible part, then again
 * between `seeThrough`'s calls for the part behind ridges. Inactive (the
 * flat view), it just draws.
 */
export function drawOverSurface(
  gl: WebGL2RenderingContext,
  draw: () => void,
  seeThrough: SeeThrough,
): void {
  if (!activeSurfaces.has(gl)) {
    draw();
    return;
  }
  gl.enable(gl.DEPTH_TEST);
  gl.depthMask(false);
  gl.depthFunc(gl.LEQUAL);
  draw();
  seeThrough(true);
  gl.depthFunc(gl.GREATER);
  draw();
  seeThrough(false);
  gl.depthFunc(gl.LESS);
  gl.depthMask(true);
  gl.disable(gl.DEPTH_TEST);
}

export class MapSurface {
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;
  private vboCapacity = 0;
  private iboCapacity = 0;
  private indexCount = 0;
  private selection: SurfaceSelection | null = null;
  private lastLevels: Int8Array | null = null;
  private mesh: SurfaceMeshData | undefined;
  private lastViewProj = new Float32Array(16);
  private lastOpts = "";
  private order: SurfaceOrder = { flipX: false, flipY: false };
  private depthProgram: WebGLProgram;

  constructor(
    private gl: WebGL2RenderingContext,
    private mapW: number,
    private mapH: number,
  ) {
    this.depthProgram = createProgram(
      gl,
      depthVertSrc,
      depthFragSrc,
      "MapSurface.depth",
    );
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    this.ibo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bindVertexArray(null);
  }

  /**
   * Make this the surface full-map passes draw (true) or fall back to their
   * map quads (false).
   */
  setActive(active: boolean): void {
    if (active) activeSurfaces.set(this.gl, this);
    else if (activeSurfaces.get(this.gl) === this) {
      activeSurfaces.delete(this.gl);
    }
  }

  /**
   * Re-select chunks for this frame's camera and rebuild the mesh when the
   * selection changed. Cheap when the camera hasn't moved.
   */
  update(frame: CameraFrame, opts: SurfaceOptions): void {
    const optsKey = `${opts.maxHeight}|${opts.targetPx}`;
    if (
      optsKey === this.lastOpts &&
      sameMatrix(frame.viewProj, this.lastViewProj)
    ) {
      return;
    }
    this.lastOpts = optsKey;
    this.lastViewProj.set(frame.viewProj);
    this.selection = selectSurfaceChunks(
      frame,
      this.mapW,
      this.mapH,
      opts,
      this.selection ?? undefined,
    );
    const levels = this.selection.levels;
    const order = surfaceOrderFor(frame);
    const sameOrder =
      order.flipX === this.order.flipX && order.flipY === this.order.flipY;
    if (
      sameOrder &&
      this.lastLevels !== null &&
      sameLevels(levels, this.lastLevels)
    ) {
      return;
    }
    this.order = order;
    this.lastLevels = levels.slice();
    this.mesh = buildSurfaceMesh(
      this.selection,
      this.mapW,
      this.mapH,
      this.mesh,
      order,
    );
    this.upload(this.mesh);
  }

  private upload(mesh: SurfaceMeshData): void {
    const gl = this.gl;
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (mesh.positions.byteLength > this.vboCapacity) {
      this.vboCapacity = mesh.positions.byteLength;
      gl.bufferData(gl.ARRAY_BUFFER, this.vboCapacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      mesh.positions,
      0,
      mesh.vertexCount * 2,
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    if (mesh.indices.byteLength > this.iboCapacity) {
      this.iboCapacity = mesh.indices.byteLength;
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.iboCapacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(
      gl.ELEMENT_ARRAY_BUFFER,
      0,
      mesh.indices,
      0,
      mesh.indexCount,
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.indexCount = mesh.indexCount;
  }

  /** Vertex and triangle counts of the current mesh (for diagnostics). */
  stats(): { vertices: number; triangles: number } {
    return {
      vertices: this.mesh?.vertexCount ?? 0,
      triangles: this.indexCount / 3,
    };
  }

  /**
   * Lay down the mesh's depth into the bound framebuffer (cleared by the
   * caller), colour writes off. Pushed back a hair (polygon offset), so the
   * passes drawing the same triangles pass LEQUAL even if a driver rounds
   * one program differently. No-op while inactive or before a mesh exists.
   */
  drawDepth(): void {
    if (this.indexCount === 0 || activeSurfaces.get(this.gl) !== this) return;
    const gl = this.gl;
    gl.useProgram(this.depthProgram);
    gl.colorMask(false, false, false, false);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 2);
    gl.enable(gl.CULL_FACE);
    gl.frontFace(gl.CW);
    gl.cullFace(gl.BACK);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.disable(gl.CULL_FACE);
    gl.frontFace(gl.CCW);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.colorMask(true, true, true, true);
  }

  /**
   * Draw the mesh, depth-tested against drawDepth. False if there is
   * nothing built yet (caller falls back). Back faces (slopes turned away
   * from the camera) are culled; the mesh's triangles wind clockwise on
   * screen. With `seeThrough`, the hidden surface draws again (depth
   * GREATER), back faces included, so an outline crossing a ridge stays
   * whole.
   */
  draw(seeThrough?: SeeThrough): boolean {
    if (this.indexCount === 0) return false;
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.frontFace(gl.CW);
    gl.cullFace(gl.BACK);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.disable(gl.CULL_FACE);
    gl.frontFace(gl.CCW);
    if (seeThrough !== undefined) {
      seeThrough(true);
      gl.depthFunc(gl.GREATER);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
      seeThrough(false);
    }
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
    return true;
  }

  dispose(): void {
    this.setActive(false);
    const gl = this.gl;
    gl.deleteProgram(this.depthProgram);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
  }
}

function sameMatrix(a: Float32Array, b: Float32Array): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameLevels(a: Int8Array, b: Int8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
