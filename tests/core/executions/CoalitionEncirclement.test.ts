import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { beforeEach, describe, expect, test } from "vitest";
import { setup } from "../../util/Setup";

// Encirclement of a whole player is upstream's rule: its main body is
// annexed only when one single enemy rings it. A ring of several enemies,
// even allies of each other, annexes nothing.

type ClusterPass = { removeClusters(): void };

function runClusterPass(game: Game, player: Player) {
  const exec = new PlayerExecution(player);
  exec.init(game, 0);
  (exec as unknown as ClusterPass).removeClusters();
}

let game: Game;
let victim: Player;
let west: Player;
let east: Player;

/**
 * Victim holds a 5x5 block at (60..64, 60..64). West holds the ring's left half
 * (x <= 62) and East its right half, so neither encloses it alone, unless
 * `single` hands the whole ring to West.
 */
function buildRing(single = false) {
  for (let x = 57; x <= 67; x++) {
    for (let y = 57; y <= 67; y++) {
      const inside = x >= 60 && x <= 64 && y >= 60 && y <= 64;
      const owner = inside ? victim : single || x <= 62 ? west : east;
      owner.conquer(game.ref(x, y));
    }
  }
}

describe("encirclement of a whole player", () => {
  beforeEach(async () => {
    game = await setup("big_plains", {}, [
      new PlayerInfo("victim", PlayerType.Human, "c1", "victim_id"),
      new PlayerInfo("west", PlayerType.Human, "c2", "west_id"),
      new PlayerInfo("east", PlayerType.Human, "c3", "east_id"),
    ]);
    victim = game.player("victim_id");
    west = game.player("west_id");
    east = game.player("east_id");
  });

  test("one enemy ringing a player annexes it", () => {
    buildRing(true);
    expect(victim.numTilesOwned()).toBe(25);

    runClusterPass(game, victim);

    expect(victim.numTilesOwned()).toBe(0);
    expect(west.numTilesOwned()).toBe(121);
  });

  test("allies ringing a player together don't annex it", () => {
    west.createAllianceRequest(east)!.accept();
    buildRing();
    runClusterPass(game, victim);
    expect(victim.numTilesOwned()).toBe(25);
  });

  test("a ring of players who aren't allied doesn't annex", () => {
    buildRing();
    runClusterPass(game, victim);
    expect(victim.numTilesOwned()).toBe(25);
  });
});
