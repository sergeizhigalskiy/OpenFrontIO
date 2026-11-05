import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { RuinReward } from "@openfront/engine-lib/game/WorldFeatures";
import { readVersioned } from "@openfront/engine-lib/snapshot/SnapshotType";
import { CityStateExecution } from "@openfront/engine/execution/CityStateExecution";
import { RuinsExecution } from "@openfront/engine/execution/RuinsExecution";
import { GameSnapshot } from "@openfront/engine/game/GameImpl";
import { PlayerSnapshot } from "@openfront/engine/game/PlayerImpl";
import { snapshotGameData } from "@openfront/engine/snapshot/GameSnapshot";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

const MAP = "big_plains";

function cityState(name: string, id: string): PlayerInfo {
  return new PlayerInfo(name, PlayerType.Bot, null, id);
}

describe("world feature snapshots", () => {
  test("ruins waiting, placed and claimed; city-states founded, pending and conquered", async () => {
    const game = await setup(
      MAP,
      {},
      [new PlayerInfo("a", PlayerType.Human, "c_a", "a")],
      undefined,
      undefined,
      false,
    );
    const a = game.player("a");
    game.addExecution(
      new CityStateExecution(cityState("Aldmere", "cs1"), game.ref(60, 60)),
    );
    game.addExecution(new RuinsExecution("world_features_snap"));
    executeTicks(game, 2);
    expect(game.player("cs1").isCityState()).toBe(true);
    // A city-state not founded yet, and ruins waiting for the spawn phase.
    game.addExecution(
      new CityStateExecution(cityState("Bastion", "cs2"), game.ref(150, 150)),
    );
    await expectSnapshotRoundTrip(game, MAP, 3);

    game.endSpawnPhase();
    executeTicks(game, 2);
    expect(game.ruins().size).toBeGreaterThan(0);
    const [claimed] = game.ruins().keys();
    a.conquer(claimed);
    // The first city-state's bounty is paid.
    game.conquerPlayer(a, game.player("cs1"));
    await expectSnapshotRoundTrip(game, MAP, 20);
  }, 60_000);

  test("a game from before world features loads with no ruins or city-states", async () => {
    const game = await setup(MAP, {}, [
      new PlayerInfo("a", PlayerType.Human, "c_a", "a"),
    ]);
    game.addRuins([{ tile: game.ref(5, 5), reward: RuinReward.Gold }]);
    const root = snapshotGameData(game);

    const oldGame = { ...(root.game.d as Record<string, unknown>) };
    delete oldGame.ruins;
    expect(readVersioned(GameSnapshot, { v: 2, d: oldGame }).ruins).toEqual([]);
    expect(readVersioned(GameSnapshot, root.game).ruins).toEqual([
      { tile: game.ref(5, 5), reward: RuinReward.Gold },
    ]);

    const oldPlayer = { ...(root.players[0].d as Record<string, unknown>) };
    delete oldPlayer.isCityState;
    delete oldPlayer.cityStateBountyTaken;
    const migrated = readVersioned(PlayerSnapshot, { v: 2, d: oldPlayer });
    expect(migrated.isCityState).toBe(false);
    expect(migrated.cityStateBountyTaken).toBe(false);
  });
});
