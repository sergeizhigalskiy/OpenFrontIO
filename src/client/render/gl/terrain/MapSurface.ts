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
 */

import type { CameraFrame } from "../camera/CameraMath";
import {
  buildSurfaceMesh,
  selectSurfaceChunks,
  type SurfaceMeshData,
  type SurfaceOptions,
  type SurfaceSelection,
} from "./SurfaceMesh";

const activeSurfaces = new WeakMap<WebGL2RenderingContext, MapSurface>();

/** Draw the map surface: the 3D mesh when active, else the pass's map quad. */
export function drawMapSurface(
  gl: WebGL2RenderingContext,
  quadVao: WebGLVertexArrayObject,
): void {
  const surface = activeSurfaces.get(gl);
  if (surface !== undefined && surface.draw()) return;
  gl.bindVertexArray(quadVao);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
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

  constructor(
    private gl: WebGL2RenderingContext,
    private mapW: number,
    private mapH: number,
  ) {
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
    if (this.lastLevels !== null && sameLevels(levels, this.lastLevels)) {
      return;
    }
    this.lastLevels = levels.slice();
    this.mesh = buildSurfaceMesh(
      this.selection,
      this.mapW,
      this.mapH,
      this.mesh,
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

  /** Draw the mesh. False if there is nothing built yet (caller falls back). */
  draw(): boolean {
    if (this.indexCount === 0) return false;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    return true;
  }

  dispose(): void {
    this.setActive(false);
    const gl = this.gl;
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
