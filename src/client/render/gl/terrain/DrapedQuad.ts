/**
 * DrapedQuad — a unit quad split into a grid, for medium-size ground
 * overlays (a weather cell, an eruption glow) that should follow the 3D
 * terrain rather than float at one height.
 *
 * Vertices are [0,1]² positions at location 0, as the plain unit quad's
 * were. A vertex shader that maps them to world space and places them with
 * groundToClip drapes the overlay at DRAPED_QUAD_DIVISIONS resolution; in the
 * flat and tilted views the grid lies in one plane, so it covers exactly the
 * pixels the single quad did, with the same interpolated varyings.
 */

/** Cells per side of the grid. */
export const DRAPED_QUAD_DIVISIONS = 16;

/** The grid's triangles: 6 vertices (x, y) per cell. */
export function drapedQuadVertices(
  divisions: number = DRAPED_QUAD_DIVISIONS,
): Float32Array {
  const n = Math.max(1, Math.floor(divisions));
  const out = new Float32Array(n * n * 12);
  let o = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = i / n;
      const x1 = (i + 1) / n;
      const y0 = j / n;
      const y1 = (j + 1) / n;
      // Same winding as the unit quads: (0,0) (1,0) (0,1) / (1,0) (1,1) (0,1).
      out.set([x0, y0, x1, y0, x0, y1, x1, y0, x1, y1, x0, y1], o);
      o += 12;
    }
  }
  return out;
}

export interface DrapedQuad {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  vertexCount: number;
}

/** Uploads the grid as a VAO with the positions at location 0. */
export function createDrapedQuad(
  gl: WebGL2RenderingContext,
  divisions: number = DRAPED_QUAD_DIVISIONS,
): DrapedQuad {
  const vertices = drapedQuadVertices(divisions);
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, buffer, vertexCount: vertices.length / 2 };
}
