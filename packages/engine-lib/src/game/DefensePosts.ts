/**
 * Defense post coverage of an attacked tile.
 *
 * Shared by the engine (attack resolution) and the client (the attack
 * forecast, the coverage overlay, the build menu), so the range lives here.
 *
 * A defense post has one level, as upstream: it covers every tile within
 * DEFENSE_POST_RANGE, where attackers lose more troops and move slower
 * (Config.defensePostDefenseBonus and defensePostSpeedBonus).
 */
import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { UnitLike } from "@openfront/engine-api/game/ReadViews";

/** Tiles (euclidean) a defense post covers. */
export const DEFENSE_POST_RANGE = 30;

/** What the coverage check needs from the unit grid (UnitGrid.someUnitNearby). */
export interface DefenseUnitQuery {
  someUnitNearby<C>(
    tile: TileRef,
    searchRange: number,
    type: UnitType,
    ctx: C,
    visit: (unit: UnitLike, distSquared: number, ctx: C) => boolean,
  ): boolean;
}

function ownedBy(
  post: UnitLike,
  _distSquared: number,
  defenderSmallID: number,
): boolean {
  return post.owner().smallID() === defenderSmallID;
}

/**
 * Whether one of the defender's built defense posts is within
 * DEFENSE_POST_RANGE of `tile`: upstream's hasUnitNearby check, without
 * building a result array (this runs for every tile of every attack).
 */
export function defensePostCovers(
  query: DefenseUnitQuery,
  tile: TileRef,
  defenderSmallID: number,
): boolean {
  return query.someUnitNearby(
    tile,
    DEFENSE_POST_RANGE,
    UnitType.DefensePost,
    defenderSmallID,
    ownedBy,
  );
}
