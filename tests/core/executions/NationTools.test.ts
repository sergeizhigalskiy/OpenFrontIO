/**
 * Nations use every tool the human has (spec, Nation AI, the difficulty
 * ladder): the attack forecast to pick fronts, weighing defense posts,
 * spearheads, ruins, city-state ratios, blockade defence and rail cuts,
 * each by difficulty, read through Config.difficultyFor.
 */
import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { TerrainFeature } from "@openfront/engine-api/game/TerrainFeature";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { GameMapImpl } from "@openfront/engine-lib/game/GameMapImpl";
import { SEASON_CYCLE_TICKS } from "@openfront/engine-lib/game/Seasons";
import { packTerrainFeatures } from "@openfront/engine-lib/game/TerrainFeatures";
import { RuinReward } from "@openfront/engine-lib/game/WorldFeatures";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import {
  NATION_STALL_TICKS,
  NationAttackBehavior,
} from "@openfront/engine/execution/nation/NationAttackBehavior";
import {
  cheapestFrontTile,
  FrontIndex,
  FrontSurvey,
  NATION_CITY_FOCUS_RANGE,
  NATION_NECK_MAX_TILES,
  NATION_POST_FOCUS_SHARE,
  NATION_POST_FRONT_WEIGHT,
  NATION_RAIL_FOCUS_RANGE,
  neckFocus,
  postsCoverFront,
  railCutToRetake,
  railCutValue,
  railFocus,
  spearheadFocus,
  surveyFronts,
} from "@openfront/engine/execution/nation/NationSpearheads";
import {
  blockadeDefence,
  NATION_BLOCKADE_DEFENCE_BUILDS,
  NationWarshipBehavior,
} from "@openfront/engine/execution/nation/NationWarshipBehavior";
import {
  cityStateStrengthRatio,
  ISLAND_RUIN_BOAT_RANGE,
  islandRuinToSeek,
  prizeToSeek,
  ruinSeekRange,
  ruinToSeek,
} from "@openfront/engine/execution/nation/NationWorldFeatures";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { createGame as createGameImpl } from "@openfront/engine/game/GameImpl";
import { Railroad } from "@openfront/engine/game/Railroad";
import { TrainStation } from "@openfront/engine/game/TrainStation";
import { describe, expect, it, vi } from "vitest";
import { conquerRect } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { UseRealAttackLogic } from "../../util/TestConfig";
import { executeTicks } from "../../util/utils";
import {
  createGame as createFixtureGame,
  L,
  W,
} from "../pathfinding/_fixtures";

const DIFFICULTIES = [
  Difficulty.Easy,
  Difficulty.Medium,
  Difficulty.Hard,
  Difficulty.Impossible,
];

const nationInfo = (id: string) =>
  new PlayerInfo(id, PlayerType.Nation, null, id);

// Reserve, trigger and expand ratios 0: it sends everything it may.
function behaviorFor(game: Game, player: Player): NationAttackBehavior {
  return new NationAttackBehavior(
    new PseudoRandom(42),
    game,
    player,
    0,
    0,
    0,
    { maybeSendAllianceRequests: vi.fn(), maybeBetray: vi.fn() } as never,
    { maybeSendAttackEmoji: vi.fn(), sendEmoji: vi.fn() } as never,
    { clearSeaLane: vi.fn() } as never,
  );
}

/** The private parts of a nation's attack behavior these tests read. */
interface Inside {
  rankWeight(p: Player): number;
  worthwhileStack(target: Player, troops: number): number;
  reaimStalledAttacks(): void;
  retakeRailCut(): boolean;
  botAttackTroopsNeeded(bot: Player): number;
  botTileLoss(bot: Player, stack: number): number;
}
const inside = (b: NationAttackBehavior) => b as unknown as Inside;

/** The land attacks the game is sent from now on, with their focus tiles. */
function attacksSent(game: Game) {
  const spy = vi.spyOn(game, "addExecution");
  spy.mockClear();
  return () =>
    spy.mock.calls
      .map((c) => c[0])
      .filter((e): e is AttackExecution => e instanceof AttackExecution)
      .map((e) => ({
        target: e.targetID(),
        focus: (e as unknown as { focusTile: TileRef | null }).focusTile,
      }));
}

/** Plains, `nation` west of x = 50 and `enemy` east of it: a 100-tile front. */
async function splitPlains(difficulty: Difficulty) {
  const game = await setup(
    "plains",
    { difficulty },
    [nationInfo("nation"), nationInfo("enemy")],
    undefined,
    UseRealAttackLogic,
  );
  const nation = game.player("nation");
  const enemy = game.player("enemy");
  conquerRect(game, nation, 0, 0, 50, 100);
  conquerRect(game, enemy, 50, 0, 100, 100);
  nation.setTroops(500_000);
  enemy.setTroops(100_000);
  const front = () => surveyFronts(game, nation).get(enemy.smallID())!;
  return { game, nation, enemy, front };
}

const LAND_PLAINS = 0b10000000;
const LAND_MOUNTAIN = 0b10011000;

/**
 * A 60x60 map of plains, but east of x = 20 mountains at y < 20 and forest
 * at 20 <= y < 40: `nation` holds the west, `hills`, `woods` and `flats`
 * the three bands east of it, 800 tiles each.
 */
function terrainGame(difficulty: Difficulty) {
  const width = 60;
  const height = 60;
  const terrain = new Uint8Array(width * height);
  const features: TerrainFeature[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      terrain[y * width + x] = x >= 20 && y < 20 ? LAND_MOUNTAIN : LAND_PLAINS;
      features.push(
        x >= 20 && y >= 20 && y < 40
          ? TerrainFeature.Forest
          : TerrainFeature.None,
      );
    }
  }
  const mini = new Uint8Array((width / 2) * (height / 2)).fill(LAND_PLAINS);
  const gameConfig: GameConfig = {
    gameMap: GameMapType.Asia,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
    difficulty,
    nations: "default",
    donateGold: false,
    donateTroops: false,
    bots: 0,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: true,
    randomSpawn: false,
  };
  const game = createGameImpl(
    [],
    [],
    new GameMapImpl(
      width,
      height,
      terrain,
      width * height,
      packTerrainFeatures(features),
    ),
    new GameMapImpl(width / 2, height / 2, mini, (width * height) / 4),
    new UseRealAttackLogic(gameConfig, false),
  );
  game.endSpawnPhase();
  const [nation, hills, woods, flats] = [
    "nation",
    "hills",
    "woods",
    "flats",
  ].map((id) => game.addPlayer(nationInfo(id)));
  conquerRect(game, nation, 0, 0, 20, 60);
  conquerRect(game, hills, 20, 0, 60, 20);
  conquerRect(game, woods, 20, 20, 60, 40);
  conquerRect(game, flats, 20, 40, 60, 60);
  nation.setTroops(500_000);
  for (const p of [hills, woods, flats]) p.setTroops(40_000);
  return { game, nation, hills, woods, flats };
}

describe("picking fronts with the forecast", () => {
  it("targets are ranked by troops at every difficulty, whatever their terrain", () => {
    for (const difficulty of DIFFICULTIES) {
      const { game, nation, hills, woods, flats } = terrainGame(difficulty);
      const b = inside(behaviorFor(game, nation));
      const [h, w, f] = [hills, woods, flats].map((p) => b.rankWeight(p));
      expect([h, w], difficulty).toEqual([f, f]);
      hills.setTroops(10_000);
      expect(b.rankWeight(hills)).toBeLessThan(b.rankWeight(flats));
    }
  });

  it("the stack an attack needs comes from the forecast; Medium reads it without terrain features", () => {
    for (const difficulty of DIFFICULTIES) {
      const { game, nation, hills, woods, flats } = terrainGame(difficulty);
      const b = inside(behaviorFor(game, nation));
      const stack = (p: Player) => b.worthwhileStack(p, 100_000);
      // Mountains bleed 120 a tile where plains bleed 80: terrain, not a
      // terrain feature, so every difficulty prices it.
      expect(stack(hills) / stack(flats), difficulty).toBeCloseTo(1.5);
      // Forest is a feature: 1.2x the losses, except for Medium.
      expect(stack(woods) / stack(flats), difficulty).toBeCloseTo(
        difficulty === Difficulty.Medium ? 1 : 1.2,
      );
    }
  });
});

describe("weighing defense posts", () => {
  it("Hard and Impossible rank a front mostly under posts as twice as strong", async () => {
    for (const difficulty of DIFFICULTIES) {
      const { game, nation, enemy, front } = await splitPlains(difficulty);
      const b = inside(behaviorFor(game, nation));
      expect(b.rankWeight(enemy)).toBe(enemy.troops());
      // Covers y 22-78 of the 100-tile front at x = 50.
      enemy.buildUnit(UnitType.DefensePost, game.ref(60, 50), {});
      expect(postsCoverFront(game, enemy, front())).toBe(true);
      expect(b.rankWeight(enemy), difficulty).toBe(
        difficulty === Difficulty.Hard || difficulty === Difficulty.Impossible
          ? NATION_POST_FRONT_WEIGHT * enemy.troops()
          : enemy.troops(),
      );
    }
  });

  it("a post covering less than half the front doesn't double it", async () => {
    const { game, enemy, front } = await splitPlains(Difficulty.Hard);
    // Covers y 0-45: 46 of 100 front tiles.
    enemy.buildUnit(UnitType.DefensePost, game.ref(52, 15), {});
    expect(postsCoverFront(game, enemy, front())).toBe(false);
  });
});

describe("spearheads", () => {
  it("Easy never spearheads a player", async () => {
    const { game, nation, enemy, front } = await splitPlains(Difficulty.Easy);
    enemy.buildUnit(UnitType.DefensePost, game.ref(60, 50), {});
    enemy.buildUnit(UnitType.City, game.ref(70, 50), {});
    expect(
      spearheadFocus(game, nation, enemy, front(), Difficulty.Easy),
    ).toBeNull();
    const sent = attacksSent(game);
    expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(true);
    expect(sent()).toEqual([{ target: enemy.id(), focus: null }]);
  });

  it("Medium aims at the nearest post covering a quarter of the front, then at the best city", async () => {
    const { game, nation, enemy, front } = await splitPlains(Difficulty.Medium);
    expect(
      spearheadFocus(game, nation, enemy, front(), Difficulty.Medium),
    ).toBeNull();
    // Covers nothing of the front: too far behind it.
    enemy.buildUnit(UnitType.DefensePost, game.ref(90, 10), {});
    expect(
      spearheadFocus(game, nation, enemy, front(), Difficulty.Medium),
    ).toBeNull();
    // A city 20 tiles behind the front.
    const city = enemy.buildUnit(UnitType.City, game.ref(70, 50), {});
    expect(
      spearheadFocus(game, nation, enemy, front(), Difficulty.Medium),
    ).toBe(city.tile());
    // 47% of the front, 15 tiles back; and 57%, 10 tiles back.
    enemy.buildUnit(UnitType.DefensePost, game.ref(65, 20), {});
    const near = enemy.buildUnit(UnitType.DefensePost, game.ref(60, 50), {});
    expect(NATION_POST_FOCUS_SHARE).toBe(0.25);
    expect(
      spearheadFocus(game, nation, enemy, front(), Difficulty.Medium),
    ).toBe(near.tile());
    const sent = attacksSent(game);
    expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(true);
    expect(sent()).toEqual([{ target: enemy.id(), focus: near.tile() }]);
  });

  it("a post covering less than a quarter is no spearhead target", async () => {
    const { game, nation, enemy, front } = await splitPlains(Difficulty.Medium);
    // dx 28: covers y 40-60, 21 of 100 front tiles.
    enemy.buildUnit(UnitType.DefensePost, game.ref(78, 50), {});
    expect(
      spearheadFocus(game, nation, enemy, front(), Difficulty.Medium),
    ).toBeNull();
  });

  it("Medium and up aim at the best city within 40 tiles of the front", async () => {
    expect(NATION_CITY_FOCUS_RANGE).toBe(40);
    for (const difficulty of [
      Difficulty.Medium,
      Difficulty.Hard,
      Difficulty.Impossible,
    ]) {
      const { game, nation, enemy, front } = await splitPlains(difficulty);
      enemy.buildUnit(UnitType.City, game.ref(95, 50), {}); // 45 back
      expect(spearheadFocus(game, nation, enemy, front(), difficulty)).toBe(
        null,
      );
      const near = enemy.buildUnit(UnitType.City, game.ref(70, 30), {});
      const best = enemy.buildUnit(UnitType.City, game.ref(85, 60), {});
      best.increaseLevel();
      expect(spearheadFocus(game, nation, enemy, front(), difficulty)).toBe(
        best.tile(),
      );
      expect(near.level()).toBe(1);
      // A post covering the front comes first.
      const post = enemy.buildUnit(UnitType.DefensePost, game.ref(60, 50), {});
      expect(spearheadFocus(game, nation, enemy, front(), difficulty)).toBe(
        post.tile(),
      );
    }
  });

  /**
   * big_plains: the enemy holds x >= 120 and a 7-tile-wide strip poking
   * west into our land, x 90-119, y 97-103.
   */
  async function strip(difficulty: Difficulty) {
    const game = await setup(
      "big_plains",
      { difficulty },
      [nationInfo("nation"), nationInfo("enemy")],
      undefined,
      UseRealAttackLogic,
    );
    const nation = game.player("nation");
    const enemy = game.player("enemy");
    conquerRect(game, nation, 0, 0, 120, 200);
    conquerRect(game, enemy, 120, 0, 200, 200);
    conquerRect(game, enemy, 90, 97, 120, 104);
    const front = (x: number, y: number): FrontSurvey => ({
      owner: enemy.smallID(),
      tiles: [game.ref(x, y)],
    });
    return { game, nation, enemy, front };
  }

  it("Hard aims at a neck of at most 12 tiles that cuts off an annexable pocket", async () => {
    expect(NATION_NECK_MAX_TILES).toBe(12);
    const { game, nation, enemy, front } = await strip(Difficulty.Hard);
    const neck = neckFocus(game, nation, enemy, front(100, 97));
    expect(neck).not.toBeNull();
    expect(game.ownerID(neck!)).toBe(enemy.smallID());
    expect(game.x(neck!)).toBeGreaterThan(100);
    expect(game.x(neck!)).toBeLessThan(120);
    expect(game.y(neck!)).toBeGreaterThanOrEqual(97);
    expect(game.y(neck!)).toBeLessThanOrEqual(103);
    // A straight stretch of front is no neck.
    expect(neckFocus(game, nation, enemy, front(120, 50))).toBeNull();
    expect(
      spearheadFocus(game, nation, enemy, front(100, 97), Difficulty.Hard),
    ).toBe(neck);
    expect(
      spearheadFocus(game, nation, enemy, front(100, 97), Difficulty.Medium),
    ).toBeNull();
  });

  it("a pocket another player borders is no neck: it wouldn't be annexed", async () => {
    const { game, nation, enemy, front } = await strip(Difficulty.Hard);
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    // Against the strip's tip at x = 90.
    conquerRect(game, tribe, 85, 95, 90, 106);
    expect(neckFocus(game, nation, enemy, front(100, 97))).toBeNull();
  });

  /**
   * Plains, the enemy east of x = 50. Its factories at (95, 10) and (95, 90)
   * are 45 tiles behind the front, their rail along x = 60 only 10.
   */
  async function railOverFront(difficulty: Difficulty) {
    const p = await splitPlains(difficulty);
    const { game, enemy } = p;
    const a = station(game, enemy, UnitType.Factory, 95, 10);
    const b = station(game, enemy, UnitType.Factory, 95, 90);
    const tiles: TileRef[] = [];
    for (let x = 95; x > 60; x--) tiles.push(game.ref(x, 10));
    for (let y = 10; y < 90; y++) tiles.push(game.ref(60, y));
    for (let x = 60; x <= 95; x++) tiles.push(game.ref(x, 90));
    rail(a, b, tiles, 1);
    return p;
  }

  it("Hard and Impossible aim at an enemy rail within 30 tiles of the front", async () => {
    expect(NATION_RAIL_FOCUS_RANGE).toBe(30);
    for (const difficulty of [Difficulty.Hard, Difficulty.Impossible]) {
      const { game, nation, enemy, front } = await railOverFront(difficulty);
      const focus = spearheadFocus(game, nation, enemy, front(), difficulty);
      expect(focus).not.toBeNull();
      expect(game.x(focus!)).toBe(60);
    }
    const medium = await railOverFront(Difficulty.Medium);
    expect(
      spearheadFocus(
        medium.game,
        medium.nation,
        medium.enemy,
        medium.front(),
        Difficulty.Medium,
      ),
    ).toBeNull();
  });

  it("Impossible picks the cut that splits off the most stations", async () => {
    const { game, enemy, front } = await splitPlains(Difficulty.Impossible);
    // Cities a-b-c-d down x = 80, 30 tiles behind the front.
    const [a, b, c, d] = [10, 30, 50, 70].map((y) =>
      station(game, enemy, UnitType.City, 80, y),
    );
    const line = (s: TrainStation, t: TrainStation, id: number) => {
      const tiles: TileRef[] = [];
      for (let y = game.y(s.tile()); y <= game.y(t.tile()); y++) {
        tiles.push(game.ref(80, y));
      }
      return rail(s, t, tiles, id);
    };
    const ab = line(a, b, 1);
    const bc = line(b, c, 2);
    const cd = line(c, d, 3);
    expect([ab, bc, cd].map(railCutValue)).toEqual([1, 2, 1]);
    const index = new FrontIndex(game, front().tiles);
    const nearest = railFocus(game, enemy, index, false)!;
    const best = railFocus(game, enemy, index, true)!;
    expect(ab.tiles).toContain(nearest);
    expect(bc.tiles).toContain(best);
    // With a second route between b and c, cutting b-c splits nothing.
    line(b, c, 4);
    expect(railCutValue(bc)).toBe(0);
  });

  it("Impossible re-aims a stalled attack at the cheapest front tile", async () => {
    for (const difficulty of [Difficulty.Hard, Difficulty.Impossible]) {
      const { game, nation, enemy, front } = await splitPlains(difficulty);
      enemy.buildUnit(UnitType.DefensePost, game.ref(60, 50), {});
      // An attack held on its front: nothing moves it.
      const border = new Set(front().tiles);
      nation.createAttack(enemy, 10_000, null, border);
      const b = inside(behaviorFor(game, nation));
      const sent = attacksSent(game);
      b.reaimStalledAttacks();
      expect(sent()).toEqual([]);
      executeTicks(game, NATION_STALL_TICKS);
      b.reaimStalledAttacks();
      if (difficulty === Difficulty.Hard) {
        expect(sent()).toEqual([]);
        continue;
      }
      const tile = cheapestFrontTile(game, nation, enemy, front(), 10_000);
      expect(tile).not.toBeNull();
      // Not under the post.
      expect(
        game.euclideanDistSquared(tile!, game.ref(60, 50)),
      ).toBeGreaterThan(30 * 30);
      expect(sent()).toEqual([{ target: enemy.id(), focus: tile }]);
    }
  });

  it("an attack that moves on is not re-aimed", async () => {
    const { game, nation, enemy, front } = await splitPlains(
      Difficulty.Impossible,
    );
    const tiles = front().tiles;
    nation.createAttack(enemy, 10_000, null, new Set(tiles));
    const b = inside(behaviorFor(game, nation));
    const sent = attacksSent(game);
    b.reaimStalledAttacks();
    for (const t of tiles) nation.conquer(t);
    executeTicks(game, NATION_STALL_TICKS);
    b.reaimStalledAttacks();
    expect(sent()).toEqual([]);
  });
});

function station(
  game: Game,
  owner: Player,
  type: UnitType,
  x: number,
  y: number,
): TrainStation {
  const unit = owner.buildUnit(type, game.ref(x, y), {});
  unit.setTrainStation(true);
  const s = new TrainStation(game, unit);
  game.railNetwork().stationManager().addStation(s);
  return s;
}

function rail(
  from: TrainStation,
  to: TrainStation,
  tiles: TileRef[],
  id: number,
): Railroad {
  const r = new Railroad(from, to, tiles, 1000 + id);
  from.addRailroad(r);
  to.addRailroad(r);
  return r;
}

describe("ruins", () => {
  it("nations go for ruins within 15, 40, 80 and 120 tiles", () => {
    expect(DIFFICULTIES.map(ruinSeekRange)).toEqual([15, 40, 80, 120]);
    expect(ISLAND_RUIN_BOAT_RANGE).toBe(60);
  });

  /** big_plains: the nation's land fills x, y 20-39. */
  async function nationAt(difficulty: Difficulty) {
    const game = await setup("big_plains", { difficulty }, [
      nationInfo("nation"),
    ]);
    const nation = game.player("nation");
    conquerRect(game, nation, 20, 20, 40, 40);
    nation.largestClusterBoundingBox = {
      min: { x: 20, y: 20 } as never,
      max: { x: 39, y: 39 } as never,
    };
    nation.setTroops(100_000);
    return { game, nation };
  }

  it("each difficulty goes for a ruin only within its range", async () => {
    // Ruins 10, 20, 50, 100 and 130 tiles past the nation's land.
    for (const [i, difficulty] of DIFFICULTIES.entries()) {
      const { game, nation } = await nationAt(difficulty);
      const gaps = [10, 20, 50, 100, 130];
      game.addRuins(
        gaps.map((g) => ({
          tile: game.ref(39 + g, 30),
          reward: RuinReward.Gold,
        })),
      );
      const reach = gaps.filter((g) => g <= ruinSeekRange(difficulty));
      expect(reach.length, difficulty).toBe(i + 1);
      // The nearest in range first; claim it and the next comes up.
      for (const g of reach) {
        const tile = game.ref(39 + g, 30);
        expect(ruinToSeek(game, nation)).toBe(tile);
        nation.conquer(tile);
      }
      expect(ruinToSeek(game, nation)).toBeNull();
    }
  });

  it("nations go after a ruin a tribe sits on, and that tribe first", async () => {
    const { game, nation } = await nationAt(Difficulty.Easy);
    const ally = game.addPlayer(
      new PlayerInfo("ally", PlayerType.Human, "c_ally", "ally"),
    );
    const tribe = (id: string, x0: number) => {
      const t = game.addPlayer(new PlayerInfo(id, PlayerType.Bot, null, id));
      conquerRect(game, t, x0, 20, x0 + 5, 40);
      t.setTroops(1_000);
      return t;
    };
    const plain = tribe("plain", 15);
    const sitting = tribe("sitting", 40);
    // The sitting tribe is denser, so it would come second on its own.
    sitting.setTroops(5_000);
    // No free land: everything else is an ally's.
    game.forEachTile((t) => {
      if (game.isLand(t) && !game.hasOwner(t)) ally.conquer(t);
    });
    nation.createAllianceRequest(ally)!.accept();
    const ruin = game.ref(42, 30);
    game.addRuins([{ tile: ruin, reward: RuinReward.Gold }]);
    expect(prizeToSeek(game, nation, sitting.smallID())).toBe(ruin);
    expect(prizeToSeek(game, nation, plain.smallID())).toBeNull();
    // Free-land expansion doesn't aim at it: it isn't free land.
    expect(ruinToSeek(game, nation)).toBeNull();
    const sent = attacksSent(game);
    behaviorFor(game, nation).maybeAttack();
    // Easy attacks one tribe at a time: the one on the ruin, at the ruin.
    expect(sent()).toEqual([{ target: sitting.id(), focus: ruin }]);
  });

  it("Impossible boats to a ruin on an island within 60 tiles", () => {
    // Mainland x < 40, sea, an island at x 60-74, y 10-24.
    const width = 100;
    const height = 40;
    const grid: string[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const island = x >= 60 && x < 75 && y >= 10 && y < 25;
        grid.push(x < 40 || island ? L : W);
      }
    }
    for (const difficulty of DIFFICULTIES) {
      const game = createFixtureGame({ width, height, grid }, { difficulty });
      const nation = game.addPlayer(nationInfo("nation"));
      conquerRect(game, nation, 0, 0, 30, 40);
      nation.largestClusterBoundingBox = {
        min: { x: 0, y: 0 } as never,
        max: { x: 29, y: 39 } as never,
      };
      const mainland = game.ref(35, 15);
      const island = game.ref(65, 15); // 36 tiles out
      game.addRuins([
        { tile: mainland, reward: RuinReward.Gold },
        { tile: island, reward: RuinReward.Gold },
      ]);
      expect(islandRuinToSeek(game, nation), difficulty).toBe(
        difficulty === Difficulty.Impossible ? island : null,
      );
    }
  });
});

describe("city-states", () => {
  it("nations attack one at 3.0x, 2.0x, 1.6x and 1.3x its garrison", () => {
    expect(DIFFICULTIES.map(cityStateStrengthRatio)).toEqual([3, 2, 1.6, 1.3]);
  });

  it("the troops a city-state needs count its full rate and its 20-tile threshold", async () => {
    const game = await setup(
      "plains",
      { difficulty: Difficulty.Hard },
      [nationInfo("nation")],
      undefined,
      UseRealAttackLogic,
    );
    const nation = game.player("nation");
    conquerRect(game, nation, 0, 0, 50, 100);
    const bot = (id: string, cityState: boolean, x0: number) => {
      const p = game.addPlayer(new PlayerInfo(id, PlayerType.Bot, null, id));
      conquerRect(game, p, x0, 0, x0 + 6, 5); // 30 tiles
      p.setTroops(3_000);
      if (cityState) vi.spyOn(p, "isCityState").mockReturnValue(true);
      return p;
    };
    const tribe = bot("tribe", false, 60);
    const cs = bot("cs", true, 80);
    const b = inside(behaviorFor(game, nation));
    const stack = 5_000;
    expect(b.botTileLoss(cs, stack) * 0.7).toBeCloseTo(
      b.botTileLoss(tribe, stack),
    );
    // 30 tiles: a tribe falls below 100 already, a city-state has 10 to go.
    expect(b.botAttackTroopsNeeded(tribe)).toBeCloseTo(3_000 / 0.6);
    expect(b.botAttackTroopsNeeded(cs)).toBeCloseTo(
      Math.max(3_000 / 0.6, 10 * b.botTileLoss(cs, 3_000 / 0.6)),
    );
  });
});

describe("blockade defence", () => {
  /**
   * World map, west coast of Africa: the nation's port at (860, 460), an
   * enemy warship at war blockading it, and the nation's warships about 200
   * tiles out in the Atlantic.
   */
  async function blockaded(difficulty: Difficulty, ships: number) {
    const game = await setup("world", { difficulty, instantBuild: true }, [
      nationInfo("nation"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy"),
    ]);
    const nation = game.player("nation");
    const enemy = game.player("enemy");
    nation.conquer(game.ref(860, 460));
    enemy.conquer(game.ref(900, 470));
    nation.buildUnit(UnitType.Port, game.ref(860, 460), {});
    let x = 860;
    while (!game.isWater(game.ref(x, 460))) x--;
    const at = game.ref(x - 5, 460);
    expect(game.isWater(at)).toBe(true);
    const blockader = enemy.buildUnit(UnitType.Warship, at, { patrolTile: at });
    enemy.createAttack(nation, 100, null, new Set());
    const fleet: Unit[] = [];
    for (const [fx, fy] of [
      [655, 460],
      [645, 455],
      [635, 465],
    ].slice(0, ships)) {
      const t = game.ref(fx, fy);
      expect(game.isWater(t)).toBe(true);
      fleet.push(nation.buildUnit(UnitType.Warship, t, { patrolTile: t }));
    }
    nation.addGold(50_000_000n);
    const behavior = new NationWarshipBehavior(
      new PseudoRandom(1),
      game,
      nation,
      {
        maybeSendEmoji: vi.fn(),
        sendEmoji: vi.fn(),
      } as never,
    );
    const builds = vi.spyOn(game, "addExecution");
    builds.mockClear();
    const built = () =>
      builds.mock.calls.filter((c) => c[0] instanceof ConstructionExecution)
        .length;
    const sentAt = () =>
      fleet.filter((s) => s.warshipState().patrolTile === blockader.tile());
    return { game, behavior, fleet, sentAt, built };
  }

  it("each difficulty sends its share of warships at the blockader", async () => {
    expect(NATION_BLOCKADE_DEFENCE_BUILDS).toBe(2);
    for (const [difficulty, sent] of [
      [Difficulty.Easy, 0],
      [Difficulty.Medium, 1],
      [Difficulty.Hard, 2],
      [Difficulty.Impossible, 3],
    ] as const) {
      const { behavior, fleet, sentAt, built } = await blockaded(difficulty, 3);
      behavior.defendBlockades();
      expect(sentAt().length, difficulty).toBe(sent);
      // The nearest go.
      expect(sentAt()).toEqual(fleet.slice(0, sent));
      expect(built()).toBe(0);
      // Covered: nothing more next time.
      behavior.defendBlockades();
      expect(sentAt().length).toBe(sent);
    }
  });

  it("Hard builds one when it has none, Impossible up to two", async () => {
    for (const [difficulty, builds] of [
      [Difficulty.Easy, 0],
      [Difficulty.Medium, 0],
      [Difficulty.Hard, 1],
      [Difficulty.Impossible, 2],
    ] as const) {
      const { behavior, built } = await blockaded(difficulty, 0);
      behavior.defendBlockades();
      expect(built(), difficulty).toBe(builds);
    }
    const one = await blockaded(Difficulty.Impossible, 1);
    one.behavior.defendBlockades();
    expect(one.sentAt().length).toBe(1);
    expect(one.built()).toBe(1);
    expect(blockadeDefence(Difficulty.Hard).buildWithNone).toBe(1);
  });
});

describe("rail cuts", () => {
  /**
   * Plains: the nation's cities a-b-c-d-e along y = 10 (x 0 to 80, 20
   * apart), joined a-b, b-c, c-d, d-e. The enemy, south of the line, takes
   * the tiles at `cuts`.
   */
  async function cutLine(difficulty: Difficulty, cuts: number[] = [30]) {
    const game = await setup(
      "plains",
      { difficulty, instantBuild: true },
      [nationInfo("nation"), nationInfo("enemy")],
      undefined,
      UseRealAttackLogic,
    );
    const nation = game.player("nation");
    const enemy = game.player("enemy");
    conquerRect(game, nation, 0, 0, 100, 11);
    conquerRect(game, enemy, 0, 11, 100, 100);
    nation.setTroops(500_000);
    enemy.setTroops(50_000);
    const [a, b, c, d, e] = [0, 20, 40, 60, 80].map((x) =>
      station(game, nation, UnitType.City, x, 10),
    );
    const line = (s: TrainStation, t: TrainStation, id: number) => {
      const tiles: TileRef[] = [];
      for (let x = game.x(s.tile()); x <= game.x(t.tile()); x++) {
        tiles.push(game.ref(x, 10));
      }
      return rail(s, t, tiles, id);
    };
    const rails = [line(a, b, 1), line(b, c, 2), line(c, d, 3), line(d, e, 4)];
    game.railNetwork().refreshCuts();
    for (const x of cuts) enemy.conquer(game.ref(x, 10));
    game.railNetwork().refreshCuts();
    return { game, nation, enemy, rails };
  }

  it("Medium and up retake a cut tile first; Easy ignores it", async () => {
    for (const difficulty of DIFFICULTIES) {
      const { game, nation, enemy, rails } = await cutLine(difficulty);
      expect(rails[1].cutTiles).toEqual([game.ref(30, 10)]);
      const b = inside(behaviorFor(game, nation));
      const sent = attacksSent(game);
      expect(b.retakeRailCut(), difficulty).toBe(
        difficulty !== Difficulty.Easy,
      );
      expect(sent()).toEqual(
        difficulty === Difficulty.Easy
          ? []
          : [{ target: enemy.id(), focus: game.ref(30, 10) }],
      );
    }
  });

  it("retaking a cut tile is never held by winter", async () => {
    const { game, nation, enemy } = await cutLine(Difficulty.Medium);
    // The line is in the northern snow band; Medium holds big pushes into it.
    vi.spyOn(game, "ticksSinceStart").mockReturnValue(SEASON_CYCLE_TICKS + 100);
    expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(false);
    const sent = attacksSent(game);
    expect(inside(behaviorFor(game, nation)).retakeRailCut()).toBe(true);
    expect(sent().map((s) => s.target)).toEqual([enemy.id()]);
  });

  it("Impossible retakes the most valuable cut first", async () => {
    for (const difficulty of [Difficulty.Hard, Difficulty.Impossible]) {
      const { game, nation, rails } = await cutLine(difficulty, [10, 50]);
      // Cut a-b and c-d leave {a}, {b, c} and {d, e}: repairing c-d joins
      // two stations back, a-b only one.
      expect(rails.map(railCutValue)).toEqual([1, 1, 2, 1]);
      const cut = railCutToRetake(
        game,
        nation,
        difficulty === Difficulty.Impossible,
      )!;
      expect(cut.tile).toBe(
        game.ref(difficulty === Difficulty.Impossible ? 50 : 10, 10),
      );
    }
  });
});

describe("the difficulty a nation plays at", () => {
  it("every behaviour reads Config.difficultyFor, so a stacked team's nation plays harder", async () => {
    const game = await setup("big_plains", { difficulty: Difficulty.Medium }, [
      nationInfo("nation"),
    ]);
    const nation = game.player("nation");
    conquerRect(game, nation, 20, 20, 40, 40);
    nation.largestClusterBoundingBox = {
      min: { x: 20, y: 20 } as never,
      max: { x: 39, y: 39 } as never,
    };
    const ruin = game.ref(99, 30); // 60 tiles out: Hard's range, not Medium's
    game.addRuins([{ tile: ruin, reward: RuinReward.Gold }]);
    expect(ruinToSeek(game, nation)).toBeNull();
    vi.spyOn(game.config(), "difficultyFor").mockImplementation((p) =>
      p === nation ? Difficulty.Hard : Difficulty.Medium,
    );
    expect(ruinToSeek(game, nation)).toBe(ruin);
  });
});
