import { Cell } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { describe, expect, it } from "vitest";
import { DragEvent, ZoomEvent } from "../../src/client/InputHandler";
import {
  computeCameraFrame,
  worldToPixel,
} from "../../src/client/render/gl/camera/CameraMath";
import type { MapViewSource } from "../../src/client/render/gl/camera/MapViewSource";
import type { MapViewMode } from "../../src/client/render/gl/GraphicsOverrides";
import { TransformHandler } from "../../src/client/TransformHandler";
import type { GameView } from "../../src/client/view";

const W = 1200;
const H = 800;

function makeHandler(
  mode: MapViewMode,
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
  const view = { mode, tiltDeg: 30, fovDeg: 40, isoElevationDeg: 30 };
  const source: MapViewSource = {
    view: () => view,
    yawDeg: () => 45,
    heightAt,
    maxHeight: () => maxHeight,
  };
  handler.setMapView(source);
  return { handler, eventBus, view };
}

/** The frame the renderer would draw with for this handler's state. */
function rendererFrame(handler: TransformHandler) {
  const focus = handler.focusPoint();
  return computeCameraFrame({
    centerX: focus.x,
    centerY: focus.y,
    zoom: handler.scale,
    viewW: W,
    viewH: H,
    tiltDeg: 30,
    fovDeg: 40,
  });
}

describe("TransformHandler with a tilted camera", () => {
  it("picks the tile the renderer drew under the cursor", () => {
    const { handler } = makeHandler("tilt");
    const frame = rendererFrame(handler);
    for (const [x, y] of [
      [300.5, 200.5],
      [520.5, 140.5],
      [610.5, 380.5],
    ]) {
      const p = worldToPixel(frame, x, y)!;
      const cell = handler.screenToWorldCoordinates(p.x, p.y);
      expect(cell.x).toBe(Math.floor(x));
      expect(cell.y).toBe(Math.floor(y));
    }
  });

  it("projects cells back to where it picks them", () => {
    const { handler } = makeHandler("tilt");
    const cell = new Cell(410, 260);
    const p = handler.worldToScreenCoordinates(cell);
    const back = handler.screenToWorldCoordinatesFloat(p.x, p.y);
    expect(back.x).toBeCloseTo(410, 3);
    expect(back.y).toBeCloseTo(260, 3);
  });

  it("keeps the ground under the cursor fixed while zooming", () => {
    const { handler, eventBus } = makeHandler("tilt");
    const before = handler.screenToWorldCoordinatesFloat(300, 200);
    eventBus.emit(new ZoomEvent(300, 200, -200));
    expect(handler.scale).toBeGreaterThan(2.5);
    const after = handler.screenToWorldCoordinatesFloat(300, 200);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
  });

  it("drags the screen-centre ground with the cursor", () => {
    const { handler, eventBus } = makeHandler("tilt");
    const target = handler.screenToWorldCoordinatesFloat(W / 2, H / 2);
    eventBus.emit(new DragEvent(40, -25));
    const moved = handler.screenToWorldCoordinatesFloat(W / 2 + 40, H / 2 - 25);
    expect(moved.x).toBeCloseTo(target.x, 3);
    expect(moved.y).toBeCloseTo(target.y, 3);
  });

  it("centres go-to targets on the camera focus", () => {
    const { handler } = makeHandler("tilt");
    const focus = handler.focusPoint();
    const center = handler.screenCenter();
    expect(center.screenX).toBe(Math.floor(focus.x));
    expect(center.screenY).toBe(Math.floor(focus.y));
    const centre = handler.screenToWorldCoordinatesFloat(W / 2, H / 2);
    expect(centre.x).toBeCloseTo(focus.x, 6);
    expect(centre.y).toBeCloseTo(focus.y, 6);
  });

  it("keeps the classic 2D math in flat mode", () => {
    const flat = makeHandler("flat").handler;
    const plain = new TransformHandler(
      {
        width: () => 1000,
        height: () => 600,
        myPlayer: () => null,
      } as unknown as GameView,
      new EventBus(),
      Object.assign(document.createElement("div"), {
        getBoundingClientRect: () =>
          ({ left: 0, top: 0, width: W, height: H }) as DOMRect,
      }),
    );
    plain.override(20, -30, 2.5);
    for (const [sx, sy] of [
      [0, 0],
      [333, 444],
      [W, H],
    ]) {
      expect(flat.screenToWorldCoordinatesFloat(sx, sy)).toEqual(
        plain.screenToWorldCoordinatesFloat(sx, sy),
      );
    }
    expect(flat.screenBoundingRect()).toEqual(plain.screenBoundingRect());
  });

  it("picks raised 3D terrain where it is drawn, not the ground behind", () => {
    const hill = (x: number, y: number) =>
      6 * Math.exp(-((x - 450) ** 2 + (y - 250) ** 2) / 300);
    const { handler } = makeHandler("terrain3d", hill, 6);
    const frame = rendererFrame(handler);
    for (const [x, y] of [
      [450.5, 250.5],
      [440.5, 262.5],
      [461.5, 241.5],
    ]) {
      const p = worldToPixel(frame, x, y, hill(x, y))!;
      const cell = handler.screenToWorldCoordinates(p.x, p.y);
      expect(cell.x).toBe(Math.floor(x));
      expect(cell.y).toBe(Math.floor(y));
    }
    // worldToScreen lifts the cell onto the terrain too.
    const p = handler.worldToScreenCoordinates(new Cell(450, 250));
    const q = worldToPixel(frame, 450, 250, hill(450, 250))!;
    expect(p.x).toBeCloseTo(q.x, 6);
    expect(p.y).toBeCloseTo(q.y, 6);
  });

  it("switches live when the view mode changes", () => {
    const { handler, view } = makeHandler("tilt");
    const tiltedPick = handler.screenToWorldCoordinatesFloat(100, 80);
    view.mode = "flat";
    const flatPick = handler.screenToWorldCoordinatesFloat(100, 80);
    expect(flatPick.y).not.toBeCloseTo(tiltedPick.y, 0);
  });
});
