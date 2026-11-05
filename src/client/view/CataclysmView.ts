import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import type {
  CataclysmUpdate,
  RisingTideUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import {
  VOLCANO_ERUPTION_RADIUS,
  VOLCANO_WARNING_RADIUS,
} from "@openfront/engine-lib/game/Volcanoes";
import { TELEGRAPH_ENEMY } from "../render/frame/derive/NukeTelegraphs";
import type { DeadUnitFx, NukeTelegraphData } from "../render/types";

/**
 * The client's copy of the volcano and rising tide state, folded from
 * GameUpdateType.Cataclysm updates (each one carries the whole state of its
 * kind). Empty while both modes are off.
 */
export class CataclysmView {
  volcanoSites: readonly TileRef[] = [];
  /** The site rumbling now, or null. */
  rumblingSite: TileRef | null = null;
  /** Tick the rumbling site erupts. */
  eruptionTick = 0;
  /** Sites that erupted on the last applied tick. */
  eruptedSites: TileRef[] = [];
  /** Bumped whenever the volcano state changes. */
  volcanoVersion = 0;
  /** The latest rising tide state; null while the mode is off. */
  tide: RisingTideUpdate | null = null;
  /** Bumped whenever the tide state changes. */
  tideVersion = 0;

  apply(updates: readonly CataclysmUpdate[] | undefined): void {
    this.eruptedSites = [];
    for (const u of updates ?? []) {
      if (u.kind === "volcano") {
        this.volcanoSites = u.sites;
        this.rumblingSite = u.rumblingSite;
        this.eruptionTick = u.eruptionTick;
        if (u.eruptedSite !== null) this.eruptedSites.push(u.eruptedSite);
        this.volcanoVersion++;
      } else {
        this.tide = u;
        this.tideVersion++;
      }
    }
  }
}

/**
 * The rumbling site's warning, drawn by the nuke telegraph pass: the eruption
 * radius filled, the warning radius as the pulsing dashed ring, in the
 * hostile color for everyone.
 */
export function volcanoTelegraphs(
  view: CataclysmView,
  mapW: number,
): NukeTelegraphData[] {
  const site = view.rumblingSite;
  if (site === null) return [];
  return [
    {
      x: site % mapW,
      y: (site - (site % mapW)) / mapW,
      innerRadius: VOLCANO_ERUPTION_RADIUS,
      outerRadius: VOLCANO_WARNING_RADIUS,
      relation: TELEGRAPH_ENEMY,
    },
  ];
}

/**
 * Eruptions as explosion events for the FX pass, which plays the atom bomb's
 * blast and shockwave at the site. Owner 0 has no cosmetic, so the default.
 */
export function eruptionFx(view: CataclysmView): DeadUnitFx[] {
  return view.eruptedSites.map((pos) => ({
    unitType: UnitType.AtomBomb,
    pos,
    reachedTarget: true,
    ownerSmallID: 0,
  }));
}
