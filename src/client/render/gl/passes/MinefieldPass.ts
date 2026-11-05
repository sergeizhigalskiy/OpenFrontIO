/**
 * MinefieldPass — shaded circles over the minefields the local player may
 * see: their own, and their allies' and teammates'.
 *
 * Every client simulates every minefield, so this filter is what keeps a
 * field hidden from everyone else: a field owned by anyone not friendly
 * with the local player is never drawn (and no other pass draws minefields
 * at all — see UT_MINEFIELD). Spectators and replays, with no local player,
 * see none.
 *
 * A field's opacity follows its density (the unit's health, 10-100), so a
 * depleted field fades. One draw call per visible field; there are few.
 */

import {
  MINEFIELD_MAX_DENSITY,
  MINEFIELD_RADIUS,
} from "@openfront/engine-lib/game/NavalDefense";
import type { UnitState } from "../../types";
import { UT_MINEFIELD } from "../../types";
import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/minefield/minefield.frag.glsl?raw";
import vertSrc from "../shaders/minefield/minefield.vert.glsl?raw";

/** The local player's own fields. */
const COLOR_OWN: readonly [number, number, number] = [1.0, 0.45, 0.15];
/** Allies' and teammates' fields. */
const COLOR_FRIENDLY: readonly [number, number, number] = [1.0, 0.8, 0.25];
/** Tiles between the dots drawn as mines. */
const MINE_DOT_SPACING = 3;

interface VisibleField {
  x: number;
  y: number;
  /** 0.1 .. 1 */
  density: number;
  own: boolean;
}

/**
 * The minefields `localPlayerID` may see, in `units` order: only its own and
 * those of `friendly` players. Exported for tests.
 */
export function visibleMinefields(
  units: Iterable<UnitState>,
  localPlayerID: number,
  friendly: ReadonlySet<number>,
  mapW: number,
): VisibleField[] {
  const out: VisibleField[] = [];
  if (localPlayerID <= 0) return out;
  for (const u of units) {
    if (u.unitType !== UT_MINEFIELD || !u.isActive) continue;
    const own = u.ownerID === localPlayerID;
    if (!own && !friendly.has(u.ownerID)) continue;
    const x = u.pos % mapW;
    out.push({
      x,
      y: (u.pos - x) / mapW,
      density: Math.min(1, (u.health ?? 0) / MINEFIELD_MAX_DENSITY),
      own,
    });
  }
  return out;
}

export class MinefieldPass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;

  private uCamera: WebGLUniformLocation;
  private uCenter: WebGLUniformLocation;
  private uRadius: WebGLUniformLocation;
  private uColor: WebGLUniformLocation;
  private uDensity: WebGLUniformLocation;
  private uDotSpacing: WebGLUniformLocation;

  private mapW: number;
  private localPlayerID = 0;
  private friendly: ReadonlySet<number> = new Set();
  private lastUnits: Map<number, UnitState> | null = null;
  private fields: VisibleField[] = [];

  constructor(gl: WebGL2RenderingContext, mapW: number) {
    this.gl = gl;
    this.mapW = mapW;
    this.program = createProgram(gl, vertSrc, fragSrc, "MinefieldPass");

    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uCenter = gl.getUniformLocation(this.program, "uCenter")!;
    this.uRadius = gl.getUniformLocation(this.program, "uRadius")!;
    this.uColor = gl.getUniformLocation(this.program, "uColor")!;
    this.uDensity = gl.getUniformLocation(this.program, "uDensity")!;
    this.uDotSpacing = gl.getUniformLocation(this.program, "uDotSpacing")!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  setLocalPlayer(id: number): void {
    if (id === this.localPlayerID) return;
    this.localPlayerID = id;
    this.rebuild();
  }

  /** smallIDs allied with or on the local player's team. */
  setFriendly(friendly: ReadonlySet<number>): void {
    this.friendly = friendly;
    this.rebuild();
  }

  /** Called every tick with all units: density changes aren't structure changes. */
  updateUnits(units: Map<number, UnitState>): void {
    this.lastUnits = units;
    this.rebuild();
  }

  private rebuild(): void {
    this.fields =
      this.lastUnits === null
        ? []
        : visibleMinefields(
            this.lastUnits.values(),
            this.localPlayerID,
            this.friendly,
            this.mapW,
          );
  }

  draw(cameraMatrix: Float32Array): void {
    if (this.fields.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uRadius, MINEFIELD_RADIUS);
    gl.uniform1f(this.uDotSpacing, MINE_DOT_SPACING);
    gl.bindVertexArray(this.vao);
    for (const f of this.fields) {
      const [r, g, b] = f.own ? COLOR_OWN : COLOR_FRIENDLY;
      gl.uniform2f(this.uCenter, f.x, f.y);
      gl.uniform3f(this.uColor, r, g, b);
      gl.uniform1f(this.uDensity, f.density);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.quadBuf);
    gl.deleteVertexArray(this.vao);
  }
}
