import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import type {
  CataclysmUpdate,
  HordeUpdate,
  ProtectedStateUpdate,
  RisingTideUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import {
  VOLCANO_ERUPTION_RADIUS,
  VOLCANO_WARNING_RADIUS,
} from "@openfront/engine-lib/game/Volcanoes";
import { TELEGRAPH_ENEMY } from "../render/frame/derive/NukeTelegraphs";
import type { DeadUnitFx, NukeTelegraphData } from "../render/types";

/**
 * The client's copy of the volcano, rising tide, Horde Night and Protected
 * State state, folded from GameUpdateType.Cataclysm updates (each one carries
 * the whole state of its kind). Empty while those modes are off.
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
  /** The latest Horde Night state; null while the mode is off. */
  horde: HordeUpdate | null = null;
  /** The latest Protected State state; null while the mode is off. */
  protectedState: ProtectedStateUpdate | null = null;

  apply(updates: readonly CataclysmUpdate[] | undefined): void {
    this.eruptedSites = [];
    for (const u of updates ?? []) {
      if (u.kind === "volcano") {
        this.volcanoSites = u.sites;
        this.rumblingSite = u.rumblingSite;
        this.eruptionTick = u.eruptionTick;
        if (u.eruptedSite !== null) this.eruptedSites.push(u.eruptedSite);
        this.volcanoVersion++;
      } else if (u.kind === "tide") {
        this.tide = u;
        this.tideVersion++;
      } else if (u.kind === "horde") {
        this.horde = u;
      } else {
        this.protectedState = u;
      }
    }
  }

  /** The Protected State's smallID, or 0 when there is none. */
  protectedStateID(): number {
    return this.protectedState?.state ?? 0;
  }

  /** The Protected State's patrons' smallIDs, strongest first. */
  patronIDs(): readonly number[] {
    const u = this.protectedState;
    return u === null || u.state === 0 ? [] : u.patrons;
  }

  /** A defending human's land when the first Horde Night wave landed. */
  hordeStartTiles(smallID: number): number | null {
    const land = this.horde?.startLand ?? [];
    for (let i = 0; i + 1 < land.length; i += 2) {
      if (land[i] === smallID) return land[i + 1];
    }
    return null;
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
