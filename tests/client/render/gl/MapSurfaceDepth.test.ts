/**
 * The map surface's occlusion: overlays draped on the 3D mesh are depth
 * tested against the mesh's own depth, so a border or a lake behind a ridge
 * can't show through it, and see-through overlays (defense coverage, range
 * rings) draw their hidden part again, faintly. The GL state is left as it
 * was found (depth test off, depth writes on) for the passes after them.
 */
import { describe, expect, it } from "vitest";
import {
  drawMapSurface,
  drawOverSurface,
  MapSurface,
} from "../../../../src/client/render/gl/terrain/MapSurface";

type Call = [string, ...unknown[]];

/** A WebGL2 stand-in recording every call; GL enums are their names. */
function recordingGL(): { gl: WebGL2RenderingContext; calls: Call[] } {
  const calls: Call[] = [];
  const gl = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return prop;
        if (prop === "getShaderParameter" || prop === "getProgramParameter")
          return () => true;
        if (prop === "isContextLost") return () => false;
        if (prop === "getUniformLocation") return () => null;
        return (...args: unknown[]) => {
          calls.push([prop, ...args]);
          return {};
        };
      },
    },
  ) as unknown as WebGL2RenderingContext;
  return { gl, calls };
}

/** A surface with a mesh "built" (its index count set), active. */
function activeSurface(gl: WebGL2RenderingContext): MapSurface {
  const surface = new MapSurface(gl, 64, 32);
  (surface as unknown as { indexCount: number }).indexCount = 6;
  surface.setActive(true);
  return surface;
}

const names = (calls: Call[]) =>
  calls.map((c) => (c.length > 1 ? `${c[0]}(${c.slice(1).join(",")})` : c[0]));

describe("map surface occlusion", () => {
  it("draws overlays on the mesh depth-tested against the surface", () => {
    const { gl, calls } = recordingGL();
    activeSurface(gl);
    calls.length = 0;
    drawMapSurface(gl, {} as WebGLVertexArrayObject);
    const seq = names(calls);
    expect(seq).toContain("enable(DEPTH_TEST)");
    expect(seq).toContain("depthMask(false)");
    expect(seq).toContain("depthFunc(LEQUAL)");
    const draws = seq.filter((c) => c.startsWith("drawElements"));
    expect(draws).toHaveLength(1);
    // The test is on before the draw and off after, writes back on.
    expect(seq.indexOf("depthFunc(LEQUAL)")).toBeLessThan(
      seq.indexOf(draws[0]),
    );
    expect(seq.slice(-3)).toEqual([
      "depthFunc(LESS)",
      "depthMask(true)",
      "disable(DEPTH_TEST)",
    ]);
  });

  it("draws a see-through overlay's hidden part again, between its calls", () => {
    const { gl, calls } = recordingGL();
    activeSurface(gl);
    calls.length = 0;
    drawMapSurface(gl, {} as WebGLVertexArrayObject, (hidden) =>
      calls.push(["seeThrough", hidden]),
    );
    const seq = names(calls);
    const first = seq.indexOf("drawElements(TRIANGLES,6,UNSIGNED_INT,0)");
    const hiddenOn = seq.indexOf("seeThrough(true)");
    const greater = seq.indexOf("depthFunc(GREATER)");
    const second = seq.lastIndexOf("drawElements(TRIANGLES,6,UNSIGNED_INT,0)");
    const hiddenOff = seq.indexOf("seeThrough(false)");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(hiddenOn);
    expect(hiddenOn).toBeLessThan(greater);
    expect(greater).toBeLessThan(second);
    expect(second).toBeLessThan(hiddenOff);
    // The hidden part keeps back faces, so an outline over a crest stays whole.
    expect(seq.slice(first, second)).toContain("disable(CULL_FACE)");
    expect(seq.slice(second)).not.toContain("enable(CULL_FACE)");
    expect(seq[seq.length - 1]).toBe("disable(DEPTH_TEST)");
  });

  it("falls back to the map quad, untested, without a 3D surface", () => {
    const { gl, calls } = recordingGL();
    const surface = activeSurface(gl);
    surface.setActive(false);
    calls.length = 0;
    let hidden = 0;
    drawMapSurface(gl, {} as WebGLVertexArrayObject, () => hidden++);
    const seq = names(calls);
    expect(seq).toContain("drawArrays(TRIANGLES,0,6)");
    expect(seq.some((c) => c.includes("DEPTH"))).toBe(false);
    expect(hidden).toBe(0);
  });

  it("lays down depth only, pushed back a hair, then restores the state", () => {
    const { gl, calls } = recordingGL();
    const surface = activeSurface(gl);
    calls.length = 0;
    surface.drawDepth();
    const seq = names(calls);
    const draw = seq.indexOf("drawElements(TRIANGLES,6,UNSIGNED_INT,0)");
    expect(seq.indexOf("colorMask(false,false,false,false)")).toBeLessThan(
      draw,
    );
    expect(seq.indexOf("depthMask(true)")).toBeLessThan(draw);
    expect(seq.indexOf("enable(POLYGON_OFFSET_FILL)")).toBeLessThan(draw);
    expect(seq.slice(draw)).toEqual(
      expect.arrayContaining([
        "disable(POLYGON_OFFSET_FILL)",
        "disable(DEPTH_TEST)",
        "colorMask(true,true,true,true)",
      ]),
    );
    // Inactive: nothing.
    surface.setActive(false);
    calls.length = 0;
    surface.drawDepth();
    expect(calls).toEqual([]);
  });

  it("draws ground geometry twice over an active surface, once without", () => {
    const { gl, calls } = recordingGL();
    const surface = activeSurface(gl);
    let draws = 0;
    const faint: boolean[] = [];
    calls.length = 0;
    drawOverSurface(
      gl,
      () => draws++,
      (hidden) => faint.push(hidden),
    );
    expect(draws).toBe(2);
    expect(faint).toEqual([true, false]);
    expect(names(calls)).toEqual([
      "enable(DEPTH_TEST)",
      "depthMask(false)",
      "depthFunc(LEQUAL)",
      "depthFunc(GREATER)",
      "depthFunc(LESS)",
      "depthMask(true)",
      "disable(DEPTH_TEST)",
    ]);
    surface.setActive(false);
    draws = 0;
    calls.length = 0;
    drawOverSurface(
      gl,
      () => draws++,
      (hidden) => faint.push(hidden),
    );
    expect(draws).toBe(1);
    expect(calls).toEqual([]);
  });
});
