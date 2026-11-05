import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { siegeCampTiles } from "@openfront/engine-lib/game/AttackForecast";
import { AttackLogicInput } from "@openfront/engine-lib/game/AttackLogic";
import {
  defensePostCoverage,
  POST_COVERAGE_FULL,
  POST_COVERAGE_NONE,
  POST_COVERAGE_REDUCED,
  SIEGE_CAMP_BORDER_RANGE,
  SIEGE_CAMP_CONSTRUCTION_TICKS,
  SIEGE_CAMP_RANGE,
  siegeCampCost,
} from "@openfront/engine-lib/game/Siege";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { vi } from "vitest";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { UseRealAttackLogic } from "../../util/TestConfig";
import { executeTicks } from "../../util/utils";

const MAP = "plains";

function conquerRect(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      const t = game.ref(x, y);
      if (game.isLand(t)) p.conquer(t);
    }
  }
}

/**
 * plains, 100x100: the defender holds x >= 50. West of it, top to bottom:
 * the attacker (y < 34), its ally (34-66) and a neutral third player.
 */
async function siegeGame(config: Parameters<typeof setup>[1] = {}) {
  const game = await setup(
    MAP,
    { infiniteGold: true, instantBuild: true, ...config },
    ["attacker", "ally", "third", "defender"].map(
      (id) => new PlayerInfo(id, PlayerType.Human, null, id),
    ),
    undefined,
    UseRealAttackLogic,
  );
  const attacker = game.player("attacker");
  const ally = game.player("ally");
  const third = game.player("third");
  const defender = game.player("defender");
  conquerRect(game, defender, 50, 0, 100, 100);
  conquerRect(game, attacker, 0, 0, 50, 34);
  conquerRect(game, ally, 0, 34, 50, 67);
  conquerRect(game, third, 0, 67, 50, 100);
  attacker.createAllianceRequest(ally)!.accept();
  return { game, attacker, ally, third, defender };
}

/** Coverage of (x, y) by the defender's posts for `side`'s attacks. */
function coverageFor(
  game: Game,
  side: Player,
  defender: Player,
  x: number,
  y: number,
) {
  const camps: number[] = [];
  const count = siegeCampTiles(
    game.units(UnitType.SiegeCamp),
    (owner) => owner === side || side.isFriendly(owner, true),
    camps,
  );
  return defensePostCoverage(
    game,
    game,
    game.ref(x, y),
    defender.smallID(),
    camps,
    count,
  );
}

/** The attackLogic inputs of `attacker`'s first ticks of attacking. */
function attackInputs(
  game: Game,
  attacker: Player,
  defender: Player,
  ticks = 3,
): AttackLogicInput[] {
  const inputs: AttackLogicInput[] = [];
  const config = game.config();
  const original = config.attackLogic.bind(config);
  const spy = vi.spyOn(config, "attackLogic").mockImplementation((input) => {
    inputs.push(input);
    return original(input);
  });
  attacker.setTroops(200_000);
  defender.setTroops(100_000);
  game.addExecution(new AttackExecution(60_000, attacker, defender.id()));
  executeTicks(game, ticks);
  spy.mockRestore();
  return inputs;
}

describe("siege camp rules", () => {
  test("costs (owned + 1) x 300k, capped at 1.2M", async () => {
    expect(siegeCampCost(0)).toBe(300_000);
    expect(siegeCampCost(1)).toBe(600_000);
    expect(siegeCampCost(2)).toBe(900_000);
    expect(siegeCampCost(3)).toBe(1_200_000);
    expect(siegeCampCost(9)).toBe(1_200_000);

    const { game, attacker } = await siegeGame({ infiniteGold: false });
    const cost = game.unitInfo(UnitType.SiegeCamp).cost;
    expect(cost(game, attacker)).toBe(300_000n);
    attacker.buildUnit(UnitType.SiegeCamp, game.ref(45, 10), {});
    expect(cost(game, attacker)).toBe(600_000n);
  });

  test("is available in every game mode", async () => {
    for (const conventionalWar of [false, true]) {
      const { game } = await siegeGame({ conventionalWar });
      expect(game.config().isUnitDisabled(UnitType.SiegeCamp)).toBe(false);
    }
  });

  test("builds in 20 seconds", async () => {
    const { game } = await siegeGame({ instantBuild: false });
    expect(SIEGE_CAMP_CONSTRUCTION_TICKS).toBe(200);
    expect(
      game.config().unitInfo(UnitType.SiegeCamp).constructionDuration,
    ).toBe(200);
  });
});

describe("siege camp placement", () => {
  test("goes on own land within 10 tiles of a hostile player's land", async () => {
    const { game, attacker } = await siegeGame();
    const spawn = attacker.canBuild(UnitType.SiegeCamp, game.ref(44, 15));
    expect(spawn).not.toBe(false);
    expect(game.owner(spawn as number)).toBe(attacker);
    // Within range of the defender's land at x = 50.
    expect(50 - game.x(spawn as number)).toBeLessThanOrEqual(
      SIEGE_CAMP_BORDER_RANGE,
    );
    const offer = attacker
      .buildableUnits(game.ref(44, 15), [UnitType.SiegeCamp])
      .find((u) => u.type === UnitType.SiegeCamp)!;
    expect(offer.canBuild).toBe(spawn);
  });

  test("not deep inside own land, nor on someone else's land", async () => {
    const { game, attacker } = await siegeGame();
    // 25 tiles from the defender, more from the third player.
    expect(attacker.canBuild(UnitType.SiegeCamp, game.ref(10, 10))).toBe(false);
    expect(attacker.canBuild(UnitType.SiegeCamp, game.ref(60, 10))).toBe(false);
  });

  test("a friend's border is not hostile, a neutral player's is", async () => {
    const { game, attacker, ally } = await siegeGame();
    // Next to the ally's land (y >= 34), 25+ tiles from anyone hostile.
    conquerRect(game, attacker, 0, 0, 25, 40);
    expect(attacker.canBuild(UnitType.SiegeCamp, game.ref(5, 35))).toBe(false);
    // The ally can build next to the neutral third player (y >= 67).
    expect(ally.canBuild(UnitType.SiegeCamp, game.ref(5, 63))).not.toBe(false);
  });
});

describe("siege camp effect", () => {
  // A level-3 post reaching the whole western front, about 40 tiles from
  // the attacker's camp.
  async function besieged() {
    const g = await siegeGame();
    const post = g.defender.buildUnit(
      UnitType.DefensePost,
      g.game.ref(75, 50),
      {},
    );
    post.increaseLevel();
    post.increaseLevel();
    return { ...g, post };
  }

  test("takes effect once built", async () => {
    const { game, attacker, defender } = await siegeGame({
      instantBuild: false,
    });
    defender.buildUnit(UnitType.DefensePost, game.ref(70, 20), {});
    game.addExecution(
      new ConstructionExecution(attacker, UnitType.SiegeCamp, game.ref(45, 20)),
    );
    executeTicks(game, 2);
    const [camp] = attacker.units(UnitType.SiegeCamp);
    expect(camp.isUnderConstruction()).toBe(true);
    expect(coverageFor(game, attacker, defender, 50, 20)).toBe(
      POST_COVERAGE_FULL,
    );
    // Still building just short of 20 seconds, done at 20.
    executeTicks(game, SIEGE_CAMP_CONSTRUCTION_TICKS - 1);
    expect(camp.isUnderConstruction()).toBe(true);
    executeTicks(game, 2);
    expect(camp.isUnderConstruction()).toBe(false);
    expect(coverageFor(game, attacker, defender, 50, 20)).toBe(
      POST_COVERAGE_REDUCED,
    );
  });

  test("reduces the post for its owner's and its owner's ally's attacks only", async () => {
    for (const side of ["attacker", "ally", "third"] as const) {
      const g = await besieged();
      g.attacker.buildUnit(UnitType.SiegeCamp, g.game.ref(40, 30), {});
      expect(
        g.game.euclideanDistSquared(g.game.ref(40, 30), g.post.tile()),
      ).toBeLessThanOrEqual(SIEGE_CAMP_RANGE ** 2);
      const inputs = attackInputs(g.game, g[side], g.defender);
      const covered = inputs.filter((i) => i.defenderHasDefensePost);
      expect(covered.length).toBeGreaterThan(0);
      expect(covered.every((i) => i.siegeCampReducesDefensePost)).toBe(
        side !== "third",
      );
      expect(inputs.some((i) => i.siegeCampReducesDefensePost)).toBe(
        side !== "third",
      );
    }
  });

  test("a camp out of the post's reach does nothing", async () => {
    const { game, attacker, defender, post } = await besieged();
    // 46+ tiles from the post.
    attacker.buildUnit(UnitType.SiegeCamp, game.ref(29, 33), {});
    expect(
      game.euclideanDistSquared(game.ref(29, 33), post.tile()),
    ).toBeGreaterThan(SIEGE_CAMP_RANGE ** 2);
    expect(coverageFor(game, attacker, defender, 50, 30)).toBe(
      POST_COVERAGE_FULL,
    );
  });

  test("a tile keeps the full bonus while any post covering it is unreduced", async () => {
    const { game, attacker, defender } = await besieged();
    attacker.buildUnit(UnitType.SiegeCamp, game.ref(40, 30), {});
    // Out of the camp's reach (54 tiles), covering x = 50 for y 30-70.
    const far = defender.buildUnit(UnitType.DefensePost, game.ref(90, 50), {});
    far.increaseLevel();
    far.increaseLevel();
    // Both posts cover (50, 40); only the reduced one covers (50, 20).
    expect(coverageFor(game, attacker, defender, 50, 40)).toBe(
      POST_COVERAGE_FULL,
    );
    expect(coverageFor(game, attacker, defender, 50, 20)).toBe(
      POST_COVERAGE_REDUCED,
    );
    expect(coverageFor(game, attacker, defender, 10, 95)).toBe(
      POST_COVERAGE_NONE,
    );
  });

  test("is captured with its tile and then helps its new owner's side", async () => {
    const { game, attacker, defender } = await besieged();
    const camp = attacker.buildUnit(UnitType.SiegeCamp, game.ref(40, 30), {});
    game.addExecution(new PlayerExecution(attacker));
    executeTicks(game, 1);
    defender.conquer(camp.tile());
    executeTicks(game, 1);
    expect(camp.isActive()).toBe(true);
    expect(camp.owner()).toBe(defender);
    expect(coverageFor(game, attacker, defender, 50, 30)).toBe(
      POST_COVERAGE_FULL,
    );
  });
});

describe("siege camp snapshots", () => {
  test("round-trips a camp mid-build, a built camp and an attack it reduces", async () => {
    const { game, attacker, defender } = await siegeGame({
      instantBuild: false,
    });
    defender.buildUnit(UnitType.DefensePost, game.ref(70, 20), {});
    attacker.buildUnit(UnitType.SiegeCamp, game.ref(45, 20), {});
    game.addExecution(
      new ConstructionExecution(attacker, UnitType.SiegeCamp, game.ref(42, 5)),
    );
    attacker.setTroops(200_000);
    defender.setTroops(100_000);
    game.addExecution(new AttackExecution(60_000, attacker, defender.id()));
    executeTicks(game, 5);
    expect(
      attacker.units(UnitType.SiegeCamp).filter((c) => c.isUnderConstruction()),
    ).toHaveLength(1);
    const restored = await expectSnapshotRoundTrip(game, MAP, 30);
    expect(restored.player("attacker").units(UnitType.SiegeCamp)).toHaveLength(
      2,
    );
  });
});
