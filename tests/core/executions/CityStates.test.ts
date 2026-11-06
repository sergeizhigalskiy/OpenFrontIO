import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Cell,
  Difficulty,
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PlayerUpdate } from "@openfront/engine-api/game/GameUpdates";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  attackLogic,
  AttackLogicInput,
} from "@openfront/engine-lib/game/AttackLogic";
import {
  CITY_STATE_CAPTURED_CITY_LEVEL,
  CITY_STATE_CITY_LEVEL,
  CITY_STATE_CONQUEST_GOLD,
  CITY_STATE_ELIMINATION_TILES,
  CITY_STATE_GARRISON_MULTIPLIER,
  CITY_STATE_MIN_DISTANCE,
  CITY_STATE_RADIUS,
  CITY_STATES_MAX_COUNT,
  CITY_STATES_MIN_COUNT,
  cityStateCount,
  PLAYERS_PER_CITY_STATE,
} from "@openfront/engine-lib/game/WorldFeatures";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  CITY_STATE_DEFENSE_POST_OFFSET,
  CityStateExecution,
} from "@openfront/engine/execution/CityStateExecution";
import { CityStateSpawner } from "@openfront/engine/execution/CityStateSpawner";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { RuinsExecution } from "@openfront/engine/execution/RuinsExecution";
import { TribeAttackBehavior } from "@openfront/engine/execution/TribeAttackBehavior";
import { TribeExecution } from "@openfront/engine/execution/TribeExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { humanAndNationCount } from "@openfront/engine/game/StartPlacements";
import { GameRunner } from "@openfront/engine/GameRunner";
import { conquerRect, setGold } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

// big_plains: 200x200 tiles of open land.
const MAP = "big_plains";
const GAME_ID = "city_states_game";
const NATION_CELLS = [new Cell(40, 40), new Cell(160, 160)];

/** Tiles in a full-land disc of CITY_STATE_RADIUS. */
function discSize(): number {
  let n = 0;
  const r = CITY_STATE_RADIUS;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) n++;
  }
  return n;
}

function center(exec: CityStateExecution): TileRef {
  return (exec as unknown as { center: TileRef }).center;
}

function nameOf(exec: CityStateExecution): string {
  return (exec as unknown as { playerInfo: PlayerInfo }).playerInfo.name;
}

/** A city-state founded at (x, y), with a human `a` and its land. */
async function founded(
  x = 100,
  y = 100,
  config: Partial<GameConfig> = {},
): Promise<{ game: Game; a: Player; cs: Player }> {
  const game = await setup(MAP, config, [
    new PlayerInfo("a", PlayerType.Human, "c_a", "a"),
  ]);
  const info = new PlayerInfo("Aldmere", PlayerType.Bot, null, "cs_id");
  game.addExecution(new CityStateExecution(info, game.ref(x, y)));
  executeTicks(game, 2);
  return { game, a: game.player("a"), cs: game.player("cs_id") };
}

describe("city-states: placement", () => {
  test("one per 8 humans and nations, clamped to 2-6", () => {
    expect(PLAYERS_PER_CITY_STATE).toBe(8);
    expect(CITY_STATES_MIN_COUNT).toBe(2);
    expect(CITY_STATES_MAX_COUNT).toBe(6);
    expect(cityStateCount(0)).toBe(2);
    // A duel, and Iceland's 8 nations and a human.
    expect(cityStateCount(2)).toBe(2);
    expect(cityStateCount(9)).toBe(2);
    expect(cityStateCount(24)).toBe(3);
    expect(cityStateCount(40)).toBe(5);
    // World: 72 nations and a human.
    expect(cityStateCount(73)).toBe(6);
  });

  test("the spawner counts the game's humans and nations", async () => {
    const humans = Array.from(
      { length: 24 },
      (_, i) => new PlayerInfo(`h${i}`, PlayerType.Human, `c${i}`, `h${i}`),
    );
    const game = await setup(MAP, {}, humans);
    expect(humanAndNationCount(game)).toBe(24);
    const execs = new CityStateSpawner(
      game,
      GAME_ID,
      NATION_CELLS,
      [],
    ).spawnCityStates();
    expect(execs).toHaveLength(3);
  });

  test("they sit on land, 40 tiles from every nation spawn cell and each other", async () => {
    const game = await setup(MAP);
    const execs = new CityStateSpawner(
      game,
      GAME_ID,
      NATION_CELLS,
      [],
    ).spawnCityStates();
    expect(execs).toHaveLength(cityStateCount(humanAndNationCount(game)));
    const centers = execs.map(center);
    for (const c of centers) {
      expect(game.isLand(c)).toBe(true);
      for (const cell of NATION_CELLS) {
        const d = game.euclideanDistSquared(c, game.ref(cell.x, cell.y));
        expect(Math.sqrt(d)).toBeGreaterThanOrEqual(CITY_STATE_MIN_DISTANCE);
      }
      for (const o of centers) {
        if (o === c) continue;
        expect(
          Math.sqrt(game.euclideanDistSquared(c, o)),
        ).toBeGreaterThanOrEqual(CITY_STATE_MIN_DISTANCE);
      }
    }
    // Names from the default list, none twice.
    const names = execs.map(nameOf);
    expect(new Set(names).size).toBe(names.length);
  });

  test("the same game id places the same city-states", async () => {
    const game = await setup(MAP);
    const spawn = (id: string) =>
      new CityStateSpawner(game, id, NATION_CELLS, []).spawnCityStates();
    const first = spawn(GAME_ID);
    expect(spawn(GAME_ID).map(center)).toEqual(first.map(center));
    expect(spawn(GAME_ID).map(nameOf)).toEqual(first.map(nameOf));
    expect(spawn("other_game").map(center)).not.toEqual(first.map(center));
  });

  test("static custom_tribes entries are city-states: at their coordinates, or named", async () => {
    const game = await setup(MAP);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const execs = new CityStateSpawner(game, GAME_ID, NATION_CELLS, [
      { name: "Freeport", coordinates: [100, 100], static: true },
      { name: "Hollowmere", static: true },
      { name: "Sunk", coordinates: [999, 999], static: true },
      { name: "Plain Tribe" },
    ]).spawnCityStates();
    expect(nameOf(execs[0])).toBe("Freeport");
    // Hand-placed exactly where the map says, even near a nation.
    expect(center(execs[0])).toBe(game.ref(100, 100));
    const names = execs.map(nameOf);
    expect(names).toContain("Hollowmere");
    expect(names).not.toContain("Sunk");
    expect(names).not.toContain("Plain Tribe");
    expect(warn).toHaveBeenCalled();
    // They count toward the game's total.
    expect(execs).toHaveLength(cityStateCount(humanAndNationCount(game)));
  });
});

describe("city-states: founding", () => {
  test("a disc of land, a level-2 city at the center and a defense post next to it", async () => {
    const { game, cs } = await founded();
    expect(cs.type()).toBe(PlayerType.Bot);
    expect(cs.isCityState()).toBe(true);
    // The view is told with its first update.
    expect(
      (cs as unknown as { lastSentUpdate: PlayerUpdate }).lastSentUpdate
        .isCityState,
    ).toBe(true);
    expect(cs.numTilesOwned()).toBe(discSize());
    expect(cs.spawnTile()).toBe(game.ref(100, 100));

    const cities = cs.units(UnitType.City);
    expect(cities).toHaveLength(1);
    expect(cities[0].tile()).toBe(game.ref(100, 100));
    expect(cities[0].level()).toBe(CITY_STATE_CITY_LEVEL);
    const posts = cs.units(UnitType.DefensePost);
    expect(posts).toHaveLength(1);
    expect(game.owner(posts[0].tile())).toBe(cs);
    expect(posts[0].tile()).not.toBe(cities[0].tile());
    // Next to the city, so a spearhead at the post crosses 6 tiles of cover.
    expect(CITY_STATE_DEFENSE_POST_OFFSET).toBe(1);
    expect(game.euclideanDistSquared(posts[0].tile(), cities[0].tile())).toBe(
      1,
    );

    // A tribe's PlayerExecution, never a TribeExecution.
    const execs = game.executions();
    expect(execs.some((e) => e instanceof TribeExecution)).toBe(false);
    expect(execs.some((e) => e instanceof PlayerExecution)).toBe(true);
  });

  test("its garrison is 3x what a tribe holding as much land gets, and starts full", async () => {
    const { game, cs } = await founded();
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    conquerRect(game, tribe, 0, 0, 10, 15);
    while (tribe.numTilesOwned() > cs.numTilesOwned()) {
      tribe.relinquish(tribe.tiles().values().next().value!);
    }
    expect(tribe.numTilesOwned()).toBe(cs.numTilesOwned());

    const config = game.config();
    expect(config.maxTroops(cs)).toBeCloseTo(
      CITY_STATE_GARRISON_MULTIPLIER * config.maxTroops(tribe),
    );
    // Its own city adds nothing to it.
    expect(config.maxTroops(cs)).toBe(config.maxTroopsWithoutCities(cs));
    expect(cs.troops()).toBe(Math.floor(config.maxTroops(cs)));
  });

  test("it never expands or attacks, and keeps its buildings", async () => {
    const { game, a, cs } = await founded();
    // A neighbor and free land all around.
    conquerRect(game, a, 100, 108, 140, 140);
    a.setTroops(1_000);
    game.addExecution(new PlayerExecution(a));
    const tiles = [...cs.tiles()].sort();
    let attacks = 0;
    for (let i = 0; i < 600; i++) {
      game.executeNextTick();
      attacks += cs.outgoingAttacks().length;
    }
    expect(attacks).toBe(0);
    expect([...cs.tiles()].sort()).toEqual(tiles);
    expect(cs.units(UnitType.City)).toHaveLength(1);
    expect(cs.units(UnitType.DefensePost)).toHaveLength(1);
  });

  test("it can't ally, trade or be donated to", async () => {
    const { a, cs } = await founded(100, 100, {
      donateGold: true,
      donateTroops: true,
    });
    expect(a.canSendAllianceRequest(cs)).toBe(false);
    expect(cs.canSendAllianceRequest(a)).toBe(false);
    expect(a.canTrade(cs)).toBe(false);
    expect(cs.canTrade(a)).toBe(false);
    expect(a.canDonateGold(cs)).toBe(false);
    expect(a.canDonateTroops(cs)).toBe(false);
    expect(cs.canDonateGold(a)).toBe(false);
  });

  test("tribes leave it alone", async () => {
    const { game, cs } = await founded();
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    conquerRect(game, tribe, 100, 108, 110, 120);
    tribe.setTroops(1_000_000);
    expect(tribe.nearby()).toContain(cs);
    const behavior = new TribeAttackBehavior(
      new PseudoRandom(5),
      game,
      tribe,
      0,
      0,
      0,
    );
    const added = vi.spyOn(game, "addExecution");
    for (let i = 0; i < 50; i++) behavior.attackRandomTarget();
    const targets = added.mock.calls
      .map(([e]) => e)
      .filter((e) => e instanceof AttackExecution)
      .map((e) => (e as AttackExecution).targetID());
    expect(targets).not.toContain(cs.id());
  });

  // Encircled land changes hands in PlayerExecution.removeClusters. City-states
  // never take land, so they must never be the captor; otherwise they win
  // pockets on border length alone and snowball across the map.
  function runAnnexation(game: Game, player: Player): void {
    const exec = new PlayerExecution(player);
    exec.init(game, 0);
    (exec as unknown as { removeClusters(): void }).removeClusters();
  }

  test("a city-state ringed by one player keeps its land; a tribe ringed the same way is annexed", async () => {
    const { game, a, cs } = await founded();
    // a holds everything around the disc, two tiles deep.
    for (let x = 90; x <= 110; x++) {
      for (let y = 90; y <= 110; y++) {
        const t = game.ref(x, y);
        if (game.owner(t) !== cs) a.conquer(t);
      }
    }
    const csTiles = cs.numTilesOwned();
    expect(csTiles).toBe(discSize());
    runAnnexation(game, cs);
    expect(cs.isAlive()).toBe(true);
    expect(cs.numTilesOwned()).toBe(csTiles);
    // Its own PlayerExecution's cluster passes leave it alone too.
    executeTicks(game, 45);
    expect(cs.isAlive()).toBe(true);
    expect(cs.numTilesOwned()).toBe(csTiles);

    const tribe = game.addPlayer(
      new PlayerInfo("ringed", PlayerType.Bot, null, "ringed"),
    );
    conquerRect(game, a, 20, 20, 41, 41);
    conquerRect(game, tribe, 23, 23, 38, 38);
    expect(tribe.numTilesOwned()).toBe(225);
    runAnnexation(game, tribe);
    expect(tribe.isAlive()).toBe(false);
    expect(tribe.numTilesOwned()).toBe(0);
  });

  test("a player ringed by a city-state alone is not annexed by it", async () => {
    const { game, cs } = await founded();
    const tribe = game.addPlayer(
      new PlayerInfo("ringed", PlayerType.Bot, null, "ringed"),
    );
    conquerRect(game, cs, 150, 20, 166, 36);
    conquerRect(game, tribe, 155, 25, 161, 31);
    const csTiles = cs.numTilesOwned();
    const tribeTiles = tribe.numTilesOwned();

    runAnnexation(game, tribe);

    expect(tribe.isAlive()).toBe(true);
    expect(tribe.numTilesOwned()).toBe(tribeTiles);
    expect(cs.numTilesOwned()).toBe(csTiles);
  });

  test("a pocket a city-state mostly borders goes to the other neighbor", async () => {
    const { game, a, cs } = await founded();
    const tribe = game.addPlayer(
      new PlayerInfo("pocketed", PlayerType.Bot, null, "pocketed"),
    );
    // The tribe's main body sits on open land; its pocket is walled in by the
    // city-state on three sides and by `a` on the fourth.
    conquerRect(game, tribe, 10, 150, 60, 190);
    conquerRect(game, cs, 128, 128, 144, 144);
    conquerRect(game, a, 128, 128, 133, 144);
    conquerRect(game, tribe, 133, 133, 138, 138);
    const pocket = game.ref(135, 135);
    const csTiles = cs.numTilesOwned();

    runAnnexation(game, tribe);

    expect(game.ownerID(pocket)).toBe(a.smallID());
    expect(cs.numTilesOwned()).toBe(csTiles);
  });
});

describe("city-states: conquest", () => {
  test("eliminating it pays the 120,000 gold bounty once, and its city is captured at level 1", async () => {
    const { game, a, cs } = await founded();
    // Next to its disc, and strong.
    conquerRect(game, a, 90, 108, 111, 130);
    a.setTroops(5_000_000);
    setGold(a, 0n);
    const shown = vi.spyOn(game, "displayMessage");
    const capBefore =
      game.config().maxTroops(a) - game.config().maxTroopsWithoutCities(a);
    game.addExecution(new AttackExecution(4_000_000, a, cs.id()));
    for (let i = 0; i < 400 && cs.isAlive(); i++) game.executeNextTick();
    executeTicks(game, 2);
    expect(cs.isAlive()).toBe(false);

    // The bounty alone: a city-state banks nothing to hand over.
    expect(CITY_STATE_CONQUEST_GOLD).toBe(120_000);
    expect(a.gold()).toBe(120_000n);
    expect(
      shown.mock.calls.filter(
        ([key]) => key === "events_display.city_state_conquered",
      ),
    ).toHaveLength(1);

    const cities = a.units(UnitType.City);
    expect(cities).toHaveLength(1);
    expect(cities[0].isActive()).toBe(true);
    expect(CITY_STATE_CAPTURED_CITY_LEVEL).toBe(1);
    expect(cities[0].level()).toBe(CITY_STATE_CAPTURED_CITY_LEVEL);
    expect(cities[0].tile()).toBe(game.ref(100, 100));
    // Its troop bonus now counts for the conqueror: +250k, not +500k.
    expect(
      game.config().maxTroops(a) - game.config().maxTroopsWithoutCities(a),
    ).toBeCloseTo(capBefore + game.config().cityTroopIncrease());

    // A repeat conquest record pays no second bounty.
    const gold = a.gold();
    game.conquerPlayer(a, cs);
    expect(a.gold()).toBe(gold);
  });

  /**
   * Shrinks `target` to `tiles` tiles (taken by `a` from the south, next to
   * a's land), then lets `a` take one tile a tick (the test config's flat
   * attack cost) and returns the fewest tiles `target` held while alive.
   */
  function fewestTilesAlive(
    game: Game,
    a: Player,
    target: Player,
    tiles: number,
  ): number {
    const byRow = [...target.tiles()].sort((t, u) => game.y(u) - game.y(t));
    for (const t of byRow.slice(0, target.numTilesOwned() - tiles)) {
      a.conquer(t);
    }
    expect(target.numTilesOwned()).toBe(tiles);
    a.setTroops(100_000);
    game.addExecution(new AttackExecution(50_000, a, target.id()));
    let fewest = tiles;
    for (let i = 0; i < 200 && target.isAlive(); i++) {
      game.executeNextTick();
      if (target.isAlive()) {
        fewest = Math.min(fewest, target.numTilesOwned());
      }
    }
    expect(target.isAlive()).toBe(false);
    expect(target.numTilesOwned()).toBe(0);
    return fewest;
  }

  test("it falls only below 20 tiles: at 20 it stands, at 19 it is eliminated", async () => {
    const { game, a, cs } = await founded();
    conquerRect(game, a, 90, 108, 111, 130);
    expect(CITY_STATE_ELIMINATION_TILES).toBe(20);
    expect(fewestTilesAlive(game, a, cs, 22)).toBe(20);
  });

  test("a player still falls below 100 tiles", async () => {
    const { game, a } = await founded();
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    conquerRect(game, tribe, 20, 20, 40, 30);
    conquerRect(game, a, 20, 30, 40, 40);
    expect(fewestTilesAlive(game, a, tribe, 102)).toBe(100);
  });

  test("attackers get no tribe discount against it", async () => {
    const rules = {
      defensePostDefenseBonus: () => 5,
      defensePostSpeedBonus: () => 3,
      falloutDefenseModifier: (r: number) => 5 - 2 * r,
      traitorDefenseDebuff: () => 0.5,
      traitorSpeedDebuff: () => 0.8,
    };
    const input = (isCityState: boolean): AttackLogicInput => ({
      terrain: TerrainType.Plains,
      attackTroops: 200_000,
      attacker: { type: PlayerType.Human, numTiles: 3_000 },
      defender: {
        type: PlayerType.Bot,
        numTiles: 149,
        troops: 140_000,
        isTraitor: false,
        isDisconnectedTeammate: false,
        isCityState,
      },
      defenderHasDefensePost: true,
      falloutRatio: null,
      borderSize: 20,
    });
    const tribe = attackLogic(input(false), rules).attackerTroopLoss;
    const cityState = attackLogic(input(true), rules).attackerTroopLoss;
    expect(cityState).toBeCloseTo(tribe / 0.7, 9);

    // The engine tells attackLogic which defender is a city-state.
    const { game, a, cs } = await founded();
    conquerRect(game, a, 90, 108, 111, 130);
    a.setTroops(1_000_000);
    const inputs: AttackLogicInput[] = [];
    const config = game.config();
    const original = config.attackLogic.bind(config);
    vi.spyOn(config, "attackLogic").mockImplementation((i) => {
      inputs.push(i);
      return original(i);
    });
    game.addExecution(new AttackExecution(500_000, a, cs.id()));
    executeTicks(game, 3);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((i) => i.defender?.isCityState === true)).toBe(true);
  });

  test("the bounty follows the gold multiplier", async () => {
    const { game, a, cs } = await founded(100, 100, { goldMultiplier: 2 });
    setGold(a, 0n);
    game.conquerPlayer(a, cs);
    expect(a.gold()).toBe(240_000n);
  });

  test("a city-state earns no gold, so the prize never grows", async () => {
    const { game, cs } = await founded();
    expect(game.config().goldAdditionRate(cs)).toBe(0n);
    // A tribe earns its 50 a tick.
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    expect(game.config().goldAdditionRate(tribe)).toBe(50n);
    executeTicks(game, 600);
    expect(cs.isAlive()).toBe(true);
    expect(cs.gold()).toBe(0n);
  });

  test("a normal tribe pays no bounty", async () => {
    const game = await setup(MAP, {}, [
      new PlayerInfo("a", PlayerType.Human, "c_a", "a"),
    ]);
    const a = game.player("a");
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    tribe.conquer(game.ref(5, 5));
    setGold(a, 0n);
    setGold(tribe, 0n);
    game.conquerPlayer(a, tribe);
    expect(a.gold()).toBe(0n);
  });
});

describe("world features: lobby settings", () => {
  test("both are on unless turned off, and never in the tutorial", async () => {
    const on = (await setup(MAP)).config();
    expect(on.ruinsEnabled()).toBe(true);
    expect(on.cityStatesEnabled()).toBe(true);
    const off = (
      await setup(MAP, { ruins: false, cityStates: false })
    ).config();
    expect(off.ruinsEnabled()).toBe(false);
    expect(off.cityStatesEnabled()).toBe(false);
    const tutorial = (await setup(MAP, { tutorial: true })).config();
    expect(tutorial.ruinsEnabled()).toBe(false);
    expect(tutorial.cityStatesEnabled()).toBe(false);
  });

  async function runner(config: Partial<GameConfig>): Promise<Game> {
    const game = await setup(
      MAP,
      { difficulty: Difficulty.Medium, ...config },
      [],
      undefined,
      undefined,
      false,
    );
    new GameRunner(
      game,
      new Executor(game, GAME_ID, undefined),
      () => {},
    ).init();
    return game;
  }

  test("on: city-states stand in the spawn phase, ruins appear when it ends", async () => {
    const game = await runner({});
    expect(game.executions().some((e) => e instanceof RuinsExecution)).toBe(
      true,
    );
    executeTicks(game, 2);
    expect(game.inSpawnPhase()).toBe(true);
    const cityStates = game.allPlayers().filter((p) => p.isCityState());
    expect(cityStates).toHaveLength(cityStateCount(humanAndNationCount(game)));
    expect(game.ruins().size).toBe(0);
    game.endSpawnPhase();
    // Once a spawn picked on the phase's last tick has landed.
    executeTicks(game, 2);
    expect(game.ruins().size).toBeGreaterThan(0);
  });

  test("off: neither appears", async () => {
    const game = await runner({ ruins: false, cityStates: false });
    const execs = game.executions();
    expect(execs.some((e) => e instanceof RuinsExecution)).toBe(false);
    expect(execs.some((e) => e instanceof CityStateExecution)).toBe(false);
    executeTicks(game, 2);
    game.endSpawnPhase();
    executeTicks(game, 3);
    expect(game.allPlayers().some((p) => p.isCityState())).toBe(false);
    expect(game.ruins().size).toBe(0);
  });
});
