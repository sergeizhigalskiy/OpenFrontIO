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
  MAX_ELEVATION_DEG,
  MIN_ELEVATION_DEG,
  ViewOrbit,
} from "../../src/client/render/gl/camera/ViewOrbit";
import { TransformHandler } from "../../src/client/TransformHandler";
import type { GameView } from "../../src/client/view";

/**
 * Screen-to-tile mapping in the isometric view as the camera orbits: every
 * click, hover, radial menu, spawn pick, attack and boat or nuke target goes
 * through these TransformHandler methods, and they must agree with the
 * frame the renderer draws (viewPose + computeCameraFrame) at any yaw and
 * tilt, on flat ground and on raised terrain.
 */

const W = 1280;
const H = 720;

/** Orbits to test: the four quarter turns, odd angles, low and steep tilts. */
const ORBITS: [number, number][] = [
  [315, 30],
  [45, 30],
  [135, 30],
  [225, 30],
  [17, 30],
  [278.5, 47],
  [100, MIN_ELEVATION_DEG],
  [333, MAX_ELEVATION_DEG],
  [190, 62],
];

const hill = (x: number, y: number) =>
  6 * Math.exp(-((x - 450) ** 2 + (y - 250) ** 2) / 300);

function makeHandler(
  yawDeg = ISO_BASE_YAW_DEG,
  elevationDeg = 30,
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
  const view: MapViewParams = { mode: "isometric", tiltDeg: 30, fovDeg: 40 };
  const orbit = new ViewOrbit(30, 100);
  orbit.set(yawDeg, elevationDeg);
  const source: MapViewSource = {
    view: () => view,
    orbit: () => orbit.current(),
    heightAt,
    maxHeight: () => maxHeight,
  };
  handler.setMapView(source);
  return { handler, eventBus, view, orbit, source };
}

/** The frame the renderer would draw with for this handler's state. */
function rendererFrame(handler: TransformHandler, source: MapViewSource) {
  const focus = handler.focusPoint();
  return computeCameraFrame(
    viewPose(
      source.view(),
      source.orbit(),
      focus.x,
      focus.y,
      handler.scale,
      W,
      H,
    ),
  );
}

describe.each(ORBITS)(
  "isometric picking at yaw %f, elevation %f",
  (yaw, elevation) => {
    it("picks the tile the renderer drew under the cursor", () => {
      const { handler, source } = makeHandler(yaw, elevation);
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
      const { handler, source } = makeHandler(yaw, elevation);
      const frame = rendererFrame(handler, source);
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

    it("picks raised terrain where it is drawn, not the ground behind", () => {
      const { handler, source } = makeHandler(yaw, elevation, hill, 6);
      const frame = rendererFrame(handler, source);
      for (const [x, y] of [
        [450.5, 250.5],
        [440.5, 262.5],
        [461.5, 241.5],
        [447.5, 236.5],
        [456.5, 255.5],
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

    it("projects cells back to where it picks them", () => {
      const { handler } = makeHandler(yaw, elevation, hill, 6);
      for (const [x, y] of [
        [410, 260],
        [452, 248],
      ]) {
        const p = handler.worldToScreenCoordinates(new Cell(x, y));
        const back = handler.screenToWorldCoordinatesFloat(p.x, p.y);
        expect(back.x).toBeCloseTo(x, 2);
        expect(back.y).toBeCloseTo(y, 2);
      }
    });

    it("keeps the ground under the cursor fixed while zooming", () => {
      const { handler, eventBus } = makeHandler(yaw, elevation);
      const before = handler.screenToWorldCoordinatesFloat(300, 200);
      eventBus.emit(new ZoomEvent(300, 200, -200));
      expect(handler.scale).toBeGreaterThan(2.5);
      const after = handler.screenToWorldCoordinatesFloat(300, 200);
      expect(after.x).toBeCloseTo(before.x, 3);
      expect(after.y).toBeCloseTo(before.y, 3);
    });

    it("drags the ground with the cursor in screen directions", () => {
      const { handler, eventBus } = makeHandler(yaw, elevation);
      const target = handler.screenToWorldCoordinatesFloat(W / 2, H / 2);
      eventBus.emit(new DragEvent(40, -25));
      const moved = handler.screenToWorldCoordinatesFloat(
        W / 2 + 40,
        H / 2 - 25,
      );
      expect(moved.x).toBeCloseTo(target.x, 3);
      expect(moved.y).toBeCloseTo(target.y, 3);
    });

    it("keeps the focus at the screen centre", () => {
      const { handler } = makeHandler(yaw, elevation);
      const focus = handler.focusPoint();
      const centre = handler.screenToWorldCoordinatesFloat(W / 2, H / 2);
      expect(centre.x).toBeCloseTo(focus.x, 6);
      expect(centre.y).toBeCloseTo(focus.y, 6);
    });

    it("covers the visible ground with its bounding rect", () => {
      const { handler } = makeHandler(yaw, elevation);
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
    });
  },
);

describe("isometric orbit", () => {
  it("starts as 2:1 isometric with north up and to the right", () => {
    const { handler } = makeHandler();
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
    expect(w).toBeCloseTo(Math.SQRT2 * 2.5, 6);
    const a = handler.worldToScreenCoordinates(new Cell(400, 300));
    const n = handler.worldToScreenCoordinates(new Cell(400, 290));
    expect(n.x).toBeGreaterThan(a.x);
    expect(n.y).toBeLessThan(a.y);
  });

  it("turns the map counter-clockwise on screen as the camera turns left", () => {
    const { handler, orbit } = makeHandler(ISO_BASE_YAW_DEG, 85);
    const northAngle = () => {
      const a = handler.worldToScreenCoordinates(new Cell(400, 300));
      const b = handler.worldToScreenCoordinates(new Cell(400, 290));
      return Math.atan2(-(b.y - a.y), b.x - a.x) * (180 / Math.PI);
    };
    // Nearly top-down, so the screen angle follows the yaw closely.
    const before = northAngle();
    orbit.orbit(20, 0);
    let turned = northAngle() - before;
    if (turned < -180) turned += 360;
    expect(turned).toBeGreaterThan(15);
    expect(turned).toBeLessThan(25);
  });

  it("orbits and tilts about the screen centre", () => {
    const { handler, orbit } = makeHandler();
    const before = handler.screenToWorldCoordinatesFloat(W / 2, H / 2);
    orbit.orbit(73, 21);
    const after = handler.screenToWorldCoordinatesFloat(W / 2, H / 2);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("keeps the angle through zooming and panning", () => {
    const { eventBus, orbit } = makeHandler(123, 55);
    eventBus.emit(new ZoomEvent(400, 300, -150));
    eventBus.emit(new DragEvent(-60, 35));
    expect(orbit.yawDeg()).toBe(123);
    expect(orbit.elevationDeg()).toBe(55);
  });

  it("picks right mid-reset, at whatever angle is drawn", () => {
    const { handler, orbit, source } = makeHandler(80, 70, hill, 6);
    orbit.reset(1000);
    orbit.update(1040);
    expect(orbit.animating()).toBe(true);
    const frame = rendererFrame(handler, source);
    const p = worldToPixel(frame, 452.5, 247.5, hill(452.5, 247.5))!;
    const cell = handler.screenToWorldCoordinates(p.x, p.y);
    expect([cell.x, cell.y]).toEqual([452, 247]);
  });
});

describe("ViewOrbit", () => {
  it("turns freely and wraps the yaw", () => {
    const o = new ViewOrbit(30, 100);
    expect(o.yawDeg()).toBe(ISO_BASE_YAW_DEG);
    o.orbit(50, 0);
    expect(o.yawDeg()).toBeCloseTo(5, 9);
    o.orbit(-12.5, 0);
    expect(o.yawDeg()).toBeCloseTo(352.5, 9);
  });

  it("keeps the tilt between a low oblique view and nearly top-down", () => {
    const o = new ViewOrbit(30, 100);
    o.orbit(0, -90);
    expect(o.elevationDeg()).toBe(MIN_ELEVATION_DEG);
    o.orbit(0, 200);
    expect(o.elevationDeg()).toBe(MAX_ELEVATION_DEG);
    expect(MIN_ELEVATION_DEG).toBeLessThan(30);
    expect(MAX_ELEVATION_DEG).toBeGreaterThan(80);
  });

  it("resets the short way round to the default view, eased", () => {
    const o = new ViewOrbit(30, 100);
    o.set(10, 70);
    o.reset(0);
    o.update(50);
    // Halfway from 10 back to 315 the short way is through 0, not 180.
    const mid = o.yawDeg();
    expect(mid > 315 || mid < 10).toBe(true);
    expect(o.elevationDeg()).toBeGreaterThan(30);
    expect(o.elevationDeg()).toBeLessThan(70);
    o.update(100);
    expect(o.yawDeg()).toBe(ISO_BASE_YAW_DEG);
    expect(o.elevationDeg()).toBe(30);
    expect(o.animating()).toBe(false);
  });

  it("lets a drag interrupt a reset", () => {
    const o = new ViewOrbit(30, 100);
    o.set(100, 60);
    o.reset(0);
    o.orbit(5, 0);
    expect(o.animating()).toBe(false);
    o.update(100);
    expect(o.yawDeg()).toBeCloseTo(105, 9);
  });
});
