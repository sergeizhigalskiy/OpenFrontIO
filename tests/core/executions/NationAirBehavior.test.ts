import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  considerAirPower,
  NATION_AIRBASE_MIN_GOLD,
} from "@openfront/engine/execution/nation/NationAirBehavior";
import { Game, Player } from "@openfront/engine/game/Game";
import { conquerRect, setGold, structure } from "../../util/ConventionalWar";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

// big_plains: the nation holds x < 100, the human x >= 100.
async function war(conventionalWar = true): Promise<{
  game: Game;
  nation: Player;
  enemy: Player;
}> {
  const game = await setup(
    "big_plains",
    { conventionalWar, instantBuild: true },
    [new PlayerInfo("enemy", PlayerType.Human, "c_enemy", "enemy")],
  );
  const nation = game.addPlayer(
    new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
  );
  const enemy = game.player("enemy");
  conquerRect(game, nation, 0, 0, 100, 200);
  conquerRect(game, enemy, 100, 0, 200, 200);
  nation.setSpawnTile(game.ref(50, 100));
  return { game, nation, enemy };
}

describe("nation air power", () => {
  test("does nothing outside conventional war", async () => {
    const { game, nation } = await war(false);
    setGold(nation, 50_000_000n);
    considerAirPower(game, nation);
    executeTicks(game, 3);
    expect(nation.units(UnitType.Airbase)).toHaveLength(0);
  });

  test("builds one airbase near its capital once rich", async () => {
    const { game, nation } = await war();
    setGold(nation, BigInt(NATION_AIRBASE_MIN_GOLD) - 1n);
    considerAirPower(game, nation);
    executeTicks(game, 3);
    expect(nation.units(UnitType.Airbase)).toHaveLength(0);
    setGold(nation, BigInt(NATION_AIRBASE_MIN_GOLD) * 10n);
    considerAirPower(game, nation);
    executeTicks(game, 3);
    considerAirPower(game, nation);
    executeTicks(game, 3);
    expect(nation.units(UnitType.Airbase)).toHaveLength(1);
  });

  test("strikes a defense post covering its attack, or the SAM covering it first", async () => {
    const { game, nation, enemy } = await war();
    structure(game, nation, UnitType.Airbase, game.ref(80, 100));
    structure(game, nation, UnitType.MissileSilo, game.ref(20, 100));
    const post = structure(
      game,
      enemy,
      UnitType.DefensePost,
      game.ref(110, 100),
    );
    const sam = structure(
      game,
      enemy,
      UnitType.SAMLauncher,
      game.ref(130, 100),
    );
    nation.setTroops(1_000_000);
    game.addExecution(new AttackExecution(200_000, nation, enemy.id(), null));
    executeTicks(game, 2);
    setGold(nation, 50_000_000n);

    // The SAM covers the post: a cruise missile at the SAM first.
    considerAirPower(game, nation);
    executeTicks(game, 3);
    expect(game.units(UnitType.CruiseMissile)).toHaveLength(1);
    expect(game.units(UnitType.Airstrike)).toHaveLength(0);
    // With the SAM gone, the post is struck.
    sam.delete(false);
    considerAirPower(game, nation);
    executeTicks(game, 3);
    expect(game.units(UnitType.Airstrike)).toHaveLength(1);
    executeTicks(game, 30);
    expect(post.isActive()).toBe(false);
  });
});
