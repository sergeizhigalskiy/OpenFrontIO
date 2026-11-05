import { Structures } from "@openfront/engine-api/game/GameTypes";
import { Game, Player } from "../../game/Game";
import { DeleteUnitExecution } from "../DeleteUnitExecution";

/**
 * What the hostile bots of Horde Night (horde bands) and the plague (The
 * Infected) share: they never ally, and they raze what they capture, the way
 * tribes do (TribeExecution.deleteNextStructure).
 */

/** Turns down every alliance request: hostile factions never ally. */
export function refuseAllianceRequests(player: Player): void {
  for (const request of player.incomingAllianceRequests()) {
    request.reject();
  }
}

/** Razes one captured structure, as tribes do. */
export function razeNextStructure(game: Game, player: Player): void {
  if (!player.canDeleteUnit()) return;
  for (const unit of player.units()) {
    if (!Structures.has(unit.type())) continue;
    if (unit.isMarkedForDeletion()) continue;
    game.addExecution(new DeleteUnitExecution(player, unit.id()));
    return;
  }
}
