/**
 * ReloadBarPass — reload bars under the structures that fire and reload.
 *
 * SAM launchers and missile silos get a row of pips just under their icon
 * while any round is reloading: one pip per round, ready rounds full, a
 * reloading round filling as it reloads (a one-round unit gets one bar).
 * Nothing is drawn while every round is ready, or at zooms where the
 * structures are dots.
 *
 * Every player sees every unit's bar, as with the missile readiness bar
 * BarPass used to draw under silos and SAMs (it's the public missile timer
 * queue on each unit).
 *
 * Self-contained: it draws in ground space (tile coordinates through the
 * camera matrix), sized from the structure icon settings so it tracks the
 * icon at every zoom. One instanced draw call per frame.
 *
 * Data flow:
 *   UnitState.missileTimerQueue + game tick → reloadBar() (frame/derive)
 *   → instance VBO (x, y, slot, slotCount, fill, ready) → GPU rectangles
 */

import type { Config } from "@openfront/engine-lib/configuration/Config";
import type { ReloadConfig } from "../../frame/derive/ReloadBars";
import { reloadBar } from "../../frame/derive/ReloadBars";
import type { RendererConfig, UnitState } from "../../types";
import { DynamicInstanceBuffer } from "../DynamicBuffer";
import type { RenderSettings } from "../RenderSettings";
import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/reload-bar/reload-bar.frag.glsl?raw";
import vertSrc from "../shaders/reload-bar/reload-bar.vert.glsl?raw";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLOATS_PER_INSTANCE = 6; // x, y, slot, slotCount, fill, ready
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

// Layout, in half-icon units (half a structure icon's width at this zoom).
/** The row's top edge below the icon center: just under the icon. */
const ROW_TOP = 0.95;
/** The whole row's width, however many pips it holds. */
const ROW_WIDTH = 1.4;
const PIP_HEIGHT = 0.3;
const PIP_GAP = 0.12;

/** Outline width in canvas pixels. */
const BORDER_PX = 1;
const READY_COLOR: readonly [number, number, number] = [0.3, 0.86, 0.36];
const RELOAD_COLOR: readonly [number, number, number] = [0.98, 0.72, 0.18];
const EMPTY_COLOR: readonly [number, number, number, number] = [
  0.1, 0.1, 0.1, 0.8,
];

/**
 * Half a structure icon's width in tiles at `zoom`, before its per-shape
 * scale: the same sizing as structure.vert.glsl. 0 at zooms where structures
 * are dots, so no bar is drawn there.
 */
export function reloadBarHalfIcon(
  zoom: number,
  s: Pick<
    RenderSettings["structure"],
    | "iconSize"
    | "dotsZoomThreshold"
    | "iconScaleFactorZoomedOut"
    | "iconGrowZoom"
  >,
): number {
  if (zoom <= s.dotsZoomThreshold) return 0;
  const iconScale =
    zoom >= s.iconGrowZoom
      ? zoom / s.iconGrowZoom
      : Math.min(1, zoom / s.iconScaleFactorZoomedOut);
  return (s.iconSize * iconScale * 0.5) / zoom;
}

/**
 * Writes one instance per bar pip of every unit with a reload showing into
 * `buf` (grown through `ensureCapacity`), returning the instance count.
 */
export function writeReloadBarInstances(
  units: Iterable<UnitState>,
  gameTick: number,
  config: ReloadConfig,
  mapW: number,
  buf: Pick<DynamicInstanceBuffer, "ensureCapacity" | "float32">,
): number {
  let count = 0;
  for (const unit of units) {
    const pips = reloadBar(unit, gameTick, config);
    if (pips === null || pips.length === 0) continue;
    buf.ensureCapacity(count + pips.length);
    const data = buf.float32;
    const x = unit.pos % mapW;
    const y = (unit.pos - x) / mapW;
    for (let slot = 0; slot < pips.length; slot++) {
      const off = (count + slot) * FLOATS_PER_INSTANCE;
      data[off] = x;
      data[off + 1] = y;
      data[off + 2] = slot;
      data[off + 3] = pips.length;
      data[off + 4] = pips[slot].fill;
      data[off + 5] = pips[slot].ready ? 1 : 0;
    }
    count += pips.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// ReloadBarPass
// ---------------------------------------------------------------------------

export class ReloadBarPass {
  private gl: WebGL2RenderingContext;
  private settings: RenderSettings;
  private program: WebGLProgram;
  private mapW: number;

  private uHalfIcon: WebGLUniformLocation;
  private uLayout: WebGLUniformLocation;
  private uBorder: WebGLUniformLocation;
  private uReadyColor: WebGLUniformLocation;
  private uReloadColor: WebGLUniformLocation;
  private uEmptyColor: WebGLUniformLocation;

  private vao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;
  private instanceBuf: DynamicInstanceBuffer;
  private instanceCount = 0;

  constructor(
    gl: WebGL2RenderingContext,
    header: RendererConfig,
    settings: RenderSettings,
    private config: Config,
  ) {
    this.gl = gl;
    this.settings = settings;
    this.mapW = header.mapWidth;

    this.program = createProgram(gl, vertSrc, fragSrc, "ReloadBarPass");
    this.uHalfIcon = gl.getUniformLocation(this.program, "uHalfIcon")!;
    this.uLayout = gl.getUniformLocation(this.program, "uLayout")!;
    this.uBorder = gl.getUniformLocation(this.program, "uBorder")!;
    this.uReadyColor = gl.getUniformLocation(this.program, "uReadyColor")!;
    this.uReloadColor = gl.getUniformLocation(this.program, "uReloadColor")!;
    this.uEmptyColor = gl.getUniformLocation(this.program, "uEmptyColor")!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuf = new DynamicInstanceBuffer(
      gl,
      gl.createBuffer()!,
      64,
      FLOATS_PER_INSTANCE,
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, BYTES_PER_INSTANCE, 16);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);
  }

  /** Rebuild the bars from this tick's units. */
  update(units: Map<number, UnitState>, gameTick: number): void {
    const count = writeReloadBarInstances(
      units.values(),
      gameTick,
      this.config,
      this.mapW,
      this.instanceBuf,
    );
    this.instanceCount = count;
    if (count === 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instanceBuf.float32,
      0,
      count * FLOATS_PER_INSTANCE,
    );
  }

  /** Draw after the structure icons. */
  draw(cameraMatrix: Float32Array, zoom: number): void {
    if (this.instanceCount === 0) return;
    const halfIcon = reloadBarHalfIcon(zoom, this.settings.structure);
    if (halfIcon <= 0) return;

    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.uHalfIcon, halfIcon);
    gl.uniform4f(this.uLayout, ROW_TOP, ROW_WIDTH, PIP_HEIGHT, PIP_GAP);
    gl.uniform1f(this.uBorder, BORDER_PX / zoom);
    gl.uniform3f(this.uReadyColor, ...READY_COLOR);
    gl.uniform3f(this.uReloadColor, ...RELOAD_COLOR);
    gl.uniform4f(this.uEmptyColor, ...EMPTY_COLOR);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.quadBuf);
    this.instanceBuf.dispose();
    gl.deleteVertexArray(this.vao);
  }
}
