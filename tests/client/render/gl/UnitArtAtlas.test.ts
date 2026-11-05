/**
 * The unit and structure atlases are base PNGs plus extension strips
 * (scripts/genUnitArt.ts) uploaded side by side, and the passes find a
 * type's art by its index in UNIT_ORDER / STRUCTURE_ORDER. Nothing ties the
 * two together but these checks: a column added to one and not the other
 * would shift every later sprite onto the wrong unit.
 */

import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  airbaseIcon,
  airdropIcon,
  airstrikeIcon,
  ballisticMissileIcon,
  clusterMissileIcon,
  coastalBatteryIcon,
  cruiseMissileIcon,
  droneIcon,
  flakGunIcon,
  minefieldIcon,
} from "../../../../src/client/hud/HotbarIcons";
import { flattenedBuildTable } from "../../../../src/client/hud/layers/BuildMenu";
import {
  STRUCTURE_ORDER,
  structureAtlasColumn,
} from "../../../../src/client/render/gl/passes/StructurePass";
import { UNIT_ORDER } from "../../../../src/client/render/gl/passes/UnitPass";
import renderSettings from "../../../../src/client/render/gl/render-settings.json";
import {
  STRUCTURE_TYPES,
  UT_FACTORY,
  UT_MINEFIELD,
  UT_SIEGE_CAMP,
} from "../../../../src/client/render/types";

const RESOURCES = path.resolve(__dirname, "../../../../resources");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { w: number; h: number } {
  const buf = fs.readFileSync(path.join(RESOURCES, file));
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function stripColumns(files: string[], cell: number): number {
  let cols = 0;
  for (const file of files) {
    const { w, h } = pngSize(file);
    expect(h, file).toBe(cell);
    expect(w % cell, file).toBe(0);
    cols += w / cell;
  }
  return cols;
}

describe("unit art atlases", () => {
  it("has one 13 px unit sprite column per UNIT_ORDER entry", () => {
    const files = ["atlases/unit-atlas.png", "atlases/unit-atlas-ext.png"];
    expect(stripColumns(files, 13)).toBe(UNIT_ORDER.length);
  });

  it("has one 64 px structure glyph column per STRUCTURE_ORDER entry", () => {
    const files = ["atlases/icon-atlas.png", "atlases/icon-atlas-ext.png"];
    expect(stripColumns(files, 64)).toBe(STRUCTURE_ORDER.length);
  });

  it("gives every structure its own shape settings", () => {
    for (const type of STRUCTURE_ORDER) {
      expect(renderSettings.structure.shapes, type).toHaveProperty(type);
    }
  });

  it("draws every visible structure with a glyph, a siege camp with the factory's", () => {
    for (const type of STRUCTURE_TYPES) {
      if (type === UT_MINEFIELD) continue;
      expect(structureAtlasColumn(type), type).toBeGreaterThanOrEqual(0);
    }
    expect(structureAtlasColumn(UT_SIEGE_CAMP)).toBe(
      STRUCTURE_ORDER.indexOf(UT_FACTORY),
    );
  });

  it("never draws a minefield as a sprite, which would show it to all", () => {
    expect(UNIT_ORDER).not.toContain(UT_MINEFIELD);
    expect(STRUCTURE_ORDER).not.toContain(UT_MINEFIELD);
  });

  it("points every build menu and unit bar icon at a file that exists", () => {
    const icons = [
      ...flattenedBuildTable.map((item) => item.icon),
      airbaseIcon,
      airdropIcon,
      airstrikeIcon,
      ballisticMissileIcon,
      clusterMissileIcon,
      coastalBatteryIcon,
      cruiseMissileIcon,
      droneIcon,
      flakGunIcon,
      minefieldIcon,
    ];
    for (const url of icons) {
      expect(fs.existsSync(path.join(RESOURCES, url)), url).toBe(true);
    }
  });

  it("gives each build menu entry a distinct icon", () => {
    const icons = flattenedBuildTable.map((item) => item.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
