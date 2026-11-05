import { TileRef } from "@openfront/engine-api/game/GameMap";
import { LaunchBlock, UnitType } from "@openfront/engine-api/game/GameTypes";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  conquerRect,
  conventionalGame,
  setGold,
  structure,
} from "../../util/ConventionalWar";
import { TestConfig } from "../../util/TestConfig";

/**
 * Why an air order can't be launched (BuildableUnit.blocked), as the build
 * menu, the build bar and the ghost preview show it. AirOps.airLaunch
 * decides it along with canBuild, so the two never disagree.
 */

const AIR_ORDERS = [
  UnitType.Airstrike,
  UnitType.Airdrop,
  UnitType.CruiseMissile,
  UnitType.BallisticMissile,
  UnitType.ClusterMissile,
  UnitType.Drone,
] as const;

// big_plains: a holds x < 50, b x >= 50.
async function sides(): Promise<{ game: Game; a: Player; b: Player }> {
  const { game, players } = await conventionalGame("big_plains", ["a", "b"]);
  const [a, b] = players;
  conquerRect(game, a, 0, 0, 50, 200);
  conquerRect(game, b, 50, 0, 200, 200);
  return { game, a, b };
}

/** The build menu's answer for `type` at `tile` (null: the build bar's). */
function answer(a: Player, type: UnitType, tile: TileRef | null) {
  const [unit] = a.buildableUnits(tile, [type as (typeof AIR_ORDERS)[number]]);
  return unit;
}

function blocked(
  a: Player,
  type: UnitType,
  tile: TileRef | null,
): LaunchBlock | undefined {
  return answer(a, type, tile).blocked;
}

describe("why an air order can't be launched", () => {
  test("airstrikes and airdrops: no airbase, one being built, one recharging", async () => {
    const { game, a } = await sides();
    const enemy = game.ref(130, 100);
    setGold(a, 100_000_000n);
    expect(blocked(a, UnitType.Airstrike, enemy)).toBe("no_airbase");
    expect(blocked(a, UnitType.Airstrike, null)).toBe("no_airbase");
    // 164 tiles away: out of range of this target, fine for the bar.
    structure(game, a, UnitType.Airbase, game.ref(0, 0));
    const base = structure(game, a, UnitType.Airbase, game.ref(40, 100));
    setGold(a, 100_000_000n);
    base.setUnderConstruction(true);
    expect(blocked(a, UnitType.Airstrike, enemy)).toBe("airbase_building");
    expect(blocked(a, UnitType.Airdrop, enemy)).toBe("airbase_building");
    expect(blocked(a, UnitType.Airstrike, null)).toBeUndefined();
    base.setUnderConstruction(false);
    base.launch();
    expect(blocked(a, UnitType.Airstrike, enemy)).toBe("airbase_recharging");
    base.reloadMissile();
    expect(answer(a, UnitType.Airstrike, enemy).canBuild).toBe(base.tile());
    expect(blocked(a, UnitType.Airstrike, enemy)).toBeUndefined();
    // Airdrops still need enemy or unclaimed land; airstrikes take any tile.
    const own = game.ref(30, 100);
    expect(blocked(a, UnitType.Airdrop, own)).toBe("airdrop_land");
    expect(blocked(a, UnitType.Airstrike, own)).toBeUndefined();
    setGold(a, 0n);
    expect(blocked(a, UnitType.Airstrike, enemy)).toBe("gold");
    expect(blocked(a, UnitType.Airstrike, null)).toBe("gold");
  });

  test("missiles: a loaded silo in range for cruise, level 2 and 3 for the heavy ones", async () => {
    const { game, a } = await sides();
    const enemy = game.ref(130, 100);
    setGold(a, 100_000_000n);
    expect(blocked(a, UnitType.CruiseMissile, enemy)).toBe("no_loaded_silo");
    expect(blocked(a, UnitType.BallisticMissile, enemy)).toBe("silo_level_2");
    expect(blocked(a, UnitType.ClusterMissile, enemy)).toBe("silo_level_3");
    const silo = structure(game, a, UnitType.MissileSilo, game.ref(20, 100));
    setGold(a, 100_000_000n);
    expect(blocked(a, UnitType.CruiseMissile, enemy)).toBeUndefined();
    expect(blocked(a, UnitType.BallisticMissile, enemy)).toBe("silo_level_2");
    expect(blocked(a, UnitType.BallisticMissile, null)).toBe("silo_level_2");
    silo.launch();
    expect(blocked(a, UnitType.CruiseMissile, enemy)).toBe("no_loaded_silo");
    const heavy = structure(
      game,
      a,
      UnitType.MissileSilo,
      game.ref(20, 140),
      2,
    );
    setGold(a, 100_000_000n);
    expect(blocked(a, UnitType.BallisticMissile, enemy)).toBeUndefined();
    expect(blocked(a, UnitType.ClusterMissile, enemy)).toBe("silo_level_3");
    // Ballistic missiles still need an enemy tile.
    expect(blocked(a, UnitType.BallisticMissile, game.ref(30, 100))).toBe(
      "enemy_land",
    );
    heavy.launch();
    heavy.launch();
    expect(blocked(a, UnitType.BallisticMissile, enemy)).toBe("silo_reloading");
    expect(blocked(a, UnitType.BallisticMissile, null)).toBe("silo_reloading");
  });

  test("drones: a target near the cursor, within 100 tiles of our land", async () => {
    const { game, a, b } = await sides();
    setGold(a, 1_000_000n);
    expect(blocked(a, UnitType.Drone, game.ref(100, 100))).toBe(
      "no_drone_target",
    );
    const far = structure(game, b, UnitType.City, game.ref(160, 100));
    const near = structure(game, b, UnitType.City, game.ref(100, 100));
    setGold(a, 1_000_000n);
    expect(blocked(a, UnitType.Drone, far.tile())).toBe("drone_range");
    expect(answer(a, UnitType.Drone, near.tile()).canBuild).toBe(
      game.ref(49, 100),
    );
    // The bar has no tile: nothing to say about a target yet.
    expect(blocked(a, UnitType.Drone, null)).toBeUndefined();
    setGold(a, 0n);
    expect(blocked(a, UnitType.Drone, null)).toBe("gold");
  });

  test("nothing during spawn protection", async () => {
    const { game, a, b } = await sides();
    structure(game, a, UnitType.Airbase, game.ref(40, 100));
    structure(game, a, UnitType.MissileSilo, game.ref(20, 100), 3);
    const city = structure(game, b, UnitType.City, game.ref(60, 100));
    setGold(a, 100_000_000n);
    (game.config() as TestConfig).setSpawnImmunityDuration(1_000_000);
    expect(game.isSpawnImmunityActive()).toBe(true);
    for (const type of AIR_ORDERS) {
      expect(blocked(a, type, city.tile()), type).toBe("spawn_protection");
      expect(blocked(a, type, null), type).toBe("spawn_protection");
    }
  });

  test("the reason is set exactly when canBuild says no, and agrees with it", async () => {
    const { game, a, b } = await sides();
    const base = structure(game, a, UnitType.Airbase, game.ref(40, 60));
    structure(game, a, UnitType.MissileSilo, game.ref(20, 140), 2);
    structure(game, b, UnitType.City, game.ref(90, 100));
    structure(game, b, UnitType.FlakGun, game.ref(150, 150));
    structure(game, a, UnitType.City, game.ref(30, 30));
    setGold(a, 100_000_000n);
    base.launch();
    for (let x = 5; x < 200; x += 15) {
      for (let y = 5; y < 200; y += 15) {
        const tile = game.ref(x, y);
        for (const type of AIR_ORDERS) {
          const unit = answer(a, type, tile);
          expect(unit.canBuild, `${type} at ${x},${y}`).toBe(
            a.canBuild(type, tile),
          );
          expect(unit.blocked === undefined, `${type} at ${x},${y}`).toBe(
            unit.canBuild !== false,
          );
        }
      }
    }
    // Only air orders carry a reason.
    expect(
      a.buildableUnits(game.ref(130, 100), [UnitType.City])[0],
    ).not.toHaveProperty("blocked");
  });
});
