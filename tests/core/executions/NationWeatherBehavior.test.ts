import {
  Difficulty,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { WeatherKind } from "@openfront/engine-api/game/GameUpdates";
import { SEASON_CYCLE_TICKS } from "@openfront/engine-lib/game/Seasons";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationAllianceBehavior } from "@openfront/engine/execution/nation/NationAllianceBehavior";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { NationWarshipBehavior } from "@openfront/engine/execution/nation/NationWarshipBehavior";
import {
  frontIsMostlySnow,
  holdsOffWinterAttack,
  routeCrossesStorm,
  winterAttackShare,
} from "@openfront/engine/execution/nation/NationWeatherBehavior";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { WeatherExecution } from "@openfront/engine/execution/WeatherExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, it, vi } from "vitest";
import { conquerRect } from "../../util/ConventionalWar";
import { setup } from "../../util/Setup";
import { createGame, L, W } from "../pathfinding/_fixtures";

const IN_WINTER = SEASON_CYCLE_TICKS + 100;
const FAIR = SEASON_CYCLE_TICKS - 1000;

function behaviorFor(game: Game, nation: Player): NationAttackBehavior {
  const random = new PseudoRandom(42);
  const emoji = new NationEmojiBehavior(random, game, nation);
  return new NationAttackBehavior(
    random,
    game,
    nation,
    0, // triggerRatio
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

describe("nations in winter", () => {
  /** A nation and an enemy nation sharing a front at rows [y0, y1). */
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

  it("hold off a big attack into snow land until spring", async () => {
    const { game, nation, enemy, clock } = await front(Difficulty.Hard, 0, 20);
    const behavior = behaviorFor(game, nation);
    const spy = vi.spyOn(game, "addExecution");
    clock.mockReturnValue(IN_WINTER);
    expect(behavior.sendAttack(enemy)).toBe(false);
    expect(landAttacks(spy)).toHaveLength(0);
    clock.mockReturnValue(FAIR);
    expect(behavior.sendAttack(enemy)).toBe(true);
    expect(landAttacks(spy)).toHaveLength(1);
  });

  it("still attack in winter where the front isn't snow", async () => {
    const { game, nation, enemy, clock } = await front(Difficulty.Hard, 60, 90);
    clock.mockReturnValue(IN_WINTER);
    expect(frontIsMostlySnow(game, nation, enemy)).toBe(false);
    expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(true);
  });

  it("hold off less on higher difficulty", async () => {
    expect(winterAttackShare(Difficulty.Easy)).toBeLessThan(
      winterAttackShare(Difficulty.Medium),
    );
    expect(winterAttackShare(Difficulty.Medium)).toBeLessThan(
      winterAttackShare(Difficulty.Hard),
    );
    expect(winterAttackShare(Difficulty.Hard)).toBeLessThan(
      winterAttackShare(Difficulty.Impossible),
    );
    // A push of 35% of the nation's troops into the snow.
    const held = async (difficulty: Difficulty) => {
      const { game, nation, enemy, clock } = await front(difficulty, 0, 20);
      clock.mockReturnValue(IN_WINTER);
      expect(frontIsMostlySnow(game, nation, enemy)).toBe(true);
      return holdsOffWinterAttack(game, nation, enemy, 35_000);
    };
    expect(await held(Difficulty.Easy)).toBe(true);
    expect(await held(Difficulty.Medium)).toBe(true);
    expect(await held(Difficulty.Hard)).toBe(true);
    expect(await held(Difficulty.Impossible)).toBe(false);
  });

  it("send small attacks, and ignore winter when seasons are off", async () => {
    const { game, nation, enemy, clock } = await front(Difficulty.Easy, 0, 20);
    clock.mockReturnValue(IN_WINTER);
    expect(holdsOffWinterAttack(game, nation, enemy, 5_000)).toBe(false);
    expect(holdsOffWinterAttack(game, nation, enemy, 50_000)).toBe(true);
    vi.spyOn(game.config(), "seasonsEnabled").mockReturnValue(false);
    expect(holdsOffWinterAttack(game, nation, enemy, 50_000)).toBe(false);
  });
});

// Open sea with a peninsula reaching toward the enemy coast at x <= 10:
// `nation` holds the north (y < 52), `enemy` the south.
describe("nation boats and sea storms", () => {
  function setupSea(difficulty: Difficulty) {
    const width = 400;
    const height = 60;
    const isLand = (x: number, y: number) =>
      y <= 7 || (x <= 10 && y <= 20) || y >= 52;
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

  it("sails as usual under a storm that is only forecast", () => {
    const { game, enemy, behavior, storm, landings } = setupSea(
      Difficulty.Easy,
    );
    storm(200, 30, 400, 10_000);
    expect(behavior.sendAttack(enemy)).toBe(true);
    expect(game.x(landings()[0])).toBeLessThanOrEqual(10);
  });
});
