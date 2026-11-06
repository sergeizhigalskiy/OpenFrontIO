import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  POCKET_ANNEX_MIN_TILES,
  POCKET_ANNEX_PERCENT,
  PlayerExecution,
  pocketAnnexLimit,
} from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { beforeEach, describe, expect, test } from "vitest";
import { conquerRect } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

// A cut-off pocket is annexed only if it holds at most 150 tiles or 5% of
// its owner's land, whichever is bigger. A bigger piece stays with its owner
// and has to be fought for.

type ClusterPass = { removeClusters(): void };

function runClusterPass(game: Game, player: Player) {
  const exec = new PlayerExecution(player);
  exec.init(game, 0);
  (exec as unknown as ClusterPass).removeClusters();
}

let game: Game;
let owner: Player;
let ringer: Player;

/**
 * The owner's main body is the left `bodyWidth` columns of the map (it
 * touches the map edge, so it is never annexed). The ringer holds a block at
 * (100..150, 100..150), with a pocket of the owner's `size` tiles inside it,
 * filled row by row 25 tiles wide from (110, 110).
 */
function pocketOf(size: number, bodyWidth: number): number {
  conquerRect(game, owner, 0, 0, bodyWidth, 200);
  conquerRect(game, ringer, 100, 100, 151, 151);
  for (let i = 0; i < size; i++) {
    owner.conquer(game.ref(110 + (i % 25), 110 + Math.floor(i / 25)));
  }
  return game.ref(110, 110);
}

describe("pocket annexation", () => {
  beforeEach(async () => {
    game = await setup("big_plains", {}, [
      new PlayerInfo("owner", PlayerType.Human, "c1", "owner_id"),
      new PlayerInfo("ringer", PlayerType.Human, "c2", "ringer_id"),
    ]);
    owner = game.player("owner_id");
    ringer = game.player("ringer_id");
  });

  test("the limit is 150 tiles or 5% of the owner's land, whichever is bigger", () => {
    expect(POCKET_ANNEX_MIN_TILES).toBe(150);
    expect(POCKET_ANNEX_PERCENT).toBe(5);
    expect(pocketAnnexLimit(1_000)).toBe(150);
    expect(pocketAnnexLimit(3_000)).toBe(150);
    expect(pocketAnnexLimit(12_800)).toBe(640);
    // The measured cut: a 5,829-tile pocket of a 12,800-tile nation stays.
    expect(5_829).toBeGreaterThan(pocketAnnexLimit(12_800));
  });

  test("a 150-tile pocket of a small player is annexed", () => {
    const pocket = pocketOf(150, 5);
    expect(owner.numTilesOwned()).toBe(1_150);
    runClusterPass(game, owner);
    expect(game.owner(pocket)).toBe(ringer);
    expect(owner.numTilesOwned()).toBe(1_000);
  });

  test("a 151-tile pocket of a small player stays", () => {
    const pocket = pocketOf(151, 5);
    runClusterPass(game, owner);
    expect(game.owner(pocket)).toBe(owner);
    expect(owner.numTilesOwned()).toBe(1_151);
  });

  test("a big player's pocket of up to 5% of its land is annexed", () => {
    // 12,000 + 631 tiles: 5% is 631.55, so 631 tiles may go.
    const pocket = pocketOf(631, 60);
    expect(pocketAnnexLimit(owner.numTilesOwned())).toBe(631);
    runClusterPass(game, owner);
    expect(game.owner(pocket)).toBe(ringer);
  });

  test("a big player's pocket of more than 5% of its land stays", () => {
    const pocket = pocketOf(632, 60);
    expect(pocketAnnexLimit(owner.numTilesOwned())).toBe(631);
    runClusterPass(game, owner);
    expect(game.owner(pocket)).toBe(owner);
    expect(owner.numTilesOwned()).toBe(12_632);
  });

  test("an arm a nuke cuts off stays when it is too big a pocket", () => {
    // A 71x81 main body on the map edge and an arm east to x = 170; a crater
    // at (100, 100) cuts off the arm's last 533 tiles, more than 5% of the
    // owner's land (NukeSeveredAnnexation.test.ts, with the cap lifted, has
    // them annexed).
    game.map().forEachTile((t) => {
      const x = game.x(t);
      const y = game.y(t);
      const body = x <= 70 && y >= 60 && y <= 140;
      const arm = x >= 70 && x <= 170 && y >= 94 && y <= 106;
      (body || arm ? owner : ringer).conquer(t);
    });
    game.addExecution(new PlayerExecution(owner));
    game.addExecution(new PlayerExecution(ringer));
    executeTicks(game, 25);
    game.map().forEachTile((t) => {
      const dx = game.x(t) - 100;
      const dy = game.y(t) - 100;
      if (dx * dx + dy * dy > 144) return;
      const o = game.owner(t);
      if (o.isPlayer()) o.relinquish(t);
      game.setFallout(t, true);
    });
    const tip = game.ref(150, 100);
    expect(game.owner(tip)).toBe(owner);
    expect(owner.numTilesOwned()).toBeLessThan(20 * 533);
    executeTicks(game, 45);
    expect(game.owner(tip)).toBe(owner);
  });
});
