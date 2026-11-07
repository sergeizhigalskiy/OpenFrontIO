import { describe, expect, it } from "vitest";
import {
  CAMERA_BLOCK_FLOATS,
  writeCameraBlock,
} from "../../../../src/client/render/gl/camera/CameraBlock";
import {
  computeCameraFrame,
  intersectRayPlane,
  ndcToRay,
  pixelToGround,
  projectToNdc,
  transformPoint,
  worldToPixel,
  type CameraPose,
} from "../../../../src/client/render/gl/camera/CameraMath";

const BASE: CameraPose = {
  centerX: 500,
  centerY: 300,
  zoom: 2,
  viewW: 1600,
  viewH: 900,
  tiltDeg: 0,
  fovDeg: 40,
};

const tilted = (over: Partial<CameraPose> = {}) =>
  computeCameraFrame({ ...BASE, tiltDeg: 30, ...over });

describe("flat camera", () => {
  it("reproduces the old 2D camera matrix exactly", () => {
    const frame = computeCameraFrame(BASE);
    expect(frame.perspective).toBe(false);
    // Old mat3: sx = zoom*2/W, sy = -zoom*2/H, tx = -cx*sx, ty = -cy*sy.
    const sx = (2 * BASE.zoom) / BASE.viewW;
    const sy = (-2 * BASE.zoom) / BASE.viewH;
    for (const [x, y] of [
      [0, 0],
      [500, 300],
      [123.5, 987.25],
    ]) {
      const [cx, cy, , cw] = transformPoint(frame.viewProj, x, y, 0);
      expect(cw).toBe(1);
      expect(cx).toBeCloseTo((x - BASE.centerX) * sx, 6);
      expect(cy).toBeCloseTo((y - BASE.centerY) * sy, 6);
    }
    expect(frame.clipScale).toBeCloseTo(sx, 9);
  });

  it("round-trips pixels and world points", () => {
    const frame = computeCameraFrame(BASE);
    const p = worldToPixel(frame, 432.5, 211.25)!;
    // The matrix is Float32, as uploaded to the GPU.
    expect(p.x).toBeCloseTo(800 + (432.5 - 500) * 2, 3);
    expect(p.y).toBeCloseTo(450 + (211.25 - 300) * 2, 3);
    const g = pixelToGround(frame, p.x, p.y)!;
    expect(g.x).toBeCloseTo(432.5, 3);
    expect(g.y).toBeCloseTo(211.25, 3);
  });
});

describe("tilted camera", () => {
  it("looks at the focus point from the south and above", () => {
    const frame = tilted();
    expect(frame.perspective).toBe(true);
    const c = projectToNdc(frame, BASE.centerX, BASE.centerY)!;
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.y).toBeCloseTo(0, 6);
    expect(frame.eye[1]).toBeGreaterThan(BASE.centerY); // south of the focus
    expect(frame.eye[2]).toBeGreaterThan(0); // above the map
    // The eye looks down at 30° from vertical.
    const angle = Math.atan2(frame.eye[1] - BASE.centerY, frame.eye[2]);
    expect((angle * 180) / Math.PI).toBeCloseTo(30, 6);
  });

  it("keeps the zoom scale across the screen at the focus", () => {
    const frame = tilted();
    const a = worldToPixel(frame, BASE.centerX, BASE.centerY)!;
    const b = worldToPixel(frame, BASE.centerX + 1, BASE.centerY)!;
    expect(b.x - a.x).toBeCloseTo(BASE.zoom, 4);
    expect(b.y - a.y).toBeCloseTo(0, 4);
  });

  it("keeps north up and shrinks the far side", () => {
    const frame = tilted();
    const north = worldToPixel(frame, BASE.centerX, BASE.centerY - 50)!;
    const south = worldToPixel(frame, BASE.centerX, BASE.centerY + 50)!;
    expect(north.y).toBeLessThan(450);
    expect(south.y).toBeGreaterThan(450);
    const width = (y: number) =>
      worldToPixel(frame, BASE.centerX + 10, y)!.x -
      worldToPixel(frame, BASE.centerX - 10, y)!.x;
    expect(width(BASE.centerY - 50)).toBeLessThan(width(BASE.centerY));
    expect(width(BASE.centerY + 50)).toBeGreaterThan(width(BASE.centerY));
    // Foreshortened: a tile north-south covers fewer pixels than east-west.
    const a = worldToPixel(frame, BASE.centerX, BASE.centerY)!;
    const b = worldToPixel(frame, BASE.centerX, BASE.centerY + 1)!;
    expect(b.y - a.y).toBeLessThan(BASE.zoom);
    expect(b.y - a.y).toBeGreaterThan(BASE.zoom * 0.8);
  });

  it("picks the same ground point it projected, anywhere on screen", () => {
    for (const tiltDeg of [25, 30, 35]) {
      const frame = tilted({ tiltDeg });
      for (const [x, y] of [
        [500, 300],
        [180, 90],
        [820, 120],
        [260, 470],
        [777.7, 444.4],
      ]) {
        const p = worldToPixel(frame, x, y)!;
        const g = pixelToGround(frame, p.x, p.y)!;
        expect(g.x).toBeCloseTo(x, 3);
        expect(g.y).toBeCloseTo(y, 3);
      }
    }
  });

  it("agrees with the matrix the shaders use", () => {
    const frame = tilted();
    const [cx, cy, cz, cw] = transformPoint(frame.viewProj, 420, 260, 3);
    const ndc = projectToNdc(frame, 420, 260, 3)!;
    expect(cx / cw).toBeCloseTo(ndc.x, 9);
    expect(cy / cw).toBeCloseTo(ndc.y, 9);
    // Inside the depth range (nothing near the focus is clipped).
    expect(Math.abs(cz / cw)).toBeLessThan(1);
  });

  it("gives the same view in CSS and device pixels", () => {
    const css = tilted();
    const device = tilted({ zoom: 4, viewW: 3200, viewH: 1800 });
    for (let i = 0; i < 16; i++) {
      expect(device.viewProj[i]).toBeCloseTo(css.viewProj[i], 6);
    }
  });
});

describe("isometric camera", () => {
  const iso = (yawDeg: number, over: Partial<CameraPose> = {}) =>
    computeCameraFrame({
      ...BASE,
      tiltDeg: 60,
      yawDeg,
      orthographic: true,
      ...over,
    });

  it("is orthographic: a tile is the same size anywhere on screen", () => {
    const frame = iso(45);
    expect(frame.perspective).toBe(false);
    const size = (x: number, y: number) => {
      const a = worldToPixel(frame, x, y)!;
      const b = worldToPixel(frame, x + 1, y + 1)!;
      return [b.x - a.x, b.y - a.y];
    };
    const [w0, h0] = size(500, 300);
    const [w1, h1] = size(100, 600);
    expect(w1).toBeCloseTo(w0, 4);
    expect(h1).toBeCloseTo(h0, 4);
  });

  it("puts the focus at the centre and keeps the zoom across the screen", () => {
    for (const yaw of [45, 135, 225, 315]) {
      const frame = iso(yaw);
      const c = projectToNdc(frame, BASE.centerX, BASE.centerY)!;
      expect(c.x).toBeCloseTo(0, 6);
      expect(c.y).toBeCloseTo(0, 6);
      // Along screen-right a ground step of one tile spans `zoom` pixels.
      const r = frame.right;
      const a = worldToPixel(frame, BASE.centerX, BASE.centerY)!;
      const b = worldToPixel(frame, BASE.centerX + r[0], BASE.centerY + r[1])!;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(BASE.zoom, 4);
    }
  });

  it("turns the ground direction given by the yaw up the screen", () => {
    // Yaw 45: north-east is straight up, south-east straight right.
    const frame = iso(45);
    const a = worldToPixel(frame, 500, 300)!;
    const ne = worldToPixel(frame, 510, 290)!;
    const se = worldToPixel(frame, 510, 310)!;
    expect(ne.x - a.x).toBeCloseTo(0, 4);
    expect(ne.y).toBeLessThan(a.y);
    expect(se.y - a.y).toBeCloseTo(0, 4);
    expect(se.x).toBeGreaterThan(a.x);
    // 2:1 dimetric at 30 degrees of elevation: depth is halved.
    expect((a.y - ne.y) / (se.x - a.x)).toBeCloseTo(0.5, 6);
  });

  it("raises heights straight up the screen", () => {
    const frame = iso(135);
    const ground = worldToPixel(frame, 420, 260, 0)!;
    const raised = worldToPixel(frame, 420, 260, 4)!;
    expect(raised.x).toBeCloseTo(ground.x, 4);
    expect(raised.y).toBeLessThan(ground.y);
    // cos(30 degrees of elevation) of the height, in pixels.
    expect(ground.y - raised.y).toBeCloseTo(
      4 * BASE.zoom * Math.cos(Math.PI / 6),
      3,
    );
  });

  it("casts parallel rays that pick what they project", () => {
    for (const yaw of [45, 135, 225, 315, 80]) {
      const frame = iso(yaw);
      const r1 = ndcToRay(frame, -0.7, 0.4);
      const r2 = ndcToRay(frame, 0.3, -0.8);
      for (let i = 0; i < 3; i++) expect(r1.dir[i]).toBeCloseTo(r2.dir[i], 9);
      for (const [x, y, z] of [
        [500, 300, 0],
        [180, 90, 0],
        [777.7, 444.4, 0],
        [420.5, 333.25, 3],
      ]) {
        const p = worldToPixel(frame, x, y, z)!;
        const [nx, ny] = [
          (p.x / BASE.viewW) * 2 - 1,
          1 - (p.y / BASE.viewH) * 2,
        ];
        const hit = intersectRayPlane(ndcToRay(frame, nx, ny), z)!;
        expect(hit.x).toBeCloseTo(x, 3);
        expect(hit.y).toBeCloseTo(y, 3);
        expect(hit.t).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the largest maps inside the clip depth range", () => {
    const frame = iso(225, { centerX: 0, centerY: 0 });
    for (const [x, y] of [
      [0, 0],
      [8000, 4000],
      [-4000, 6000],
    ]) {
      const [, , cz, cw] = transformPoint(frame.viewProj, x, y, 40);
      expect(Math.abs(cz / cw)).toBeLessThan(1);
    }
  });

  it("leaves yaw 0 without tilt as the classic flat matrix", () => {
    const flat = computeCameraFrame(BASE);
    const zero = computeCameraFrame({ ...BASE, yawDeg: 0 });
    for (let i = 0; i < 16; i++)
      expect(zero.viewProj[i]).toBe(flat.viewProj[i]);
  });
});

describe("rays", () => {
  it("sends the centre ray to the focus point", () => {
    const frame = tilted();
    const hit = intersectRayPlane(ndcToRay(frame, 0, 0), 0)!;
    expect(hit.x).toBeCloseTo(BASE.centerX, 6);
    expect(hit.y).toBeCloseTo(BASE.centerY, 6);
    expect(hit.t).toBeGreaterThan(0);
  });

  it("intersects raised planes closer to the camera", () => {
    const frame = tilted();
    const ray = ndcToRay(frame, 0.2, -0.3);
    const ground = intersectRayPlane(ray, 0)!;
    const raised = intersectRayPlane(ray, 5)!;
    expect(raised.t).toBeLessThan(ground.t);
    // Looking north, a raised hit lands south of the ground hit.
    expect(raised.y).toBeGreaterThan(ground.y);
  });

  it("misses planes that are parallel or behind the ray", () => {
    expect(
      intersectRayPlane({ origin: [0, 0, 10], dir: [1, 0, 0] }, 0),
    ).toBeNull();
    expect(
      intersectRayPlane({ origin: [0, 0, 10], dir: [0, 0, 1] }, 0),
    ).toBeNull();
  });
});

describe("camera block", () => {
  it("packs the matrix, basis and surface into std140 order", () => {
    const frame = tilted();
    const out = new Float32Array(CAMERA_BLOCK_FLOATS);
    writeCameraBlock(
      frame,
      { mapW: 2000, mapH: 1000, heightScale: 3, billboard: true },
      out,
    );
    expect(CAMERA_BLOCK_FLOATS).toBe(36);
    for (let i = 0; i < 16; i++) expect(out[i]).toBe(frame.viewProj[i]);
    expect(out[19]).toBeCloseTo(frame.clipScale, 7);
    expect(out[20]).toBe(0); // up.x
    expect(out[23]).toBeCloseTo(frame.focusDist, 3);
    expect(out[32]).toBeCloseTo(1 / 2000, 9);
    expect(out[33]).toBeCloseTo(1 / 1000, 9);
    expect(out[34]).toBe(3);
    expect(out[35]).toBe(1);
  });

  it("marks the flat camera as orthographic", () => {
    const out = new Float32Array(CAMERA_BLOCK_FLOATS);
    writeCameraBlock(
      computeCameraFrame(BASE),
      { mapW: 10, mapH: 10, heightScale: 0, billboard: false },
      out,
    );
    expect(out[23]).toBe(0);
    expect(out[34]).toBe(0);
    expect(out[35]).toBe(0);
  });
});
