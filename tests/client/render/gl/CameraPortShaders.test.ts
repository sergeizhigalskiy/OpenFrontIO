/**
 * Every pass added or changed since the shared camera block arrived compiles,
 * links and draws in a real WebGL2 context (headless Chrome), with the camera
 * block bound as the renderer binds it in each view mode: flat, tilt and
 * terrain3d. Skipped when no Chrome or Edge is installed.
 *
 * Also checked without a browser: no vertex shader still takes the old
 * `uniform mat3 uCamera`, and every map-space one includes the camera.
 */
import fs from "fs";
import path from "path";
import { Config } from "@openfront/engine-lib/configuration/Config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CAMERA_INCLUDE } from "../../../../src/client/render/gl/camera/CameraBlock";
import { CapitalPass } from "../../../../src/client/render/gl/passes/CapitalPass";
import { DefenseCoveragePass } from "../../../../src/client/render/gl/passes/DefenseCoveragePass";
import { ReloadBarPass } from "../../../../src/client/render/gl/passes/ReloadBarPass";
import { RuinsPass } from "../../../../src/client/render/gl/passes/RuinsPass";
import { StructurePass } from "../../../../src/client/render/gl/passes/StructurePass";
import { TideWarningPass } from "../../../../src/client/render/gl/passes/TideWarningPass";
import { UnitPass } from "../../../../src/client/render/gl/passes/UnitPass";
import { VolcanoPass } from "../../../../src/client/render/gl/passes/VolcanoPass";
import { WeatherPass } from "../../../../src/client/render/gl/passes/WeatherPass";
import { createRenderSettings } from "../../../../src/client/render/gl/RenderSettings";
import { ALL_UNIT_TYPES } from "../../../../src/client/render/types";
import {
  CapturedProgram,
  cameraBlocks,
  capturePrograms,
  compileInChrome,
  findChrome,
  ProgramResult,
} from "./ShaderHarness";

const MAP_W = 200;
const MAP_H = 120;

// The atlas passes start an image load; it never needs to finish here.
class PendingImage {
  crossOrigin = "";
  src = "";
  decode(): Promise<void> {
    return new Promise(() => {});
  }
}

function header() {
  return {
    mapWidth: MAP_W,
    mapHeight: MAP_H,
    unitTypes: [...ALL_UNIT_TYPES],
    players: [],
  };
}

/** The passes to check, by name. */
function passPrograms(): CapturedProgram[] {
  vi.stubGlobal("Image", PendingImage);
  const settings = createRenderSettings();
  const config = new Config({} as never, false);
  const tex = {} as WebGLTexture;
  const builds: [string, (gl: WebGL2RenderingContext) => unknown][] = [
    ["ReloadBarPass", (gl) => new ReloadBarPass(gl, header(), settings, config)],
    ["RuinsPass", (gl) => new RuinsPass(gl)],
    ["VolcanoPass", (gl) => new VolcanoPass(gl)],
    ["TideWarningPass", (gl) => new TideWarningPass(gl, MAP_W, MAP_H)],
    ["WeatherPass", (gl) => new WeatherPass(gl, MAP_W, MAP_H, tex)],
    ["CapitalPass", (gl) => new CapitalPass(gl)],
    [
      "DefenseCoveragePass",
      (gl) => new DefenseCoveragePass(gl, MAP_W, MAP_H, tex),
    ],
    [
      "StructurePass",
      (gl) => new StructurePass(gl, header(), tex, tex, settings),
    ],
    [
      "UnitPass",
      (gl) => new UnitPass(gl, header(), tex, tex, settings, config),
    ],
  ];
  return builds.flatMap(([name, build]) => capturePrograms(name, build));
}

const SHADER_DIR = path.resolve(
  __dirname,
  "../../../../src/client/render/gl/shaders",
);

function vertexShaders(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return vertexShaders(p);
    return e.name.endsWith(".vert.glsl") ? [p] : [];
  });
}

// Tile-space and full-screen shaders draw into map-sized or screen-sized
// targets, not through the camera.
const NO_CAMERA = new Set([
  "border-compute/border-scatter.vert.glsl",
  "defense-coverage/defense-coverage.vert.glsl",
  "map-overlay/tile-scatter.vert.glsl",
  "shared/fullscreen-no-uv.vert.glsl",
  "shared/fullscreen.vert.glsl",
]);

describe("vertex shaders use the shared camera", () => {
  it("never take the old mat3 uCamera, and map-space ones include the camera", () => {
    for (const file of vertexShaders(SHADER_DIR)) {
      const rel = path.relative(SHADER_DIR, file).replace(/\\/g, "/");
      const src = fs.readFileSync(file, "utf8");
      expect(src, rel).not.toMatch(/uniform\s+mat3\s+uCamera/);
      if (NO_CAMERA.has(rel)) continue;
      expect(src.includes(CAMERA_INCLUDE), rel).toBe(true);
      expect(src, rel).toMatch(
        /(groundToClip|anchoredToClip|billboardToClip|worldToClip)\(/,
      );
    }
  });
});

const chrome = findChrome();

describe.skipIf(chrome === null)(
  "ported passes compile and draw in WebGL2, in every camera mode",
  () => {
    let programs: CapturedProgram[];
    let results: ProgramResult[];

    beforeAll(() => {
      programs = passPrograms();
      results = compileInChrome(chrome!, programs, cameraBlocks(MAP_W, MAP_H));
    }, 90_000);

    it("captures a program for every pass", () => {
      const passes = new Set(programs.map((p) => p.pass));
      for (const name of [
        "ReloadBarPass",
        "RuinsPass",
        "VolcanoPass",
        "TideWarningPass",
        "WeatherPass",
        "CapitalPass",
        "DefenseCoveragePass",
        "StructurePass",
        "UnitPass",
      ]) {
        expect(passes.has(name), name).toBe(true);
      }
      expect(results).toHaveLength(programs.length);
    });

    it("compiles and links every program", () => {
      for (const r of results) {
        expect({ pass: r.pass, index: r.index, log: r.log }).toEqual({
          pass: r.pass,
          index: r.index,
          log: "",
        });
        expect(r.linked, r.pass).toBe(true);
      }
    });

    it("reads the camera block at its full size wherever it is included", () => {
      for (const [i, r] of results.entries()) {
        const included = programs[i].vs.includes("uniform CameraBlock");
        expect(r.usesCamera, `${r.pass} #${r.index}`).toBe(included);
        if (included) expect(r.cameraBlockBytes, r.pass).toBe(144);
      }
      // Every pass but the tile-space defense coverage draws through it.
      const camera = new Set(results.filter((r) => r.usesCamera).map((r) => r.pass));
      expect(camera.has("DefenseCoveragePass")).toBe(false);
      for (const name of [
        "ReloadBarPass",
        "RuinsPass",
        "VolcanoPass",
        "TideWarningPass",
        "WeatherPass",
        "CapitalPass",
        "StructurePass",
        "UnitPass",
      ]) {
        expect(camera.has(name), name).toBe(true);
      }
    });

    it("draws without a GL error in flat, tilt and terrain3d", () => {
      for (const r of results) {
        for (const mode of ["flat", "tilt", "terrain3d"]) {
          expect(
            { pass: r.pass, index: r.index, mode, error: r.drawErrors[mode] },
            r.pass,
          ).toEqual({ pass: r.pass, index: r.index, mode, error: 0 });
        }
      }
    });
  },
);
