import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  AIRBASE_CONSTRUCTION_TICKS,
  airbaseCost,
  AIRDROP_COST,
  AIRSTRIKE_COST,
  BALLISTIC_MISSILE_COST,
  canDestroySam,
  clusterMissileCost,
  CONVENTIONAL_WAR_UNIT_TYPES,
  CRUISE_MISSILE_COST,
  DRONE_COST,
  flakGunCost,
  NUCLEAR_UNIT_TYPES,
} from "@openfront/engine-lib/game/ConventionalWar";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import {
  conquerRect,
  conventionalGame,
  order,
  structure,
} from "../../util/ConventionalWar";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

describe("conventional war mode", () => {
  test("off: the game is upstream's, air units disabled", async () => {
    const game = await setup("plains", {});
    const config = game.config();
    expect(config.conventionalWar()).toBe(false);
    for (const type of CONVENTIONAL_WAR_UNIT_TYPES) {
      expect(config.isUnitDisabled(type)).toBe(true);
    }
    for (const type of NUCLEAR_UNIT_TYPES) {
      expect(config.isUnitDisabled(type)).toBe(false);
    }
  });

  test("on: nukes disabled, air units enabled", async () => {
    const game = await setup("plains", { conventionalWar: true });
    const config = game.config();
    for (const type of CONVENTIONAL_WAR_UNIT_TYPES) {
      expect(config.isUnitDisabled(type)).toBe(false);
    }
    for (const type of [
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.MIRV,
    ]) {
      expect(config.isUnitDisabled(type)).toBe(true);
    }
    // Everything else stays as configured, and disabledUnits still applies.
    expect(config.isUnitDisabled(UnitType.MissileSilo)).toBe(false);
    expect(config.isUnitDisabled(UnitType.SAMLauncher)).toBe(false);
    const limited = await setup("plains", {
      conventionalWar: true,
      disabledUnits: [UnitType.Airbase],
    });
    expect(limited.config().isUnitDisabled(UnitType.Airbase)).toBe(true);
    expect(limited.config().isUnitDisabled(UnitType.Airstrike)).toBe(false);
  });

  test("doesn't turn on the doomsday clock or overtime", async () => {
    const game = await setup("plains", { conventionalWar: true });
    expect(game.config().doomsdayClockConfig().enabled).toBe(false);
    expect(game.config().overtimeConfig().enabled).toBe(false);
  });

  test("nukes can't be built or launched in conventional war", async () => {
    const { game, players } = await conventionalGame("big_plains", ["a", "b"], {
      infiniteGold: true,
    });
    const [a, b] = players;
    conquerRect(game, a, 0, 0, 40, 40);
    conquerRect(game, b, 100, 100, 140, 140);
    structure(game, a, UnitType.MissileSilo, game.ref(10, 10));
    expect(a.canBuild(UnitType.AtomBomb, game.ref(120, 120))).toBe(false);
    game.addExecution(
      new ConstructionExecution(a, UnitType.AtomBomb, game.ref(120, 120)),
    );
    executeTicks(game, 5);
    expect(game.units(UnitType.AtomBomb)).toHaveLength(0);
  });

  test("air units can't be built with the mode off", async () => {
    const game = await setup("big_plains", { infiniteGold: true });
    expect(() => game.config().isUnitDisabled(UnitType.Airbase)).not.toThrow();
    expect(game.config().isUnitDisabled(UnitType.Airbase)).toBe(true);
  });
});

describe("conventional war prices", () => {
  test("weapon tiers: SAM killers cost what an atom bomb does", () => {
    expect(AIRSTRIKE_COST).toBe(750_000);
    expect(CRUISE_MISSILE_COST).toBe(750_000);
    expect(BALLISTIC_MISSILE_COST).toBe(5_000_000);
    expect(AIRDROP_COST).toBe(100_000);
    expect(DRONE_COST).toBe(40_000);
    expect(canDestroySam(UnitType.Airstrike, 3)).toBe(true);
    expect(canDestroySam(UnitType.CruiseMissile, 3)).toBe(true);
    expect(canDestroySam(UnitType.Drone, 1)).toBe(false);
  });

  test("airbase (owned+1) x 300k capped at 1.2M; flak (owned+1) x 250k capped at 1M", () => {
    expect([0, 1, 2, 3, 9].map(airbaseCost)).toEqual([
      300_000, 600_000, 900_000, 1_200_000, 1_200_000,
    ]);
    expect([0, 1, 3, 9].map(flakGunCost)).toEqual([
      250_000, 500_000, 1_000_000, 1_000_000,
    ]);
    expect(AIRBASE_CONSTRUCTION_TICKS).toBe(100);
  });

  test("cluster missile: 10M + 5M per cluster missile launched", () => {
    expect([0, 1, 2].map(clusterMissileCost)).toEqual([
      10_000_000, 15_000_000, 20_000_000,
    ]);
  });

  test("the engine charges the listed prices", async () => {
    const { game, players } = await conventionalGame("big_plains", ["a", "b"]);
    const [a, b] = players;
    conquerRect(game, a, 0, 0, 60, 60);
    conquerRect(game, b, 70, 0, 130, 60);
    const price = (type: UnitType) => game.unitInfo(type).cost(game, a);
    expect(price(UnitType.Airbase)).toBe(300_000n);
    expect(price(UnitType.Airstrike)).toBe(750_000n);
    expect(price(UnitType.CruiseMissile)).toBe(750_000n);
    expect(price(UnitType.BallisticMissile)).toBe(5_000_000n);
    expect(price(UnitType.ClusterMissile)).toBe(10_000_000n);
    expect(price(UnitType.FlakGun)).toBe(250_000n);
    expect(price(UnitType.Drone)).toBe(40_000n);

    // An airstrike costs 750k at launch.
    structure(game, a, UnitType.Airbase, game.ref(50, 30));
    a.addGold(1_000_000n);
    const before = a.gold();
    order(game, a, UnitType.Airstrike, game.ref(80, 30));
    executeTicks(game, 3);
    expect(game.units(UnitType.Airstrike)).toHaveLength(1);
    expect(before - a.gold()).toBe(750_000n);

    // Each cluster missile launched raises the next one's price by 5M.
    const silo = structure(game, a, UnitType.MissileSilo, game.ref(10, 10), 3);
    a.addGold(10_000_000n);
    order(game, a, UnitType.ClusterMissile, game.ref(120, 50));
    executeTicks(game, 3);
    expect(game.clusterMissilesLaunched()).toBe(1);
    expect(silo.missileTimerQueue()).toHaveLength(1);
    expect(price(UnitType.ClusterMissile)).toBe(15_000_000n);
    // MIRVs keep their own count.
    expect(game.mirvsLaunched()).toBe(0);
  });
});

describe("silo level gates the heavy missiles", () => {
  test("cruise from any silo, ballistic from level 2, cluster from level 3", async () => {
    const { game, players } = await conventionalGame("big_plains", ["a", "b"], {
      infiniteGold: true,
    });
    const [a, b] = players;
    conquerRect(game, a, 0, 0, 60, 60);
    conquerRect(game, b, 100, 100, 160, 160);
    const target = game.ref(130, 130);
    const silo = structure(game, a, UnitType.MissileSilo, game.ref(10, 10));
    expect(a.canBuild(UnitType.CruiseMissile, game.ref(110, 110))).toBe(
      silo.tile(),
    );
    expect(a.canBuild(UnitType.BallisticMissile, target)).toBe(false);
    expect(a.canBuild(UnitType.ClusterMissile, target)).toBe(false);
    silo.increaseLevel();
    silo.reloadMissile();
    expect(a.canBuild(UnitType.BallisticMissile, target)).toBe(silo.tile());
    expect(a.canBuild(UnitType.ClusterMissile, target)).toBe(false);
    silo.increaseLevel();
    silo.reloadMissile();
    expect(a.canBuild(UnitType.ClusterMissile, target)).toBe(silo.tile());
  });

  test("cruise missiles strike any tile, own and empty land too, from a loaded silo", async () => {
    const { game, players } = await conventionalGame("big_plains", ["a", "b"], {
      infiniteGold: true,
    });
    const [a, b] = players;
    conquerRect(game, a, 0, 0, 20, 20);
    conquerRect(game, b, 30, 30, 60, 60);
    const silo = structure(game, a, UnitType.MissileSilo, game.ref(5, 5));
    // Like a nuke: the blast decides what it hits, not the tile's owner.
    for (const [x, y] of [
      [40, 40],
      [10, 10],
      [150, 150],
    ]) {
      expect(a.canBuild(UnitType.CruiseMissile, game.ref(x, y))).toBe(
        silo.tile(),
      );
    }
    // Its one missile spent: nothing can go until it reloads.
    silo.launch();
    expect(a.canBuild(UnitType.CruiseMissile, game.ref(40, 40))).toBe(false);
  });
});
