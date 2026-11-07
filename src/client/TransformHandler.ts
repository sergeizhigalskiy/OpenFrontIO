import { Cell } from "@openfront/engine-api/game/GameTypes";
import { EventBus, GameEvent } from "@openfront/shared/EventBus";
import {
  CenterCameraEvent,
  DragEvent,
  ZOOM_DELTA_DIVISOR,
  ZoomEvent,
} from "./InputHandler";
import {
  computeCameraFrame,
  createCameraFrame,
  ndcToRay,
  pixelToNdc,
  worldToPixel,
  type CameraFrame,
} from "./render/gl/camera/CameraMath";
import {
  hasRelief,
  pickGround,
  viewPose,
  type MapViewSource,
} from "./render/gl/camera/MapViewSource";
import { GameView, PlayerView, UnitView } from "./view";

export class GoToPlayerEvent implements GameEvent {
  constructor(
    public player: PlayerView,
    public zoom?: number,
  ) {}
}

export class GoToPositionEvent implements GameEvent {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

export class GoToUnitEvent implements GameEvent {
  constructor(public unit: UnitView) {}
}

export const GOTO_INTERVAL_MS = 16;
export const CAMERA_MAX_SPEED = 15;
export const CAMERA_SMOOTHING = 0.03;

export class TransformHandler {
  public scale: number = 1.8;
  private _boundingRect: DOMRect;
  public offsetX: number = -350;
  public offsetY: number = -200;
  private lastGoToCallTime: number | null = null;

  private target: Cell | null;
  private targetScale: number | null = null;
  private intervalID: NodeJS.Timeout | null = null;
  private changed = false;
  /**
   * The renderer's view mode, isometric turn and terrain heights. Null or a
   * flat view keeps the classic 2D math; a tilted or isometric view picks
   * through the same camera frame the renderer draws with (viewPose in
   * render/gl/camera/MapViewSource.ts).
   */
  private mapView: MapViewSource | null = null;
  private frameScratch: CameraFrame = createCameraFrame();

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private canvas: HTMLElement,
  ) {
    this._boundingRect = this.canvas.getBoundingClientRect();
    this.eventBus.on(ZoomEvent, (e) => this.onZoom(e));
    this.eventBus.on(DragEvent, (e) => this.onMove(e));
    this.eventBus.on(GoToPlayerEvent, (e) => this.onGoToPlayer(e));
    this.eventBus.on(GoToPositionEvent, (e) => this.onGoToPosition(e));
    this.eventBus.on(GoToUnitEvent, (e) => this.onGoToUnit(e));
    this.eventBus.on(CenterCameraEvent, () => this.centerCamera());
  }

  /**
   * Connect the renderer's view mode (tilt / 3D / isometric) for picking,
   * zoom and pan.
   */
  setMapView(source: MapViewSource | null): void {
    this.mapView = source;
    this.changed = true;
  }

  /**
   * World point at the screen centre, which is the camera's focus. Matches
   * the centre ClientGameRunner pushes to the renderer each frame.
   */
  focusPoint(): { x: number; y: number } {
    const { width, height } = this.boundingRect();
    return {
      x:
        this.offsetX +
        this.game.width() / 2 +
        (width - this.game.width()) / (2 * this.scale),
      y:
        this.offsetY +
        this.game.height() / 2 +
        (height - this.game.height()) / (2 * this.scale),
    };
  }

  /**
   * The camera frame for the current state (tilted, 3D or isometric), or
   * null in the flat view.
   */
  private tiltedFrame(): CameraFrame | null {
    const source = this.mapView;
    const view = source?.view();
    if (source === null || view === undefined || view.mode === "flat") {
      return null;
    }
    const { width, height } = this.boundingRect();
    const focus = this.focusPoint();
    return computeCameraFrame(
      viewPose(
        view,
        source.orbit(),
        focus.x,
        focus.y,
        this.scale,
        width,
        height,
      ),
      this.frameScratch,
    );
  }

  /**
   * Ground point under a canvas pixel through a tilted frame: on the drawn
   * terrain when `terrain` is set and the view has relief, else on z = 0.
   */
  private canvasToGround(
    frame: CameraFrame,
    canvasX: number,
    canvasY: number,
    terrain: boolean,
  ): { x: number; y: number } | null {
    const [nx, ny] = pixelToNdc(frame, canvasX, canvasY);
    const ray = ndcToRay(frame, nx, ny);
    const mode = this.mapView?.view().mode;
    const relief = terrain && mode !== undefined && hasRelief(mode);
    return pickGround(ray, relief ? this.mapView : null);
  }

  public updateCanvasBoundingRect() {
    this._boundingRect = this.canvas.getBoundingClientRect();
  }

  boundingRect(): DOMRect {
    return this._boundingRect;
  }

  width(): number {
    return this.boundingRect().width;
  }
  hasChanged(): boolean {
    return this.changed;
  }
  resetChanged() {
    this.changed = false;
  }

  handleTransform(context: CanvasRenderingContext2D) {
    // Disable image smoothing for pixelated effect
    context.imageSmoothingEnabled = false;

    // Apply zoom and pan
    context.setTransform(
      this.scale,
      0,
      0,
      this.scale,
      this.game.width() / 2 - this.offsetX * this.scale,
      this.game.height() / 2 - this.offsetY * this.scale,
    );
  }

  worldToCanvasCoordinates(cell: Cell): { x: number; y: number } {
    const frame = this.tiltedFrame();
    if (frame !== null) {
      const mode = this.mapView?.view().mode;
      const z =
        mode !== undefined && hasRelief(mode)
          ? (this.mapView?.heightAt(cell.x, cell.y) ?? 0)
          : 0;
      const p = worldToPixel(frame, cell.x, cell.y, z);
      if (p !== null) return p;
    }
    // Step 1: Convert from Cell coordinates to game coordinates
    // (reverse of Math.floor operation - we'll use the exact values)
    const gameX = cell.x;
    const gameY = cell.y;

    // Step 2: Reverse the game center offset calculation
    // Original: gameX = centerX + this.game.width() / 2
    // Therefore: centerX = gameX - this.game.width() / 2
    const centerX = gameX - this.game.width() / 2;
    const centerY = gameY - this.game.height() / 2;

    // Step 3: Reverse the world point calculation
    // Original: centerX = (canvasX - this.game.width() / 2) / this.scale + this.offsetX
    // Therefore: canvasX = (centerX - this.offsetX) * this.scale + this.game.width() / 2
    const canvasX =
      (centerX - this.offsetX) * this.scale + this.game.width() / 2;
    const canvasY =
      (centerY - this.offsetY) * this.scale + this.game.height() / 2;

    return { x: canvasX, y: canvasY };
  }

  worldToScreenCoordinates(cell: Cell): { x: number; y: number } {
    // Step 1-3: Convert world coordinates to canvas coordinates in worldToCanvasCoordinates
    // Step 4 only where needed: Convert canvas coordinates back to screen coordinates
    const canvasCoords = this.worldToCanvasCoordinates(cell);
    return this.canvasToScreenCoordinates(canvasCoords.x, canvasCoords.y);
  }

  screenToWorldCoordinates(screenX: number, screenY: number): Cell {
    const f = this.screenToWorldCoordinatesFloat(screenX, screenY);
    return new Cell(Math.floor(f.x), Math.floor(f.y));
  }

  /** Like screenToWorldCoordinates but returns sub-tile precision. */
  screenToWorldCoordinatesFloat(
    screenX: number,
    screenY: number,
  ): { x: number; y: number } {
    const canvasCoords = this.screenToCanvasCoordinates(screenX, screenY);
    const frame = this.tiltedFrame();
    if (frame !== null) {
      const hit = this.canvasToGround(
        frame,
        canvasCoords.x,
        canvasCoords.y,
        true,
      );
      if (hit !== null) return hit;
    }
    const gameX =
      (canvasCoords.x - this.game.width() / 2) / this.scale +
      this.offsetX +
      this.game.width() / 2;
    const gameY =
      (canvasCoords.y - this.game.height() / 2) / this.scale +
      this.offsetY +
      this.game.height() / 2;
    return { x: gameX, y: gameY };
  }

  canvasToScreenCoordinates(
    canvasX: number,
    canvasY: number,
  ): { x: number; y: number } {
    const canvasRect = this.boundingRect();
    return {
      x: canvasX + canvasRect.left,
      y: canvasY + canvasRect.top,
    };
  }

  screenToCanvasCoordinates(
    screenX: number,
    screenY: number,
  ): { x: number; y: number } {
    const canvasRect = this.boundingRect();
    return { x: screenX - canvasRect.left, y: screenY - canvasRect.top };
  }

  screenBoundingRect(): [Cell, Cell] {
    const canvasRect = this.boundingRect();
    const canvasWidth = canvasRect.width;
    const canvasHeight = canvasRect.height;

    const frame = this.tiltedFrame();
    if (frame !== null) {
      // Bounding box of the visible ground (a trapezoid when tilted).
      const corners = [
        this.canvasToGround(frame, 0, 0, false),
        this.canvasToGround(frame, canvasWidth, 0, false),
        this.canvasToGround(frame, 0, canvasHeight, false),
        this.canvasToGround(frame, canvasWidth, canvasHeight, false),
      ];
      const xs: number[] = [];
      const ys: number[] = [];
      for (const c of corners) {
        if (c === null) break;
        xs.push(c.x);
        ys.push(c.y);
      }
      if (xs.length === 4) {
        return [
          new Cell(Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys))),
          new Cell(Math.floor(Math.max(...xs)), Math.floor(Math.max(...ys))),
        ];
      }
    }

    const LeftX = -this.game.width() / 2 / this.scale + this.offsetX;
    const TopY = -this.game.height() / 2 / this.scale + this.offsetY;

    const gameLeftX = LeftX + this.game.width() / 2;
    const gameTopY = TopY + this.game.height() / 2;

    const rightX =
      (canvasWidth - this.game.width() / 2) / this.scale + this.offsetX;
    const bottomY =
      (canvasHeight - this.game.height() / 2) / this.scale + this.offsetY;

    const gameRightX = rightX + this.game.width() / 2;
    const gameBottomY = bottomY + this.game.height() / 2;

    return [
      new Cell(Math.floor(gameLeftX), Math.floor(gameTopY)),
      new Cell(Math.floor(gameRightX), Math.floor(gameBottomY)),
    ];
  }

  isOnScreen(cell: Cell): boolean {
    if (this.tiltedFrame() !== null) {
      const p = this.worldToCanvasCoordinates(cell);
      const { width, height } = this.boundingRect();
      return p.x > 0 && p.x < width && p.y > 0 && p.y < height;
    }
    const [topLeft, bottomRight] = this.screenBoundingRect();
    return (
      cell.x > topLeft.x &&
      cell.x < bottomRight.x &&
      cell.y > topLeft.y &&
      cell.y < bottomRight.y
    );
  }

  screenCenter(): { screenX: number; screenY: number } {
    if (this.tiltedFrame() !== null) {
      // A tilted or turned view's ground bounding box is lopsided; its true
      // centre is the camera focus.
      const focus = this.focusPoint();
      return { screenX: Math.floor(focus.x), screenY: Math.floor(focus.y) };
    }
    const [upperLeft, bottomRight] = this.screenBoundingRect();
    return {
      screenX: upperLeft.x + Math.floor((bottomRight.x - upperLeft.x) / 2),
      screenY: upperLeft.y + Math.floor((bottomRight.y - upperLeft.y) / 2),
    };
  }

  /**
   * The camera focus (on the z = 0 plane, what focusPoint reports) that puts
   * the ground at (x, y) in the middle of the screen. In the flat view it is
   * (x, y); over relief the ground stands `h` tiles up, so the focus sits
   * where the view ray through that raised point meets z = 0, at any orbit.
   */
  groundFocus(x: number, y: number): { x: number; y: number } {
    const mode = this.mapView?.view().mode;
    const frame = this.tiltedFrame();
    if (frame === null || mode === undefined || !hasRelief(mode)) {
      return { x, y };
    }
    const h = this.mapView?.heightAt(x, y) ?? 0;
    const F = frame.forward;
    if (h === 0 || F[2] >= -1e-6) return { x, y };
    const s = h / F[2];
    return { x: x - s * F[0], y: y - s * F[1] };
  }

  private goToGround(x: number, y: number): void {
    const f = this.groundFocus(x, y);
    this.target = new Cell(f.x, f.y);
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  onGoToPlayer(event: GoToPlayerEvent) {
    this.clearTarget();
    const nameLocation = event.player.nameLocation();
    if (!nameLocation) {
      return;
    }
    this.targetScale = event.zoom ?? null;
    this.goToGround(nameLocation.x, nameLocation.y);
  }

  onGoToPosition(event: GoToPositionEvent) {
    this.clearTarget();
    this.goToGround(event.x, event.y);
  }

  onGoToUnit(event: GoToUnitEvent) {
    this.clearTarget();
    this.goToGround(
      this.game.x(event.unit.lastTile()),
      this.game.y(event.unit.lastTile()),
    );
  }

  centerCamera() {
    this.clearTarget();
    const player = this.game.myPlayer();
    const nameLocation = player?.nameLocation();
    if (!nameLocation) return;
    this.goToGround(nameLocation.x, nameLocation.y);
  }

  private goTo() {
    const { screenX, screenY } = this.screenCenter();

    if (this.target === null) {
      throw new Error("null target");
    }
    const positionClose =
      Math.abs(this.target.x - screenX) + Math.abs(this.target.y - screenY) < 2;
    const scaleClose =
      this.targetScale === null ||
      Math.abs(this.scale - this.targetScale) < 0.01;
    if (positionClose && scaleClose) {
      this.clearTarget();
      return;
    }

    let dt: number;
    const now = window.performance.now();
    if (this.lastGoToCallTime === null) {
      dt = GOTO_INTERVAL_MS;
    } else {
      dt = now - this.lastGoToCallTime;
    }
    this.lastGoToCallTime = now;

    const r = 1 - Math.pow(CAMERA_SMOOTHING, dt / 1000);

    this.offsetX += Math.max(
      Math.min((this.target.x - screenX) * r, CAMERA_MAX_SPEED),
      -CAMERA_MAX_SPEED,
    );
    this.offsetY += Math.max(
      Math.min((this.target.y - screenY) * r, CAMERA_MAX_SPEED),
      -CAMERA_MAX_SPEED,
    );

    if (this.targetScale !== null) {
      const oldScale = this.scale;
      const zoomSmoothing = 0.7;
      const zoomR = 1 - Math.pow(zoomSmoothing, dt / 1000);
      const diff = this.targetScale - this.scale;
      const smoothStep = diff * zoomR;
      const minStep =
        Math.sign(diff) * Math.min(Math.abs(diff), (6.0 * dt) / 1000);
      this.scale +=
        Math.abs(smoothStep) >= Math.abs(minStep) ? smoothStep : minStep;
      // Keep screen center pinned as scale changes: (canvasSize - mapSize) / (2 * scale)
      // shifts the apparent center when canvas != map dimensions (always on mobile).
      const { width: canvasWidth, height: canvasHeight } = this.boundingRect();
      this.offsetX +=
        (canvasWidth - this.game.width()) *
        (1 / (2 * oldScale) - 1 / (2 * this.scale));
      this.offsetY +=
        (canvasHeight - this.game.height()) *
        (1 / (2 * oldScale) - 1 / (2 * this.scale));
    }

    this.changed = true;
  }

  onZoom(event: ZoomEvent) {
    this.clearTarget();
    const oldScale = this.scale;
    const zoomFactor = 1 + event.delta / ZOOM_DELTA_DIVISOR;
    const canvasCoords = this.screenToCanvasCoordinates(event.x, event.y);
    const before = this.tiltedFrame();
    const pivot =
      before === null
        ? null
        : this.canvasToGround(before, canvasCoords.x, canvasCoords.y, true);
    this.scale /= zoomFactor;

    // Clamp the scale to prevent extreme zooming
    this.scale = Math.max(0.2, Math.min(20, this.scale));

    if (pivot !== null) {
      // Tilted: keep the ground point under the cursor fixed. The view is
      // translation-invariant, so shifting by the miss is exact on flat
      // ground and close on 3D terrain.
      const after = this.tiltedFrame();
      const moved =
        after === null
          ? null
          : this.canvasToGround(after, canvasCoords.x, canvasCoords.y, true);
      if (moved !== null) {
        this.offsetX += pivot.x - moved.x;
        this.offsetY += pivot.y - moved.y;
        this.clampOffsets();
        this.changed = true;
        return;
      }
    }

    // Calculate the world point we want to zoom towards
    const zoomPointX =
      (canvasCoords.x - this.game.width() / 2) / oldScale + this.offsetX;
    const zoomPointY =
      (canvasCoords.y - this.game.height() / 2) / oldScale + this.offsetY;

    // Adjust the offset
    this.offsetX =
      zoomPointX - (canvasCoords.x - this.game.width() / 2) / this.scale;
    this.offsetY =
      zoomPointY - (canvasCoords.y - this.game.height() / 2) / this.scale;
    this.clampOffsets();
    this.changed = true;
  }

  private clampOffsets() {
    const canvasRect = this.boundingRect();
    const canvasWidth = canvasRect.width;
    const canvasHeight = canvasRect.height;
    const gameWidth = this.game.width();
    const gameH = this.game.height();
    const scale = this.scale;

    // Allow panning so that up to half of the viewport can be outside the map on each side.
    // This lets a map corner be placed at the screen center, but no further.
    // Derivation (X axis):
    //   gameLeftX = -gameWidth/(2*scale) + offsetX + gameWidth/2 >= -vw/2
    //   gameRightX = (canvasWidth - gameWidth/2)/scale + offsetX + gameWidth/2 <= gameWidth + vw/2
    // Solving gives:
    //   minOffsetX = -gameWidth/2 + (gameWidth - canvasWidth) / (2*scale)
    //   maxOffsetX =  gameWidth/2 + (gameWidth - canvasWidth) / (2*scale)
    const minOffsetX = -gameWidth / 2 + (gameWidth - canvasWidth) / (2 * scale);
    const maxOffsetX = gameWidth / 2 + (gameWidth - canvasWidth) / (2 * scale);

    const minOffsetY = -gameH / 2 + (gameH - canvasHeight) / (2 * scale);
    const maxOffsetY = gameH / 2 + (gameH - canvasHeight) / (2 * scale);

    // Clamp offsets within computed bounds on each axis
    if (this.offsetX < minOffsetX) {
      this.offsetX = minOffsetX;
    } else if (this.offsetX > maxOffsetX) {
      this.offsetX = maxOffsetX;
    }

    if (this.offsetY < minOffsetY) {
      this.offsetY = minOffsetY;
    } else if (this.offsetY > maxOffsetY) {
      this.offsetY = maxOffsetY;
    }
  }

  onMove(event: DragEvent) {
    this.clearTarget();
    const frame = this.tiltedFrame();
    if (frame !== null) {
      // Tilted: drag the ground at the screen centre by the cursor's motion
      // (a pixel covers more ground toward the horizon than toward you).
      const { width, height } = this.boundingRect();
      const cx = width / 2;
      const cy = height / 2;
      const from = this.canvasToGround(frame, cx, cy, false);
      const to = this.canvasToGround(
        frame,
        cx + event.deltaX,
        cy + event.deltaY,
        false,
      );
      if (from !== null && to !== null) {
        this.offsetX -= to.x - from.x;
        this.offsetY -= to.y - from.y;
        this.clampOffsets();
        this.changed = true;
        return;
      }
    }
    this.offsetX -= event.deltaX / this.scale;
    this.offsetY -= event.deltaY / this.scale;
    this.clampOffsets();
    this.changed = true;
  }

  private clearTarget() {
    if (this.intervalID !== null) {
      clearInterval(this.intervalID);
      this.intervalID = null;
    }
    this.target = null;
    this.targetScale = null;
  }

  override(x: number = 0, y: number = 0, s: number = 1) {
    //hardset view position
    this.clearTarget();
    this.offsetX = x;
    this.offsetY = y;
    this.scale = s;
    this.changed = true;
  }

  centerAll(fit: number = 1) {
    //position entire map centered on the screen

    const vpWidth = this.boundingRect().width;
    const vpHeight = this.boundingRect().height;
    const mapWidth = this.game.width();
    const mapHeight = this.game.height();

    const scHor = (vpWidth / mapWidth) * fit;
    const scVer = (vpHeight / mapHeight) * fit;
    const tScale = Math.min(scHor, scVer);

    const oHor = (mapWidth - vpWidth) / 2 / tScale;
    const oVer = (mapHeight - vpHeight) / 2 / tScale;

    this.override(oHor, oVer, tScale);
  }
}
