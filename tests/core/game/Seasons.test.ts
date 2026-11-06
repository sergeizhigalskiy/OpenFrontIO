import { GameMap } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  TerrainType,
} from "@openfront/engine-api/game/GameTypes";
import {
  isSnowLand,
  isWinterAt,
  SEASON_CYCLE_TICKS,
  seasonAt,
  SeasonPhase,
  seasonTroopGrowthMultiplier,
  WINTER_ATTACKER_LOSS_MULTIPLIER,
  WINTER_TICKS,
  WINTER_TROOP_GROWTH_MULTIPLIER,
  WINTER_WARNING_TICKS,
  winterAttackLossMultiplier,
} from "@openfront/engine-lib/game/Seasons";
import {
  AttackLogicInput,
  EngineConfig,
} from "@openfront/engine/configuration/EngineConfig";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { conquerRect } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { UseRealAttackLogic } from "../../util/TestConfig";
import { executeTicks } from "../../util/utils";

/** A tick inside the first winter. */
const IN_WINTER = SEASON_CYCLE_TICKS + 100;
/** A tick in the fair weather before it. */
const BEFORE_WINTER = SEASON_CYCLE_TICKS - WINTER_WARNING_TICKS - 100;

describe("season timing", () => {
  it("starts fair, warns 30 seconds ahead, and winters 7 minutes in", () => {
    expect(seasonAt(0)).toEqual({
      phase: SeasonPhase.Fair,
      ticksLeft: SEASON_CYCLE_TICKS - WINTER_WARNING_TICKS,
      winter: 1,
    });
    expect(seasonAt(3899).phase).toBe(SeasonPhase.Fair);
    expect(seasonAt(3900)).toEqual({
      phase: SeasonPhase.Warning,
      ticksLeft: 300,
      winter: 1,
    });
    expect(seasonAt(4199)).toEqual({
      phase: SeasonPhase.Warning,
      ticksLeft: 1,
      winter: 1,
    });
    expect(seasonAt(4200)).toEqual({
      phase: SeasonPhase.Winter,
      ticksLeft: WINTER_TICKS,
      winter: 1,
    });
    expect(seasonAt(5099)).toEqual({
      phase: SeasonPhase.Winter,
      ticksLeft: 1,
      winter: 1,
    });
    expect(seasonAt(5100)).toEqual({
      phase: SeasonPhase.Fair,
      ticksLeft: 3000,
      winter: 2,
    });
  });

  it("repeats every 7 minutes with a 90-second winter", () => {
    expect(SEASON_CYCLE_TICKS).toBe(4200);
    expect(WINTER_TICKS).toBe(900);
    expect(WINTER_WARNING_TICKS).toBe(300);
    const winters: number[] = [];
    let last = false;
    for (let t = 0; t < 4 * SEASON_CYCLE_TICKS; t++) {
      const w = isWinterAt(t);
      if (w && !last) winters.push(t);
      last = w;
    }
    expect(winters).toEqual([4200, 8400, 12600]);
    // No winter during the first cycle, which starts when the spawn phase ends.
    for (let t = 0; t < SEASON_CYCLE_TICKS; t++) {
      expect(isWinterAt(t)).toBe(false);
    }
    expect(seasonAt(8400 + 899).phase).toBe(SeasonPhase.Winter);
    expect(seasonAt(8400 + 900).phase).toBe(SeasonPhase.Fair);
    expect(seasonAt(8400 - 300).phase).toBe(SeasonPhase.Warning);
  });

  it("follows the spawn phase, not the game's tick count", async () => {
    const game = await setup("plains", {}, [], undefined, undefined, false);
    executeTicks(game, 50);
    expect(game.ticksSinceStart()).toBe(0);
    game.endSpawnPhase();
    executeTicks(game, 10);
    expect(game.ticksSinceStart()).toBe(10);
  });
});

describe("snow land", () => {
  function fakeMap(terrain: TerrainType, y: number, height = 100): GameMap {
    return {
      terrainType: () => terrain,
      y: () => y,
      height: () => height,
    } as unknown as GameMap;
  }

  it("is highland and mountain anywhere, plains only in the north 30%", () => {
    expect(isSnowLand(fakeMap(TerrainType.Highland, 90), 0)).toBe(true);
    expect(isSnowLand(fakeMap(TerrainType.Mountain, 90), 0)).toBe(true);
    expect(isSnowLand(fakeMap(TerrainType.Plains, 29), 0)).toBe(true);
    expect(isSnowLand(fakeMap(TerrainType.Plains, 30), 0)).toBe(false);
    expect(isSnowLand(fakeMap(TerrainType.Plains, 299, 1000), 0)).toBe(true);
    expect(isSnowLand(fakeMap(TerrainType.Plains, 300, 1000), 0)).toBe(false);
  });

  it("is never water or impassable land", () => {
    expect(isSnowLand(fakeMap(TerrainType.Ocean, 0), 0)).toBe(false);
    expect(isSnowLand(fakeMap(TerrainType.Impassable, 0), 0)).toBe(false);
  });

  it("reads a real map's terrain and rows", async () => {
    const game = await setup("plains");
    const map = game.map();
    expect(isSnowLand(map, map.ref(50, 29))).toBe(true);
    expect(isSnowLand(map, map.ref(50, 30))).toBe(false);
    const south = map.ref(50, 80);
    map.setMagnitude(south, 15); // highland
    expect(isSnowLand(map, south)).toBe(true);
  });
});

describe("winter rules", () => {
  let config: EngineConfig;
  beforeAll(async () => {
    const game = await setup("plains", {}, [], undefined, UseRealAttackLogic);
    config = game.config();
  });
  const input: AttackLogicInput = {
    terrain: TerrainType.Plains,
    attackTroops: 50_000,
    attacker: { type: PlayerType.Human, numTiles: 2_000 },
    defender: {
      type: PlayerType.Human,
      numTiles: 2_000,
      troops: 20_000,
      isTraitor: false,
      isDisconnectedTeammate: false,
    },
    defenderHasDefensePost: false,
    falloutRatio: null,
    borderSize: 50,
  };

  it("costs +50% attacker troops on snow land, nothing else", () => {
    const base = config.attackLogic(input);
    const winter = config.attackLogic({
      ...input,
      weatherLossMultiplier: WINTER_ATTACKER_LOSS_MULTIPLIER,
    });
    expect(winter.attackerTroopLoss).toBeCloseTo(
      base.attackerTroopLoss * 1.5,
      9,
    );
    expect(winter.defenderTroopLoss).toBe(base.defenderTroopLoss);
    expect(winter.tickFraction).toBe(base.tickFraction);
    // Free land too.
    const free = config.attackLogic({ ...input, defender: null });
    const freeWinter = config.attackLogic({
      ...input,
      defender: null,
      weatherLossMultiplier: 1.5,
    });
    expect(freeWinter.attackerTroopLoss).toBeCloseTo(
      free.attackerTroopLoss * 1.5,
      9,
    );
  });

  it("applies only in winter and only to snow land", async () => {
    const game = await setup("plains");
    const map = game.map();
    const north = map.ref(10, 10);
    const south = map.ref(10, 80);
    expect(winterAttackLossMultiplier(true, map, north)).toBe(1.5);
    expect(winterAttackLossMultiplier(false, map, north)).toBe(1);
    expect(winterAttackLossMultiplier(true, map, south)).toBe(1);
    expect(game.config().isWinter(IN_WINTER)).toBe(true);
    expect(game.config().isWinter(BEFORE_WINTER)).toBe(false);
  });

  it("slows every player's troop growth to 80% in winter only", async () => {
    const game = await setup("plains", {}, [
      new PlayerInfo("a", PlayerType.Human, null, "a"),
    ]);
    const a = game.player("a");
    conquerRect(game, a, 0, 0, 30, 30);
    a.setTroops(20_000);
    const cfg = game.config();
    const fair = cfg.troopIncreaseRate(a, BEFORE_WINTER);
    const winter = cfg.troopIncreaseRate(a, IN_WINTER);
    expect(fair).toBeGreaterThan(0);
    expect(winter).toBeCloseTo(fair * WINTER_TROOP_GROWTH_MULTIPLIER, 9);
    // No clock, no season.
    expect(cfg.troopIncreaseRate(a)).toBe(fair);
    expect(seasonTroopGrowthMultiplier(true)).toBe(0.8);
    expect(seasonTroopGrowthMultiplier(false)).toBe(1);
  });
});

describe("winter in a running game", () => {
  /** a attacks b along a front at rows [y0, y1). */
  async function front(y0: number, y1: number, ticksSinceStart: number) {
    const game = await setup(
      "plains",
      {},
      [
        new PlayerInfo("a", PlayerType.Human, null, "a"),
        new PlayerInfo("b", PlayerType.Human, null, "b"),
      ],
      undefined,
      UseRealAttackLogic,
    );
    vi.spyOn(game, "ticksSinceStart").mockReturnValue(ticksSinceStart);
    const a = game.player("a");
    const b = game.player("b");
    conquerRect(game, a, 0, y0, 50, y1);
    conquerRect(game, b, 50, y0, 100, y1);
    a.setTroops(200_000);
    b.setTroops(1_000);
    game.addExecution(new AttackExecution(100_000, a, b.id()));
    executeTicks(game, 6);
    const attack = a.outgoingAttacks()[0];
    return {
      lost: 100_000 - attack.troops(),
      taken: a.numTilesOwned() - 50 * (y1 - y0),
    };
  }

  it("costs the attacker 50% more troops for the same snow tiles", async () => {
    const fair = await front(0, 20, BEFORE_WINTER);
    const winter = await front(0, 20, IN_WINTER);
    expect(fair.taken).toBeGreaterThan(0);
    expect(winter.taken).toBe(fair.taken);
    expect(winter.lost).toBeCloseTo(fair.lost * 1.5, 6);
  });

  it("leaves attacks into land outside the snow alone", async () => {
    const fair = await front(60, 80, BEFORE_WINTER);
    const winter = await front(60, 80, IN_WINTER);
    expect(winter.taken).toBe(fair.taken);
    expect(winter.lost).toBe(fair.lost);
  });

  it("grows troops at 80% through PlayerExecution", async () => {
    async function growth(ticksSinceStart: number): Promise<number> {
      const game: Game = await setup("plains", {}, [
        new PlayerInfo("a", PlayerType.Human, null, "a"),
      ]);
      vi.spyOn(game, "ticksSinceStart").mockReturnValue(ticksSinceStart);
      const a: Player = game.player("a");
      conquerRect(game, a, 0, 0, 30, 30);
      a.setTroops(20_000);
      game.addExecution(new PlayerExecution(a));
      executeTicks(game, 2);
      return a.troops() - 20_000;
    }
    const fair = await growth(BEFORE_WINTER);
    const winter = await growth(IN_WINTER);
    expect(fair).toBeGreaterThan(0);
    // Troops are whole numbers: within one per tick of 80%.
    expect(Math.abs(winter - fair * 0.8)).toBeLessThanOrEqual(2);
    expect(winter).toBeLessThan(fair * 0.85);
  });
});
