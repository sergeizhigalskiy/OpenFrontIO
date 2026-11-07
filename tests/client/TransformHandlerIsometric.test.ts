import { Cell } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { describe, expect, it } from "vitest";
import { DragEvent, ZoomEvent } from "../../src/client/InputHandler";
import {
  computeCameraFrame,
  worldToPixel,
} from "../../src/client/render/gl/camera/CameraMath";
import {
  viewPose,
  type MapViewParams,
  type MapViewSource,
} from "../../src/client/render/gl/camera/MapViewSource";
import {
  ISO_BASE_YAW_DEG,
  ViewRotation,
} from "../../src/client/render/gl/camera/ViewRotation";
import { TransformHandler } from "../../src/client/TransformHandler";
import type { GameView } from "../../src/client/view";

/**
 * Screen-to-tile mapping in the isometric view, at each of its four
 * rotations: every click, hover, radial menu, spawn pick, attack and
 * targeting path goes through these TransformHandler methods, and they must
 * agree with the frame the renderer draws (viewPose + computeCameraFrame).
 */

const W = 1280;
const H = 720;
const ROTATIONS = [0, 1, 2, 3];

function makeHandler(
  rotation: number,
  heightAt = (_x: number, _y: number) => 0,
  maxHeight = 0,
) {
  const game = {
    width: () => 1000,
    height: () => 600,
    myPlayer: () => null,
  } as unknown as GameView;
  const eventBus = new EventBus();
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H }) as DOMRect;
  const handler = new TransformHandler(game, eventBus, el);
  handler.override(20, -30, 2.5);
  const view: MapViewParams = {
    mode: "isometric",
    tiltDeg: 30,
    fovDeg: 40,
    isoElevationDeg: 30,
  };
  const turn = new ViewRotation();
  turn.set(rotation);
  const source: MapViewSource = {
    view: () => view,
    yawDeg: () => turn.yawDeg(),
    heightAt,
    maxHeight: () => maxHeight,
  };
  handler.setMapView(source);
  return { handler, eventBus, view, turn, source };
}

/** The frame the renderer would draw with for this handler's state. */
function rendererFrame(handler: TransformHandler, source: MapViewSource) {
  const focus = handler.focusPoint();
  return computeCameraFrame(
    viewPose(
      source.view(),
      source.yawDeg(),
      focus.x,
      focus.y,
      handler.scale,
      W,
      H,
    ),
  );
}

describe.each(ROTATIONS)("isometric picking at rotation %i", (rotation) => {
  it("picks the tile the renderer drew under the cursor", () => {
    const { handler, source } = makeHandler(rotation);
    const frame = rendererFrame(handler, source);
    for (const [x, y] of [
      [300.5, 200.5],
      [520.5, 140.5],
      [610.5, 380.5],
      [455.25, 233.75],
    ]) {
      const p = worldToPixel(frame, x, y)!;
      const cell = handler.screenToWorldCoordinates(p.x, p.y);
      expect(cell.x).toBe(Math.floor(x));
      expect(cell.y).toBe(Math.floor(y));
    }
  });

  it("picks each corner of a tile as that tile", () => {
    const { handler, source } = makeHandler(rotation);
    const frame = rendererFrame(handler, source);
    // Just inside each corner of tile (431, 257): a turned tile is a diamond
    // on screen, so its corners are where neighbours would be mis-picked.
    for (const [dx, dy] of [
      [0.05, 0.05],
      [0.95, 0.05],
      [0.05, 0.95],
      [0.95, 0.95],
    ]) {
      const p = worldToPixel(frame, 431 + dx, 257 + dy)!;
      const cell = handler.screenToWorldCoordinates(p.x, p.y);
      expect([cell.x, cell.y]).toEqual([431, 257]);
    }
  });

  it("projects cells back to where it picks them", () => {
    const { handler } = makeHandler(rotation);
    const cell = new Cell(410, 260);
    const p = handler.worldToScreenCoordinates(cell);
    const back = handler.screenToWorldCoordinatesFloat(p.x, p.y);
    expect(back.x).toBeCloseTo(410, 3);
    expect(back.y).toBeCloseTo(260, 3);
  });

  it("keeps the ground under the cursor fixed while zooming", () => {
    const { handler, eventBus } = makeHandler(rotation);
    const before = handler.screenToWorldCoordinatesFloat(300, 200);
    eventBus.emit(new ZoomEvent(300, 200, -200));
    expect(handler.scale).toBeGreaterThan(2.5);
    const after = handler.screenToWorldCoordinatesFloat(300, 200);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
  });

  it("drags the ground with the cursor in screen directions", () => {
    const { handler, eventBus } = makeHandler(rotation);
    const target = handler.screenToWorldCoordinatesFloat(W / 2, H / 2);
    eventBus.emit(new DragEvent(40, -25));
    const moved = handler.screenToWorldCoordinatesFloat(W / 2 + 40, H / 2 - 25);
    expect(moved.x).toBeCloseTo(target.x, 3);
    expect(moved.y).toBeCloseTo(target.y, 3);
  });

  it("keeps the focus at the screen centre", () => {
    const { handler } = makeHandler(rotation);
    const focus = handler.focusPoint();
    const centre = handler.screenToWorldCoordinatesFloat(W / 2, H / 2);
    expect(centre.x).toBeCloseTo(focus.x, 6);
    expect(centre.y).toBeCloseTo(focus.y, 6);
    const c = handler.screenCenter();
    expect(c.screenX).toBe(Math.floor(focus.x));
    expect(c.screenY).toBe(Math.floor(focus.y));
  });

  it("picks raised terrain where it is drawn, not the ground behind", () => {
    const hill = (x: number, y: number) =>
      6 * Math.exp(-((x - 450) ** 2 + (y - 250) ** 2) / 300);
    const { handler, source } = makeHandler(rotation, hill, 6);
    const frame = rendererFrame(handler, source);
    for (const [x, y] of [
      [450.5, 250.5],
      [440.5, 262.5],
      [461.5, 241.5],
      [447.5, 236.5],
    ]) {
      const p = worldToPixel(frame, x, y, hill(x, y))!;
      const cell = handler.screenToWorldCoordinates(p.x, p.y);
      expect(cell.x).toBe(Math.floor(x));
      expect(cell.y).toBe(Math.floor(y));
    }
    const p = handler.worldToScreenCoordinates(new Cell(450, 250));
    const q = worldToPixel(frame, 450, 250, hill(450, 250))!;
    expect(p.x).toBeCloseTo(q.x, 6);
    expect(p.y).toBeCloseTo(q.y, 6);
  });

  it("covers the visible ground with its bounding rect", () => {
    const { handler } = makeHandler(rotation);
    const [tl, br] = handler.screenBoundingRect();
    for (const [sx, sy] of [
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
      [W / 2, H / 2],
    ]) {
      const g = handler.screenToWorldCoordinatesFloat(sx, sy);
      expect(g.x).toBeGreaterThanOrEqual(tl.x);
      expect(g.y).toBeGreaterThanOrEqual(tl.y);
      expect(g.x).toBeLessThanOrEqual(br.x + 1);
      expect(g.y).toBeLessThanOrEqual(br.y + 1);
    }
    const on = handler.worldToScreenCoordinates(new Cell(400, 250));
    expect(on.x).toBeGreaterThan(0);
    expect(handler.isOnScreen(new Cell(400, 250))).toBe(
      on.x > 0 && on.x < W && on.y > 0 && on.y < H,
    );
  });
});

describe("isometric rotation", () => {
  it("turns the map a quarter turn counter-clockwise per left turn", () => {
    const { handler, turn } = makeHandler(0);
    const north = (k: number) => {
      turn.set(k);
      const a = handler.worldToScreenCoordinates(new Cell(400, 300));
      const b = handler.worldToScreenCoordinates(new Cell(400, 290));
      return Math.atan2(-(b.y - a.y), b.x - a.x) * (180 / Math.PI);
    };
    // Rotation 0 has north-west up the screen, so north points up-right;
    // each left turn moves it another 90 degrees counter-clockwise. Depth is
    // halved on screen (2:1), which pulls the angles toward the horizontal.
    const squashed = (deg: number) => {
      const r = (deg * Math.PI) / 180;
      return Math.atan2(0.5 * Math.sin(r), Math.cos(r)) * (180 / Math.PI);
    };
    expect(north(0)).toBeCloseTo(squashed(45), 4);
    expect(north(1)).toBeCloseTo(squashed(135), 4);
    expect(north(2)).toBeCloseTo(squashed(225), 4);
    expect(north(3)).toBeCloseTo(squashed(315), 4);
  });

  it("draws tiles as 2:1 diamonds", () => {
    const { handler } = makeHandler(0);
    const corners = [
      [400, 300],
      [401, 300],
      [401, 301],
      [400, 301],
    ].map(([x, y]) => handler.worldToScreenCoordinates(new Cell(x, y)));
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    expect(w / h).toBeCloseTo(2, 6);
    // A tile's diagonal spans sqrt(2) tiles of zoom across the screen.
    expect(w).toBeCloseTo(Math.SQRT2 * 2.5, 6);
  });

  it("picks right mid-animation, at whatever yaw is drawn", () => {
    const { handler, turn, source } = makeHandler(0);
    turn.rotate(1, 1000);
    turn.update(1000 + 120);
    // Between rotation 0 (315) and rotation 1 (45), through north.
    const yaw = (turn.yawDeg() - ISO_BASE_YAW_DEG + 360) % 360;
    expect(yaw).toBeGreaterThan(0);
    expect(yaw).toBeLessThan(90);
    const frame = rendererFrame(handler, source);
    const p = worldToPixel(frame, 377.5, 211.5)!;
    const cell = handler.screenToWorldCoordinates(p.x, p.y);
    expect([cell.x, cell.y]).toEqual([377, 211]);
  });

  it("rotates about the screen centre", () => {
    const { handler, turn } = makeHandler(0);
    const before = handler.screenToWorldCoordinatesFloat(W / 2, H / 2);
    turn.set(2);
    const after = handler.screenToWorldCoordinatesFloat(W / 2, H / 2);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });
});

describe("ViewRotation", () => {
  it("rests at 315 + 90k and wraps", () => {
    const r = new ViewRotation(100);
    expect(r.yawDeg()).toBe(315);
    r.rotate(-1, 0);
    r.update(100);
    expect(r.yawDeg()).toBe(225);
    expect(r.quarterTurns()).toBe(3);
    r.rotate(1, 200);
    r.rotate(1, 200);
    r.update(400);
    expect(r.yawDeg()).toBe(45);
    expect(r.quarterTurns()).toBe(1);
  });

  it("eases between turns and settles exactly", () => {
    const r = new ViewRotation(100);
    r.rotate(-1, 0);
    expect(r.animating(50)).toBe(true);
    const mid = r.update(50);
    expect(mid).toBeGreaterThan(225);
    expect(mid).toBeLessThan(315);
    expect(r.update(100)).toBe(225);
    expect(r.animating(150)).toBe(false);
  });
});
