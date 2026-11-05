/**
 * WeatherPass — the seasons and weather overlays.
 *
 *   1. Winter: a white-blue tint over snow land (engine-lib Seasons.ts
 *      isSnowLand, read off the shared terrain-bytes texture) while a winter
 *      lasts. One full-map quad.
 *   2. Weather cells: a forecast is a dashed outline, a cell in effect a
 *      filled overlay — mud tint, storm swirl or fog haze. One quad per cell;
 *      there are at most four.
 *
 * Cosmetic only: the engine applies the effects. WebGLFrameBuilder pushes the
 * cells and the winter strength every tick (see update).
 */

import { WeatherCell } from "@openfront/engine-api/game/GameUpdates";
import { SNOW_NORTH_PERCENT } from "@openfront/engine-lib/game/Seasons";
import {
  cellCenterAt,
  isCellActive,
  isCellForecast,
} from "@openfront/engine-lib/game/Weather";
import { createDrapedQuad, DrapedQuad } from "../terrain/DrapedQuad";
import { drawMapSurface } from "../terrain/MapSurface";
import { createMapQuad, createProgram, shaderSrc } from "../utils/GlUtils";

import cellFragSrc from "../shaders/weather/cell.frag.glsl?raw";
import cellVertSrc from "../shaders/weather/cell.vert.glsl?raw";
import winterFragSrc from "../shaders/weather/winter.frag.glsl?raw";
import winterVertSrc from "../shaders/weather/winter.vert.glsl?raw";

/** Ticks an active cell takes to fade in, and to fade out before its end. */
const CELL_FADE_IN_TICKS = 20;
const CELL_FADE_OUT_TICKS = 30;

/** A weather cell as drawn this tick. */
export interface WeatherDrawCell {
  x: number;
  y: number;
  radius: number;
  kind: number;
  /** False while it is only a forecast. */
  active: boolean;
  /** 0..1 */
  fade: number;
}

/** The cells to draw at `tick`, forecasts and active ones. Exported for tests. */
export function weatherDrawCells(
  cells: readonly WeatherCell[],
  tick: number,
): WeatherDrawCell[] {
  const out: WeatherDrawCell[] = [];
  for (const cell of cells) {
    const forecast = isCellForecast(cell, tick);
    const active = isCellActive(cell, tick);
    if (!forecast && !active) continue;
    const c = cellCenterAt(cell, tick);
    const fade = active
      ? Math.max(
          0,
          Math.min(
            1,
            (tick - cell.activeTick) / CELL_FADE_IN_TICKS,
            (cell.endTick - tick) / CELL_FADE_OUT_TICKS,
          ),
        )
      : 1;
    out.push({
      x: c.x,
      y: c.y,
      radius: cell.radius,
      kind: cell.kind,
      active,
      fade,
    });
  }
  return out;
}

export class WeatherPass {
  private gl: WebGL2RenderingContext;
  private winterProgram: WebGLProgram;
  private cellProgram: WebGLProgram;
  private mapVao: WebGLVertexArrayObject;
  // A draped grid, so a cell lies on the 3D terrain.
  private cellQuad: DrapedQuad;

  private uTerrainBytes: WebGLUniformLocation;
  private uWinter: WebGLUniformLocation;
  private uSnowRows: WebGLUniformLocation;

  private uCenter: WebGLUniformLocation;
  private uRadius: WebGLUniformLocation;
  private uKind: WebGLUniformLocation;
  private uActive: WebGLUniformLocation;
  private uFade: WebGLUniformLocation;
  private uTime: WebGLUniformLocation;

  private snowRows: number;
  private winter = 0;
  private cells: WeatherDrawCell[] = [];
  private readonly startMs = performance.now();

  constructor(
    gl: WebGL2RenderingContext,
    mapW: number,
    mapH: number,
    private terrainBytesTex: WebGLTexture,
  ) {
    this.gl = gl;
    this.snowRows = (mapH * SNOW_NORTH_PERCENT) / 100;
    const defines = { MAP_W: mapW, MAP_H: mapH };
    this.winterProgram = createProgram(
      gl,
      shaderSrc(winterVertSrc, defines),
      shaderSrc(winterFragSrc, defines),
      "WeatherPass.winter",
    );
    this.cellProgram = createProgram(
      gl,
      cellVertSrc,
      cellFragSrc,
      "WeatherPass.cell",
    );

    this.uTerrainBytes = gl.getUniformLocation(
      this.winterProgram,
      "uTerrainBytes",
    )!;
    this.uWinter = gl.getUniformLocation(this.winterProgram, "uWinter")!;
    this.uSnowRows = gl.getUniformLocation(this.winterProgram, "uSnowRows")!;

    this.uCenter = gl.getUniformLocation(this.cellProgram, "uCenter")!;
    this.uRadius = gl.getUniformLocation(this.cellProgram, "uRadius")!;
    this.uKind = gl.getUniformLocation(this.cellProgram, "uKind")!;
    this.uActive = gl.getUniformLocation(this.cellProgram, "uActive")!;
    this.uFade = gl.getUniformLocation(this.cellProgram, "uFade")!;
    this.uTime = gl.getUniformLocation(this.cellProgram, "uTime")!;

    this.mapVao = createMapQuad(gl, mapW, mapH);

    this.cellQuad = createDrapedQuad(gl);
  }

  /**
   * The cells at `tick` and the winter strength (0 = none, 1 = full).
   * Called every tick.
   */
  update(cells: readonly WeatherCell[], tick: number, winter: number): void {
    this.cells = weatherDrawCells(cells, tick);
    this.winter = winter;
  }

  draw(cameraMatrix: Float32Array): void {
    const gl = this.gl;
    if (this.winter > 0) {
      gl.useProgram(this.winterProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.terrainBytesTex);
      gl.uniform1i(this.uTerrainBytes, 0);
      gl.uniform1f(this.uWinter, this.winter);
      gl.uniform1f(this.uSnowRows, this.snowRows);
      // Draped on the 3D terrain like the territory overlay.
      drawMapSurface(gl, this.mapVao);
    }
    if (this.cells.length > 0) {
      gl.useProgram(this.cellProgram);
      gl.uniform1f(this.uTime, (performance.now() - this.startMs) / 1000);
      gl.bindVertexArray(this.cellQuad.vao);
      for (const c of this.cells) {
        gl.uniform2f(this.uCenter, c.x, c.y);
        gl.uniform1f(this.uRadius, c.radius);
        gl.uniform1i(this.uKind, c.kind);
        gl.uniform1f(this.uActive, c.active ? 1 : 0);
        gl.uniform1f(this.uFade, c.fade);
        gl.drawArrays(gl.TRIANGLES, 0, this.cellQuad.vertexCount);
      }
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.winterProgram);
    gl.deleteProgram(this.cellProgram);
    gl.deleteBuffer(this.cellQuad.buffer);
    gl.deleteVertexArray(this.mapVao);
    gl.deleteVertexArray(this.cellQuad.vao);
  }
}
