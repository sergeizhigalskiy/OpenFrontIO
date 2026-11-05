import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  BuildUnitIntentSchema,
  UpgradeStructureIntentSchema,
} from "@openfront/engine-api/Schemas";
import {
  AIRBASE_CONSTRUCTION_TICKS,
  AIRSTRIKE_COST,
  BALLISTIC_MISSILE_COST,
  CRUISE_MISSILE_COST,
} from "@openfront/engine-lib/game/ConventionalWar";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import path from "path";
import { fileURLToPath } from "url";
import { conquerRect, runUntil, setGold } from "../../util/ConventionalWar";
import { setup } from "../../util/Setup";

/**
 * The launch path a player's order takes, end to end: a build intent shaped
 * as the client sends it (Transport.onBuildUnitIntent), validated by the wire
 * schema, turned into an execution by the Executor, then ticked. Real
 * engine config (construction times, spawn immunity), no instant build, so
 * airbases and silos go through ConstructionExecution like in a game.
 */

const UTIL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../util",
);
const CLIENT = "c_a";

// big_plains: the human a holds x < 100, a nation 100-150, a tribe x >= 150.
async function war(): Promise<{
  game: Game;
  a: Player;
  nation: Player;
  tribe: Player;
  send: (intent: Record<string, unknown>) => void;
}> {
  const game = await setup(
    "big_plains",
    { conventionalWar: true, instantBuild: false },
    [new PlayerInfo("a", PlayerType.Human, CLIENT, "a")],
    UTIL_DIR,
    EngineConfig,
  );
  const a = game.player("a");
  const nation = game.addPlayer(
    new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
  );
  const tribe = game.addPlayer(
    new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
  );
  conquerRect(game, a, 0, 0, 100, 200);
  conquerRect(game, nation, 100, 0, 150, 200);
  conquerRect(game, tribe, 150, 0, 200, 200);
  a.setTroops(200_000);
  nation.setTroops(50_000);
  tribe.setTroops(50_000);
  // Past spawn immunity (the real config's).
  runUntil(game, () => !game.isSpawnImmunityActive(), 1_000);
  expect(game.isSpawnImmunityActive()).toBe(false);
  const executor = new Executor(game, "air_launch_path", CLIENT);
  const send = (intent: Record<string, unknown>) => {
    const parsed =
      intent.type === "upgrade_structure"
        ? UpgradeStructureIntentSchema.parse(intent)
        : BuildUnitIntentSchema.parse(intent);
    game.addExecution(executor.createExec({ ...parsed, clientID: CLIENT }));
  };
  return { game, a, nation, tribe, send };
}

/** Builds a structure through its intent and waits until it is finished. */
function buildThroughIntent(
  game: Game,
  a: Player,
  send: (intent: Record<string, unknown>) => void,
  type: UnitType,
  tile: TileRef,
): Unit {
  const before = new Set(a.units(type));
  send({ type: "build_unit", unit: type, tile });
  let built: Unit | undefined;
  runUntil(
    game,
    () => {
      built = a.units(type).find((u) => !before.has(u));
      return built !== undefined && !built.isUnderConstruction();
    },
    AIRBASE_CONSTRUCTION_TICKS * 3,
  );
  expect(built, `${type} was built`).toBeDefined();
  expect(built!.isUnderConstruction()).toBe(false);
  return built!;
}

/** The flight of `type` that takes off within a few ticks of the order. */
function takeOff(game: Game, a: Player, type: UnitType): Unit {
  let flight: Unit | undefined;
  runUntil(
    game,
    () => {
      flight = a.units(type)[0];
      return flight !== undefined;
    },
    5,
  );
  expect(flight, `${type} took off`).toBeDefined();
  return flight!;
}

const TARGETS = [
  ["a nation's", (s: { nation: Player }) => s.nation, 120],
  ["a tribe's", (s: { tribe: Player }) => s.tribe, 170],
] as const;

describe("air orders through the real launch path", () => {
  test.each(TARGETS)(
    "an airstrike from a freshly built airbase at %s land",
    async (_, owner, x) => {
      const s = await war();
      const { game, a, send } = s;
      setGold(a, 10_000_000n);
      const base = buildThroughIntent(
        game,
        a,
        send,
        UnitType.Airbase,
        game.ref(90, 100),
      );
      // Just finished: its sortie is ready, not stuck in cooldown.
      expect(base.isInCooldown()).toBe(false);
      const target = game.ref(x, 100);
      expect(game.owner(target)).toBe(owner(s));
      const post = owner(s).buildUnit(
        UnitType.DefensePost,
        game.ref(x, 101),
        {},
      );
      expect(a.canBuild(UnitType.Airstrike, target)).toBe(base.tile());
      setGold(a, BigInt(AIRSTRIKE_COST));
      send({ type: "build_unit", unit: UnitType.Airstrike, tile: target });
      const plane = takeOff(game, a, UnitType.Airstrike);
      expect(a.gold()).toBe(0n);
      expect(base.isInCooldown()).toBe(true);
      runUntil(game, () => !plane.isActive(), 100);
      expect(plane.reachedTarget()).toBe(true);
      expect(post.isActive()).toBe(false);
    },
  );

  test.each(TARGETS)(
    "an airdrop from a freshly built airbase at %s land",
    async (_, owner, x) => {
      const s = await war();
      const { game, a, send } = s;
      setGold(a, 10_000_000n);
      const base = buildThroughIntent(
        game,
        a,
        send,
        UnitType.Airbase,
        game.ref(90, 100),
      );
      expect(base.isInCooldown()).toBe(false);
      const target = game.ref(x, 100);
      expect(game.owner(target)).toBe(owner(s));
      expect(a.canBuild(UnitType.Airdrop, target)).toBe(base.tile());
      // As the client sends it: the attack-ratio share of the troops.
      send({
        type: "build_unit",
        unit: UnitType.Airdrop,
        tile: target,
        troops: 0.2 * a.troops(),
      });
      const plane = takeOff(game, a, UnitType.Airdrop);
      expect(plane.troops()).toBeGreaterThan(0);
      runUntil(game, () => !plane.isActive(), 100);
      expect(plane.reachedTarget()).toBe(true);
      runUntil(game, () => game.owner(target) === a, 50);
      expect(game.owner(target)).toBe(a);
    },
  );

  test.each(TARGETS)(
    "a cruise missile from a level-1 silo at %s land",
    async (_, owner, x) => {
      const s = await war();
      const { game, a, send } = s;
      setGold(a, 10_000_000n);
      const silo = buildThroughIntent(
        game,
        a,
        send,
        UnitType.MissileSilo,
        game.ref(60, 100),
      );
      expect(silo.level()).toBe(1);
      expect(silo.isInCooldown()).toBe(false);
      const post = owner(s).buildUnit(
        UnitType.DefensePost,
        game.ref(x, 100),
        {},
      );
      expect(a.canBuild(UnitType.CruiseMissile, post.tile())).toBe(silo.tile());
      setGold(a, BigInt(CRUISE_MISSILE_COST));
      send({
        type: "build_unit",
        unit: UnitType.CruiseMissile,
        tile: post.tile(),
      });
      const missile = takeOff(game, a, UnitType.CruiseMissile);
      expect(a.gold()).toBe(0n);
      runUntil(game, () => !missile.isActive(), 100);
      expect(missile.reachedTarget()).toBe(true);
      expect(post.isActive()).toBe(false);
    },
  );

  test.each(TARGETS)(
    "a ballistic missile from a level-2 silo at %s land",
    async (_, owner, x) => {
      const s = await war();
      const { game, a, send } = s;
      setGold(a, 10_000_000n);
      const silo = buildThroughIntent(
        game,
        a,
        send,
        UnitType.MissileSilo,
        game.ref(60, 100),
      );
      const target = game.ref(x, 100);
      // Level 1 can't: it needs level 2.
      expect(a.canBuild(UnitType.BallisticMissile, target)).toBe(false);
      send({
        type: "upgrade_structure",
        unit: UnitType.MissileSilo,
        unitId: silo.id(),
      });
      runUntil(game, () => silo.level() === 2, 5);
      expect(silo.level()).toBe(2);
      expect(silo.isInCooldown()).toBe(false);
      const city = owner(s).buildUnit(UnitType.City, game.ref(x, 101), {});
      expect(a.canBuild(UnitType.BallisticMissile, target)).toBe(silo.tile());
      setGold(a, BigInt(BALLISTIC_MISSILE_COST));
      send({
        type: "build_unit",
        unit: UnitType.BallisticMissile,
        tile: target,
      });
      const missile = takeOff(game, a, UnitType.BallisticMissile);
      expect(a.gold()).toBe(0n);
      runUntil(game, () => !missile.isActive(), 100);
      expect(missile.reachedTarget()).toBe(true);
      expect(city.isActive()).toBe(false);
    },
  );

  test.each(TARGETS)(
    "a drone swarm with no airbase at a city on %s land",
    async (_, owner, x) => {
      const s = await war();
      const { game, a, send } = s;
      const city = owner(s).buildUnit(UnitType.City, game.ref(x, 100), {});
      setGold(a, 10_000_000n);
      expect(a.units(UnitType.Airbase)).toHaveLength(0);
      // a's land ends at x 99: the drones take off from there.
      expect(a.canBuild(UnitType.Drone, city.tile())).toBe(game.ref(99, 100));
      send({
        type: "build_unit",
        unit: UnitType.Drone,
        tile: city.tile(),
        count: 3,
      });
      runUntil(game, () => !city.isActive(), 200);
      expect(city.isActive()).toBe(false);
    },
  );

  test("a cruise missile at a warship off unclaimed coast", async () => {
    const game = await setup(
      "half_land_half_ocean",
      { conventionalWar: true, instantBuild: false },
      [new PlayerInfo("a", PlayerType.Human, CLIENT, "a")],
      UTIL_DIR,
      EngineConfig,
    );
    const a = game.player("a");
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
    );
    conquerRect(game, a, 0, 0, 3, 16);
    runUntil(game, () => !game.isSpawnImmunityActive(), 1_000);
    const executor = new Executor(game, "air_launch_path", CLIENT);
    const send = (intent: Record<string, unknown>) =>
      game.addExecution(
        executor.createExec({
          ...BuildUnitIntentSchema.parse(intent),
          clientID: CLIENT,
        }),
      );
    setGold(a, 10_000_000n);
    const silo = buildThroughIntent(
      game,
      a,
      send,
      UnitType.MissileSilo,
      game.ref(1, 8),
    );
    const ship = nation.buildUnit(UnitType.Warship, game.ref(12, 8), {
      patrolTile: game.ref(12, 8),
    });
    expect(game.isWater(ship.tile())).toBe(true);
    expect(a.canBuild(UnitType.CruiseMissile, ship.tile())).toBe(silo.tile());
    send({
      type: "build_unit",
      unit: UnitType.CruiseMissile,
      tile: ship.tile(),
    });
    const missile = takeOff(game, a, UnitType.CruiseMissile);
    runUntil(game, () => !missile.isActive(), 100);
    expect(ship.isActive()).toBe(false);
  });
});
