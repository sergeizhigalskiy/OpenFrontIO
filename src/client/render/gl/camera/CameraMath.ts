/**
 * Camera math — pure functions, no GL or DOM.
 *
 * One pose (focus point, zoom, viewport, tilt) gives one CameraFrame: the
 * view-projection every shader uses (via the camera uniform block) and the
 * basis that picking uses to turn a screen point back into a ray. The
 * renderer and TransformHandler both build frames from the same pose, so
 * what is drawn and what is clicked always agree.
 *
 * World axes: x east, y south (down the screen), z up out of the map, in
 * tiles. A tilt of 0 is the classic top-down view and uses an orthographic
 * projection that is exactly the old 2D camera matrix. A positive tilt swings
 * the camera south and looks north, through a perspective projection whose
 * scale at the focus point equals `zoom` across the screen.
 *
 * The isometric view is orthographic too, but tilted and turned: `yawDeg`
 * turns the camera about the vertical (the compass direction that points up
 * the screen, 0 = north), and `orthographic` keeps every ray parallel, so a
 * tile is the same size anywhere on screen and `zoom` is the pixels per tile
 * along the screen's horizontal.
 */

export type Vec3 = [number, number, number];

export interface CameraPose {
  /** World point at the centre of the screen (on the ground plane). */
  centerX: number;
  centerY: number;
  /** Pixels per world tile at the focus point. */
  zoom: number;
  /** Viewport size, in the same pixel unit as zoom. */
  viewW: number;
  viewH: number;
  /** Camera tilt away from straight down, degrees. 0 = orthographic. */
  tiltDeg: number;
  /** Vertical field of view, degrees (perspective only). */
  fovDeg: number;
  /**
   * Compass azimuth of the ground direction that points up the screen,
   * degrees clockwise from north (0 = north up, the classic view).
   */
  yawDeg?: number;
  /** Parallel projection even when tilted (the isometric view). */
  orthographic?: boolean;
}

export interface CameraFrame {
  perspective: boolean;
  /** World (x, y, z) → clip, column-major. */
  viewProj: Float32Array;
  eye: Vec3;
  /** Screen-right, screen-up and view direction in world space. */
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  /** Eye-to-focus distance (0 when orthographic). */
  focusDist: number;
  /** Focal length 1 / tan(fov / 2). */
  focal: number;
  aspect: number;
  /** Clip units per world tile at the focus point, along x. */
  clipScale: number;
  centerX: number;
  centerY: number;
  zoom: number;
  viewW: number;
  viewH: number;
}

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/** Near/far planes as multiples of the focus distance. No pass depth-tests,
 *  so these only need to bracket the scene. */
const NEAR_FACTOR = 0.01;
const FAR_FACTOR = 100;
/** Orthographic depth scale: maps heights into clip z (keeps it invertible). */
const ORTHO_Z = 1 / 4096;
/**
 * Tilted orthographic depth scale: view depth in tiles to clip z. Small
 * enough that the largest map's diagonal stays well inside the clip range.
 */
const ORTHO_DEPTH_Z = 1 / 32768;
/** How far back along the view direction an orthographic ray starts, tiles. */
const ORTHO_EYE_DIST = 1e5;

const DEG = Math.PI / 180;

export function createCameraFrame(): CameraFrame {
  return {
    perspective: false,
    viewProj: new Float32Array(16),
    eye: [0, 0, 0],
    right: [1, 0, 0],
    up: [0, -1, 0],
    forward: [0, 0, -1],
    focusDist: 0,
    focal: 1,
    aspect: 1,
    clipScale: 0,
    centerX: 0,
    centerY: 0,
    zoom: 1,
    viewW: 1,
    viewH: 1,
  };
}

/** Build the frame for a pose, writing into `out` (allocated if omitted). */
export function computeCameraFrame(
  pose: CameraPose,
  out: CameraFrame = createCameraFrame(),
): CameraFrame {
  const w = Math.max(1, pose.viewW);
  const h = Math.max(1, pose.viewH);
  const zoom = pose.zoom;
  const cx = pose.centerX;
  const cy = pose.centerY;
  out.centerX = cx;
  out.centerY = cy;
  out.zoom = zoom;
  out.viewW = w;
  out.viewH = h;
  out.aspect = w / h;
  out.clipScale = (2 * zoom) / w;
  const m = out.viewProj;
  m.fill(0);

  const yaw = (pose.yawDeg ?? 0) * DEG;
  // The isometric camera (orthographic) keeps its own depth mapping even
  // looking straight down north-up, its default view, so relief and the
  // overlays draped on it sort the same at every tilt.
  if (!(pose.tiltDeg > 0) && yaw === 0 && pose.orthographic !== true) {
    // Orthographic top-down: the old mat3, lifted to 4×4.
    out.perspective = false;
    const sx = (2 * zoom) / w;
    const sy = (-2 * zoom) / h;
    m[0] = sx;
    m[5] = sy;
    m[10] = -ORTHO_Z;
    m[12] = -cx * sx;
    m[13] = -cy * sy;
    m[15] = 1;
    out.eye = [cx, cy, 1e6];
    out.right = [1, 0, 0];
    out.up = [0, -1, 0];
    out.forward = [0, 0, -1];
    out.focusDist = 0;
    out.focal = 1;
    return out;
  }

  const tilt = Math.max(0, pose.tiltDeg) * DEG;
  const st = Math.sin(tilt);
  const ct = Math.cos(tilt);
  // Ground directions: `ahead` points up the screen, `side` to its right.
  const ax = Math.sin(yaw);
  const ay = -Math.cos(yaw);
  const R: Vec3 = [-ay, ax, 0];
  const U: Vec3 = [ax * ct, ay * ct, st];
  const F: Vec3 = [ax * st, ay * st, -ct];

  if (pose.orthographic === true || !(pose.tiltDeg > 0)) {
    out.perspective = false;
    out.right = R;
    out.up = U;
    out.forward = F;
    out.focusDist = 0;
    out.focal = 1;
    out.eye = [
      cx - F[0] * ORTHO_EYE_DIST,
      cy - F[1] * ORTHO_EYE_DIST,
      -F[2] * ORTHO_EYE_DIST,
    ];
    const sx = (2 * zoom) / w;
    const sy = (2 * zoom) / h;
    // x = sx·(R·(P−C)), y = sy·(U·(P−C)), z = ORTHO_DEPTH_Z·(F·(P−C)).
    const rC = R[0] * cx + R[1] * cy;
    const uC = U[0] * cx + U[1] * cy;
    const fC = F[0] * cx + F[1] * cy;
    setRow(m, 0, sx * R[0], sx * R[1], sx * R[2], -sx * rC);
    setRow(m, 1, sy * U[0], sy * U[1], sy * U[2], -sy * uC);
    setRow(
      m,
      2,
      ORTHO_DEPTH_Z * F[0],
      ORTHO_DEPTH_Z * F[1],
      ORTHO_DEPTH_Z * F[2],
      -ORTHO_DEPTH_Z * fC,
    );
    setRow(m, 3, 0, 0, 0, 1);
    return out;
  }

  out.perspective = true;
  const f = 1 / Math.tan((Math.max(1, pose.fovDeg) * DEG) / 2);
  // Distance at which one tile at the focus spans `zoom` pixels.
  const d = (f * h) / (2 * zoom);
  const E: Vec3 = [cx - F[0] * d, cy - F[1] * d, -F[2] * d];
  out.eye = E;
  out.right = R;
  out.up = U;
  out.forward = F;
  out.focusDist = d;
  out.focal = f;

  const near = d * NEAR_FACTOR;
  const far = d * FAR_FACTOR;
  const A = (far + near) / (far - near);
  const B = (-2 * far * near) / (far - near);
  const rE = dot(R, E);
  const uE = dot(U, E);
  const fE = dot(F, E);
  const fx = f / out.aspect;
  // Rows: x = fx·(R·(P−E)), y = f·(U·(P−E)), z = A·(F·(P−E)) + B, w = F·(P−E).
  setRow(m, 0, fx * R[0], fx * R[1], fx * R[2], -fx * rE);
  setRow(m, 1, f * U[0], f * U[1], f * U[2], -f * uE);
  setRow(m, 2, A * F[0], A * F[1], A * F[2], -A * fE + B);
  setRow(m, 3, F[0], F[1], F[2], -fE);
  return out;
}

function setRow(
  m: Float32Array,
  row: number,
  a: number,
  b: number,
  c: number,
  d: number,
): void {
  m[row] = a;
  m[4 + row] = b;
  m[8 + row] = c;
  m[12 + row] = d;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Multiply a world point by the view-projection (returns clip x, y, z, w). */
export function transformPoint(
  m: Float32Array,
  x: number,
  y: number,
  z: number,
): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

/**
 * Project a world point to normalized device coordinates (x right, y up,
 * both -1..1 across the viewport). Null when the point is behind the camera.
 */
export function projectToNdc(
  frame: CameraFrame,
  x: number,
  y: number,
  z = 0,
): { x: number; y: number } | null {
  const [cx, cy, , cw] = transformPoint(frame.viewProj, x, y, z);
  if (cw <= 1e-9) return null;
  return { x: cx / cw, y: cy / cw };
}

/** Pixel position (origin top-left) → NDC. */
export function pixelToNdc(
  frame: CameraFrame,
  px: number,
  py: number,
): [number, number] {
  return [(px / frame.viewW) * 2 - 1, 1 - (py / frame.viewH) * 2];
}

/** NDC → pixel position (origin top-left). */
export function ndcToPixel(
  frame: CameraFrame,
  nx: number,
  ny: number,
): { x: number; y: number } {
  return {
    x: ((nx + 1) / 2) * frame.viewW,
    y: ((1 - ny) / 2) * frame.viewH,
  };
}

/** The ray through an NDC point (direction not normalized). */
export function ndcToRay(frame: CameraFrame, nx: number, ny: number): Ray {
  if (!frame.perspective) {
    // Parallel rays along the view direction, starting behind the screen
    // point (top-down: straight down from 1e6 above it).
    const sx = (nx * frame.viewW) / (2 * frame.zoom);
    const sy = (ny * frame.viewH) / (2 * frame.zoom);
    const { right: R, up: U, forward: F, eye: E } = frame;
    const back = F[2] === -1 ? E[2] : ORTHO_EYE_DIST;
    return {
      origin: [
        frame.centerX + R[0] * sx + U[0] * sy - F[0] * back,
        frame.centerY + R[1] * sx + U[1] * sy - F[1] * back,
        R[2] * sx + U[2] * sy - F[2] * back,
      ],
      dir: [F[0], F[1], F[2]],
    };
  }
  const sx = (nx * frame.aspect) / frame.focal;
  const sy = ny / frame.focal;
  const { right: R, up: U, forward: F } = frame;
  return {
    origin: [frame.eye[0], frame.eye[1], frame.eye[2]],
    dir: [
      F[0] + R[0] * sx + U[0] * sy,
      F[1] + R[1] * sx + U[1] * sy,
      F[2] + R[2] * sx + U[2] * sy,
    ],
  };
}

/** Where a ray crosses the horizontal plane at height z (null if never, or behind). */
export function intersectRayPlane(
  ray: Ray,
  z = 0,
): { x: number; y: number; t: number } | null {
  const dz = ray.dir[2];
  if (Math.abs(dz) < 1e-12) return null;
  const t = (z - ray.origin[2]) / dz;
  if (t < 0) return null;
  return {
    x: ray.origin[0] + ray.dir[0] * t,
    y: ray.origin[1] + ray.dir[1] * t,
    t,
  };
}

/** World point on the ground plane (z = 0) under a pixel, or null above the horizon. */
export function pixelToGround(
  frame: CameraFrame,
  px: number,
  py: number,
): { x: number; y: number } | null {
  const [nx, ny] = pixelToNdc(frame, px, py);
  const hit = intersectRayPlane(ndcToRay(frame, nx, ny), 0);
  return hit === null ? null : { x: hit.x, y: hit.y };
}

/** Pixel position of a world point, or null when it is behind the camera. */
export function worldToPixel(
  frame: CameraFrame,
  x: number,
  y: number,
  z = 0,
): { x: number; y: number } | null {
  const ndc = projectToNdc(frame, x, y, z);
  return ndc === null ? null : ndcToPixel(frame, ndc.x, ndc.y);
}
