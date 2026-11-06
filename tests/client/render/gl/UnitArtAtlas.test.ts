/**
 * The unit atlas is a base PNG plus an extension strip (scripts/genUnitArt.ts)
 * uploaded side by side, and the passes find a type's art by its index in
 * UNIT_ORDER / STRUCTURE_ORDER. Nothing ties the two together but these
 * checks: a column added to one and not the other would shift every later
 * sprite onto the wrong unit.
 */

import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { flattenedBuildTable } from "../../../../src/client/hud/layers/BuildMenu";
import {
  STRUCTURE_ORDER,
  structureAtlasColumn,
} from "../../../../src/client/render/gl/passes/StructurePass";
import { UNIT_ORDER } from "../../../../src/client/render/gl/passes/UnitPass";
import renderSettings from "../../../../src/client/render/gl/render-settings.json";
import { STRUCTURE_TYPES } from "../../../../src/client/render/types";

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
    expect(stripColumns(["atlases/icon-atlas.png"], 64)).toBe(
      STRUCTURE_ORDER.length,
    );
  });

  it("gives every structure its own shape settings", () => {
    for (const type of STRUCTURE_ORDER) {
      expect(renderSettings.structure.shapes, type).toHaveProperty(type);
    }
  });

  it("draws every visible structure with a glyph of its own", () => {
    const columns = new Set<number>();
    for (const type of STRUCTURE_TYPES) {
      const col = structureAtlasColumn(type);
      expect(col, type).toBeGreaterThanOrEqual(0);
      columns.add(col);
    }
    expect(columns.size).toBe(STRUCTURE_ORDER.length);
  });

  it("points every build menu icon at a file that exists", () => {
    for (const url of flattenedBuildTable.map((item) => item.icon)) {
      expect(fs.existsSync(path.join(RESOURCES, url)), url).toBe(true);
    }
  });

  it("gives each build menu entry a distinct icon", () => {
    const icons = flattenedBuildTable.map((item) => item.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
