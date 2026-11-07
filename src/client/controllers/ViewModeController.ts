/**
 * ViewModeController — forwards map view-mode toggles to the WebGL view.
 *
 * - AlternateViewEvent: space-hold (and the settings-modal toggle) drives the
 *   affiliation recolor + grid overlay + hides names and land map layers.
 * - ToggleCoordinateGridEvent: persistent coordinate-grid toggle (M keybind);
 *   grid shows but names stay visible.
 * - OrbitViewEvent / ResetViewEvent: the isometric camera's free orbit
 *   (Shift+Q / Shift+E turn, PageUp / PageDown tilt, Alt+drag both, V
 *   resets).
 */

import { EventBus } from "@openfront/shared/EventBus";
import { Controller } from "../Controller";
import {
  AlternateViewEvent,
  OrbitViewEvent,
  ResetViewEvent,
  ToggleCoordinateGridEvent,
} from "../InputHandler";
import { MapRenderer } from "../render/gl";

export class ViewModeController implements Controller {
  constructor(
    private eventBus: EventBus,
    private view: MapRenderer,
  ) {}

  init() {
    this.eventBus.on(AlternateViewEvent, (e) =>
      this.view.setAltView(e.alternateView),
    );
    this.eventBus.on(ToggleCoordinateGridEvent, (e) =>
      this.view.setGridView(e.enabled),
    );
    this.eventBus.on(OrbitViewEvent, (e) =>
      this.view.orbitView(e.yawDeg, e.elevationDeg),
    );
    this.eventBus.on(ResetViewEvent, () => this.view.resetView());
  }
}
