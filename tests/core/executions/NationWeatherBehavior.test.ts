import {
  Difficulty,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { WeatherKind } from "@openfront/engine-api/game/GameUpdates";
import {
  SEASON_CYCLE_TICKS,
  WINTER_WARNING_TICKS,
} from "@openfront/engine-lib/game/Seasons";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationAllianceBehavior } from "@openfront/engine/execution/nation/NationAllianceBehavior";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { NationWarshipBehavior } from "@openfront/engine/execution/nation/NationWarshipBehavior";
import {
  frontHardness,
  frontIsMostlySnow,
  frontWeather,
  holdsForWeather,
  launchesEarlyBeforeWinter,
  NATION_MUD_CLEARS_TICKS,
  NATION_MUD_FRONT_WEIGHT,
  NATION_SHORT_STORM_TILES,
  NATION_SNOW_FRONT_WEIGHT,
  routeCrossesStorm,
  routeStormTiles,
  winterHoldShare,
} from "@openfront/engine/execution/nation/NationWeatherBehavior";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { WeatherExecution } from "@openfront/engine/execution/WeatherExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, it, vi } from "vitest";
import { conquerRect } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";
import { createGame, L, W } from "../pathfinding/_fixtures";

const IN_WINTER = SEASON_CYCLE_TICKS + 100;
const FAIR = SEASON_CYCLE_TICKS - 1000;
const IN_WARNING = SEASON_CYCLE_TICKS - WINTER_WARNING_TICKS + 100;

function behaviorFor(
  game: Game,
  nation: Player,
  triggerRatio = 0,
): NationAttackBehavior {
  const random = new PseudoRandom(42);
  const emoji = new NationEmojiBehavior(random, game, nation);
  return new NationAttackBehavior(
    random,
    game,
    nation,
    triggerRatio,
    0, // reserveRatio: send everything, a big attack
    0, // expandRatio
    new NationAllianceBehavior(random, game, nation, emoji),
    emoji,
    new NationWarshipBehavior(random, game, nation, emoji),
  );
}

function landAttacks(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map((c) => c[0])
    .filter((e) => e instanceof AttackExecution);
}

/** Who the land attacks the spy saw go out were aimed at. */
function attackTargets(spy: { mock: { calls: unknown[][] } }) {
  return landAttacks(spy).map((e) => e.targetID());
}

/** A nation and an enemy nation sharing a front at rows [y0, y1); rows 0-29 are snow land. */
async function front(difficulty: Difficulty, y0: number, y1: number) {
  const game = await setup("plains", { difficulty }, [
    new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
    new PlayerInfo("enemy", PlayerType.Nation, null, "enemy"),
  ]);
  const nation = game.player("nation");
  const enemy = game.player("enemy");
  conquerRect(game, nation, 0, y0, 50, y1);
  conquerRect(game, enemy, 50, y0, 100, y1);
  nation.setTroops(100_000);
  enemy.setTroops(10_000);
  const clock = vi.spyOn(game, "ticksSinceStart");
  return { game, nation, enemy, clock };
}

/**
 * The whole plains map: `nation` holds the west half, `snowy` the north-east
 * (rows 0-29, snow land) and `fair` the south-east, so `nation` faces a snow
 * front and a fair one.
 */
async function twoFronts(difficulty: Difficulty) {
  const game = await setup("plains", { difficulty }, [
    new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
    new PlayerInfo("snowy", PlayerType.Nation, null, "snowy"),
    new PlayerInfo("fair", PlayerType.Nation, null, "fair"),
  ]);
  const nation = game.player("nation");
  const snowy = game.player("snowy");
  const fair = game.player("fair");
  conquerRect(game, nation, 0, 0, 50, 100);
  conquerRect(game, snowy, 50, 0, 100, 30);
  conquerRect(game, fair, 50, 30, 100, 100);
  nation.setTroops(100_000);
  // The snow-front enemy is a little weaker, so in fair weather it goes first.
  snowy.setTroops(9_000);
  fair.setTroops(10_000);
  const clock = vi.spyOn(game, "ticksSinceStart");
  return { game, nation, snowy, fair, clock };
}

/** Scripted weather on `game`: cells added by hand, in effect at once. */
function scriptedWeather(game: Game) {
  const weather = new WeatherExecution(1, false);
  game.addExecution(weather);
  game.executeNextTick();
  return (
    kind: WeatherKind,
    x: number,
    y: number,
    radius: number,
    endTick = 1_000_000,
  ) =>
    weather.addCell({
      id: weather.cells().length + 1,
      kind,
      x,
      y,
      dx: 0,
      dy: 0,
      radius,
      announceTick: 0,
      activeTick: 0,
      endTick,
    });
}

describe("nations in winter", () => {
  it("Easy holds offensive pushes over 25% of its troops into snow, Medium over 40%", async () => {
    expect(winterHoldShare(Difficulty.Easy)).toBe(0.25);
    expect(winterHoldShare(Difficulty.Medium)).toBe(0.4);
    for (const [difficulty, held, sent] of [
      [Difficulty.Easy, 26_000, 24_000],
      [Difficulty.Medium, 41_000, 39_000],
    ] as const) {
      const { game, nation, enemy, clock } = await front(difficulty, 0, 20);
      clock.mockReturnValue(IN_WINTER);
      expect(frontIsMostlySnow(game, nation, enemy)).toBe(true);
      expect(holdsForWeather(game, nation, enemy, held)).toBe(true);
      expect(holdsForWeather(game, nation, enemy, sent)).toBe(false);
      clock.mockReturnValue(FAIR);
      expect(holdsForWeather(game, nation, enemy, held)).toBe(false);
    }
  });

  it("Easy waits for spring with a big push into snow", async () => {
    const { game, nation, enemy, clock } = await front(Difficulty.Easy, 0, 20);
    const behavior = behaviorFor(game, nation);
    const spy = vi.spyOn(game, "addExecution");
    clock.mockReturnValue(IN_WINTER);
    expect(behavior.sendAttack(enemy)).toBe(false);
    expect(landAttacks(spy)).toHaveLength(0);
    clock.mockReturnValue(FAIR);
    expect(behavior.sendAttack(enemy)).toBe(true);
    expect(landAttacks(spy)).toHaveLength(1);
  });

  it.each([Difficulty.Hard, Difficulty.Impossible])(
    "%s never holds in winter",
    async (difficulty) => {
      expect(winterHoldShare(difficulty)).toBeNull();
      const { game, nation, enemy, clock } = await front(difficulty, 0, 20);
      clock.mockReturnValue(IN_WINTER);
      expect(holdsForWeather(game, nation, enemy, 100_000)).toBe(false);
      expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(true);
    },
  );

  it("winter never holds an answer: Easy hits back into snow with everything", async () => {
    const { game, nation, enemy, clock } = await front(Difficulty.Easy, 0, 20);
    game.addExecution(new AttackExecution(5_000, enemy, nation.id()));
    executeTicks(game, 1);
    clock.mockReturnValue(IN_WINTER);
    const spy = vi.spyOn(game, "addExecution");
    expect(behaviorFor(game, nation).sendAttack(enemy, true)).toBe(true);
    expect(attackTargets(spy)).toEqual([enemy.id()]);
  });

  it("still attacks in winter where the front isn't snow", async () => {
    const { game, nation, enemy, clock } = await front(Difficulty.Easy, 60, 90);
    clock.mockReturnValue(IN_WINTER);
    expect(frontIsMostlySnow(game, nation, enemy)).toBe(false);
    expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(true);
  });

  it("ignores winter when seasons are off", async () => {
    const { game, nation, enemy, clock } = await front(Difficulty.Easy, 0, 20);
    clock.mockReturnValue(IN_WINTER);
    expect(holdsForWeather(game, nation, enemy, 50_000)).toBe(true);
    vi.spyOn(game.config(), "seasonsEnabled").mockReturnValue(false);
    expect(holdsForWeather(game, nation, enemy, 50_000)).toBe(false);
  });

  it("Hard prefers the front without snow in winter", async () => {
    const pick = async (when: number) => {
      const { game, nation, clock } = await twoFronts(Difficulty.Hard);
      clock.mockReturnValue(when);
      const spy = vi.spyOn(game, "addExecution");
      behaviorFor(game, nation).maybeAttack();
      return attackTargets(spy);
    };
    expect(await pick(FAIR)).toEqual(["snowy"]);
    expect(await pick(IN_WINTER)).toEqual(["fair"]);
  });

  it("Hard and Impossible rank a snow front as harder, in winter only", async () => {
    for (const difficulty of [
      Difficulty.Easy,
      Difficulty.Medium,
      Difficulty.Hard,
      Difficulty.Impossible,
    ]) {
      const { game, nation, snowy, fair, clock } = await twoFronts(difficulty);
      const snow = frontWeather(game, nation, snowy);
      expect(snow.front).toBeGreaterThan(0);
      expect(snow.snow).toBe(snow.front);
      const ranks =
        difficulty === Difficulty.Hard || difficulty === Difficulty.Impossible;
      clock.mockReturnValue(IN_WINTER);
      expect(frontHardness(game, nation, snow)).toBe(
        ranks ? NATION_SNOW_FRONT_WEIGHT : 1,
      );
      expect(
        frontHardness(game, nation, frontWeather(game, nation, fair)),
      ).toBe(1);
      clock.mockReturnValue(FAIR);
      expect(frontHardness(game, nation, snow)).toBe(1);
    }
  });

  it("Impossible launches early in the winter warning where its front has no snow", async () => {
    // A trigger ratio it can't reach, so outside the warning it saves up.
    const { game, nation, clock } = await twoFronts(Difficulty.Impossible);
    clock.mockReturnValue(IN_WARNING);
    expect(launchesEarlyBeforeWinter(game, nation)).toBe(true);
    const spy = vi.spyOn(game, "addExecution");
    behaviorFor(game, nation, 2).maybeAttack();
    expect(attackTargets(spy)).toEqual(["fair"]);

    clock.mockReturnValue(FAIR);
    expect(launchesEarlyBeforeWinter(game, nation)).toBe(false);
    clock.mockReturnValue(IN_WINTER);
    expect(launchesEarlyBeforeWinter(game, nation)).toBe(false);
    const hard = await twoFronts(Difficulty.Hard);
    hard.clock.mockReturnValue(IN_WARNING);
    expect(launchesEarlyBeforeWinter(hard.game, hard.nation)).toBe(false);
  });

  it("Impossible doesn't launch early into a snow front", async () => {
    const { game, nation, enemy, clock } = await front(
      Difficulty.Impossible,
      0,
      20,
    );
    // No free land left: the enemy's snow land is our only front.
    conquerRect(game, nation, 0, 20, 100, 100);
    clock.mockReturnValue(IN_WARNING);
    expect(frontIsMostlySnow(game, nation, enemy)).toBe(true);
    const spy = vi.spyOn(game, "addExecution");
    behaviorFor(game, nation, 2).maybeAttack();
    expect(landAttacks(spy)).toHaveLength(0);
  });
});

describe("nations and mud", () => {
  /** A front at rows 60-90 with a mud front over the enemy's side of it. */
  async function muddy(difficulty: Difficulty, endTick = 1_000_000) {
    const f = await front(difficulty, 60, 90);
    scriptedWeather(f.game)(WeatherKind.Mud, 55, 75, 25, endTick);
    f.clock.mockReturnValue(FAIR);
    return f;
  }

  it.each([Difficulty.Easy, Difficulty.Medium])(
    "%s waits while mud covers its front",
    async (difficulty) => {
      const { game, nation, enemy } = await muddy(difficulty);
      const w = frontWeather(game, nation, enemy);
      expect(w.front).toBeGreaterThan(0);
      expect(w.mud).toBe(w.front);
      expect(holdsForWeather(game, nation, enemy, 1_000)).toBe(true);
      expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(false);
    },
  );

  it("Hard attacks into mud, ranking the muddy front as harder", async () => {
    const { game, nation, enemy } = await muddy(Difficulty.Hard);
    expect(holdsForWeather(game, nation, enemy, 100_000)).toBe(false);
    expect(frontHardness(game, nation, frontWeather(game, nation, enemy))).toBe(
      NATION_MUD_FRONT_WEIGHT,
    );
    expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(true);
  });

  it("Impossible holds only if the mud clears within 20 s", async () => {
    expect(NATION_MUD_CLEARS_TICKS).toBe(200);
    // The scripted cells start at tick 1: one ends within 200 ticks, one long after.
    const soon = await muddy(Difficulty.Impossible, 150);
    expect(holdsForWeather(soon.game, soon.nation, soon.enemy, 1_000)).toBe(
      true,
    );
    expect(behaviorFor(soon.game, soon.nation).sendAttack(soon.enemy)).toBe(
      false,
    );
    const late = await muddy(Difficulty.Impossible, 5_000);
    expect(holdsForWeather(late.game, late.nation, late.enemy, 1_000)).toBe(
      false,
    );
    expect(behaviorFor(late.game, late.nation).sendAttack(late.enemy)).toBe(
      true,
    );
  });

  it("mud never holds an answer", async () => {
    const { game, nation, enemy } = await muddy(Difficulty.Easy);
    game.addExecution(new AttackExecution(5_000, enemy, nation.id()));
    executeTicks(game, 1);
    expect(behaviorFor(game, nation).sendAttack(enemy, true)).toBe(true);
  });

  it("free land is never held for mud", async () => {
    const { game, nation } = await muddy(Difficulty.Easy);
    expect(holdsForWeather(game, nation, game.terraNullius(), 1_000)).toBe(
      false,
    );
  });
});

// Open sea with a peninsula reaching toward the enemy coast at x <= 10:
// `nation` holds the north (y < 52), `enemy` the south. With `narrow`, a
// 40-wide strait instead, our coast at y <= 20 all along.
describe("nation boats and sea storms", () => {
  function setupSea(difficulty: Difficulty, narrow = false) {
    const width = narrow ? 40 : 400;
    const height = 60;
    const isLand = (x: number, y: number) =>
      narrow ? y <= 20 || y >= 52 : y <= 7 || (x <= 10 && y <= 20) || y >= 52;
    const grid: string[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) grid.push(isLand(x, y) ? L : W);
    }
    const game = createGame({ width, height, grid }, { difficulty });
    for (const id of ["nation", "enemy"]) {
      game.addPlayer(new PlayerInfo(id, PlayerType.Nation, null, id));
    }
    const nation = game.player("nation");
    const enemy = game.player("enemy");
    game.map().forEachTile((tile) => {
      if (!game.map().isLand(tile)) return;
      (game.y(tile) < 52 ? nation : enemy).conquer(tile);
    });
    nation.setTroops(100_000);
    enemy.setTroops(10_000);
    game.endSpawnPhase();
    const weather = new WeatherExecution(1, false);
    game.addExecution(weather);
    game.executeNextTick();
    const storm = (x: number, y: number, radius: number, activeTick = 0) =>
      weather.addCell({
        id: weather.cells().length + 1,
        kind: WeatherKind.Storm,
        x,
        y,
        dx: 0,
        dy: 0,
        radius,
        announceTick: 0,
        activeTick,
        endTick: 1_000_000,
      });
    const spy = vi.spyOn(game, "addExecution");
    const landings = () =>
      spy.mock.calls
        .map((c) => c[0])
        .filter((e) => e instanceof TransportShipExecution)
        .map((e) => e["ref"] as number);
    return {
      game,
      nation,
      enemy,
      behavior: behaviorFor(game, nation),
      storm,
      landings,
    };
  }

  it("spots a storm on the way, straight or along a path", () => {
    const { game, storm } = setupSea(Difficulty.Medium);
    storm(5, 36, 8);
    const at = (x: number, y: number) => game.ref(x, y);
    expect(routeCrossesStorm(game, [at(5, 21), at(5, 51)])).toBe(true);
    expect(routeCrossesStorm(game, [at(100, 21), at(100, 51)])).toBe(false);
    const path = [];
    for (let y = 21; y <= 51; y++) path.push(at(30, y));
    expect(routeCrossesStorm(game, path)).toBe(false);
    path[10] = at(10, 36);
    expect(routeCrossesStorm(game, path)).toBe(true);
  });

  it("counts the storm tiles on the way, straight or along a path", () => {
    const { game, storm } = setupSea(Difficulty.Medium);
    storm(5, 36, 8);
    const at = (x: number, y: number) => game.ref(x, y);
    // The circle spans y 28-44 on x = 5: 17 tiles either way.
    expect(routeStormTiles(game, [at(5, 21), at(5, 51)])).toBe(17);
    const path = [];
    for (let y = 21; y <= 51; y++) path.push(at(5, y));
    expect(routeStormTiles(game, path)).toBe(17);
    expect(routeStormTiles(game, [at(100, 21), at(100, 51)])).toBe(0);
  });

  it.each([Difficulty.Medium, Difficulty.Impossible])(
    "%s lands somewhere else when a storm sits on the direct crossing",
    (difficulty) => {
      const { game, enemy, behavior, storm, landings } = setupSea(difficulty);
      storm(5, 36, 12);
      expect(behavior.sendAttack(enemy)).toBe(true);
      const [landing] = landings();
      expect(game.x(landing)).toBeGreaterThan(30);
    },
  );

  it("Hard sails through a short storm on the direct crossing", () => {
    expect(NATION_SHORT_STORM_TILES).toBe(15);
    const { game, enemy, behavior, storm, landings } = setupSea(
      Difficulty.Hard,
    );
    storm(5, 36, 5);
    expect(behavior.sendAttack(enemy)).toBe(true);
    expect(game.x(landings()[0])).toBeLessThanOrEqual(10);
  });

  it("Hard lands somewhere else when the storm on the crossing is long", () => {
    const { game, enemy, behavior, storm, landings } = setupSea(
      Difficulty.Hard,
    );
    storm(5, 36, 12);
    expect(behavior.sendAttack(enemy)).toBe(true);
    expect(game.x(landings()[0])).toBeGreaterThan(30);
  });

  it("Impossible picks the safest landing: around even a short storm", () => {
    const { game, enemy, behavior, storm, landings } = setupSea(
      Difficulty.Impossible,
    );
    storm(5, 36, 5);
    expect(behavior.sendAttack(enemy)).toBe(true);
    expect(game.x(landings()[0])).toBeGreaterThan(30);
  });

  it("with a short storm on every route, Hard and Impossible sail and Medium waits", () => {
    for (const [difficulty, sails] of [
      [Difficulty.Medium, false],
      [Difficulty.Hard, true],
      [Difficulty.Impossible, true],
    ] as const) {
      const { game, enemy, behavior, storm, landings } = setupSea(
        difficulty,
        true,
      );
      // A huge circle whose southern edge runs along y = 33 across the strait.
      storm(20, 33 - 10_000, 10_000);
      const at = (x: number, y: number) => game.ref(x, y);
      expect(routeStormTiles(game, [at(20, 20), at(20, 52)])).toBeLessThan(
        NATION_SHORT_STORM_TILES,
      );
      expect(behavior.sendAttack(enemy)).toBe(sails);
      expect(landings()).toHaveLength(sails ? 1 : 0);
    }
  });

  it("waits out a storm covering every route", () => {
    const { enemy, behavior, storm, landings } = setupSea(
      Difficulty.Impossible,
    );
    storm(200, 30, 400);
    expect(behavior.sendAttack(enemy)).toBe(false);
    expect(landings()).toHaveLength(0);
  });

  it("Easy has no other route, so it waits", () => {
    const { enemy, behavior, storm, landings } = setupSea(Difficulty.Easy);
    storm(5, 36, 12);
    expect(behavior.sendAttack(enemy)).toBe(false);
    expect(landings()).toHaveLength(0);
  });

  it.each([Difficulty.Easy, Difficulty.Impossible])(
    "%s sails through any storm to hit back",
    (difficulty) => {
      const { nation, enemy, behavior, storm, landings } = setupSea(difficulty);
      storm(200, 30, 400);
      // The enemy attacked us: our relation is hostile, so this answers it.
      nation.updateRelation(enemy, -100);
      expect(behavior.sendAttack(enemy, true)).toBe(true);
      expect(landings()).toHaveLength(1);
    },
  );

  it("sails as usual under a storm that is only forecast", () => {
    const { game, enemy, behavior, storm, landings } = setupSea(
      Difficulty.Easy,
    );
    storm(200, 30, 400, 10_000);
    expect(behavior.sendAttack(enemy)).toBe(true);
    expect(game.x(landings()[0])).toBeLessThanOrEqual(10);
  });
});
