import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackLogicInput } from "@openfront/engine-lib/game/AttackLogic";
import {
  DEFENSE_POST_RANGE,
  defensePostCovers,
} from "@openfront/engine-lib/game/DefensePosts";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { DefensePostExecution } from "@openfront/engine/execution/DefensePostExecution";
import { UpgradeStructureExecution } from "@openfront/engine/execution/UpgradeStructureExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { vi } from "vitest";
import { setup } from "../../util/Setup";
import { UseRealAttackLogic } from "../../util/TestConfig";
import { executeTicks } from "../../util/utils";

// Defense posts are upstream's: one level, range 30, 5x attacker losses and
// 3x slower attacks on covered tiles, price rising by 50k up to 250k.

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

// plains: 100x100, all Plains. The defender holds x >= 50.
async function plainsGame() {
  const game = await setup(
    "plains",
    { instantBuild: true },
    [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
      new PlayerInfo("other", PlayerType.Human, null, "other"),
    ],
    undefined,
    UseRealAttackLogic,
  );
  const attacker = game.player("attacker");
  const defender = game.player("defender");
  const other = game.player("other");
  conquerRect(game, attacker, 0, 0, 50, 100);
  conquerRect(game, defender, 50, 0, 100, 100);
  return { game, attacker, defender, other };
}

function postAt(game: Game, owner: Player, x: number, y: number) {
  return owner.buildUnit(UnitType.DefensePost, game.ref(x, y), {});
}

function covered(game: Game, defender: Player, x: number, y: number) {
  return defensePostCovers(game, game.ref(x, y), defender.smallID());
}

describe("defense posts: upstream's single level", () => {
  test("range 30, 5x losses and 3x time, never upgradable", async () => {
    const { game } = await plainsGame();
    const config = game.config();
    expect(DEFENSE_POST_RANGE).toBe(30);
    expect(config.defensePostRange()).toBe(30);
    expect(config.defensePostDefenseBonus()).toBe(5);
    expect(config.defensePostSpeedBonus()).toBe(3);
    const info = config.unitInfo(UnitType.DefensePost);
    expect(info.upgradable).toBeFalsy();
    expect("maxLevel" in info).toBe(false);
  });

  test("each post costs 50k more than the last, up to 250k", async () => {
    const { game, defender } = await plainsGame();
    defender.addGold(10_000_000n);
    const cost = game.unitInfo(UnitType.DefensePost).cost;
    const prices: bigint[] = [];
    for (let i = 0; i < 7; i++) {
      prices.push(cost(game, defender));
      postAt(game, defender, 55 + 6 * i, 50);
    }
    expect(prices).toEqual([
      50_000n,
      100_000n,
      150_000n,
      200_000n,
      250_000n,
      250_000n,
      250_000n,
    ]);
  });

  test("covers 30 tiles, not 31; others' and unbuilt posts don't count", async () => {
    const { game, defender, other } = await plainsGame();
    postAt(game, defender, 90, 50);
    expect(covered(game, defender, 60, 50)).toBe(true);
    expect(covered(game, defender, 59, 50)).toBe(false);
    expect(covered(game, other, 60, 50)).toBe(false);
    const building = postAt(game, defender, 70, 80);
    building.setUnderConstruction(true);
    expect(covered(game, defender, 70, 75)).toBe(false);
    building.setUnderConstruction(false);
    expect(covered(game, defender, 70, 75)).toBe(true);
  });

  test("coverage is upstream's 30-tile hasUnitNearby check on every tile", async () => {
    // big_plains is 200x200, four unit-grid cells: posts on and near the
    // cell edges at x = 100 and y = 100.
    const game = await setup("big_plains", { instantBuild: true }, [
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
      new PlayerInfo("other", PlayerType.Human, null, "other"),
    ]);
    const defender = game.player("defender");
    const other = game.player("other");
    for (const [x, y] of [
      [100, 50],
      [130, 100],
      [99, 160],
      [40, 40],
    ]) {
      postAt(game, defender, x, y);
    }
    postAt(game, other, 160, 160);
    for (let x = 0; x < 200; x++) {
      for (let y = 0; y < 200; y++) {
        const upstream = game.hasUnitNearby(
          game.ref(x, y),
          30,
          UnitType.DefensePost,
          defender.id(),
        );
        expect(covered(game, defender, x, y)).toBe(upstream);
      }
    }
    // Upstream's grid query never finds a post exactly 30 tiles away along
    // +x when it starts the next grid cell; the same here.
    expect(covered(game, defender, 70, 50)).toBe(false);
    expect(covered(game, defender, 71, 50)).toBe(true);
  });

  test("an upgrade does nothing: one level only", async () => {
    const { game, defender } = await plainsGame();
    defender.addGold(1_000_000n);
    const post = postAt(game, defender, 80, 50);
    expect(defender.canUpgradeUnit(post)).toBe(false);
    const offer = defender
      .buildableUnits(game.ref(80, 50), [UnitType.DefensePost])
      .find((u) => u.type === UnitType.DefensePost)!;
    expect(offer.canUpgrade).toBe(false);
    expect(offer.upgradeCosts).toBeUndefined();

    const gold = defender.gold();
    game.addExecution(new UpgradeStructureExecution(defender, post.id(), 3));
    executeTicks(game, 2);
    expect(post.level()).toBe(1);
    expect(defender.gold()).toBe(gold);
  });
});

describe("defense post range in combat", () => {
  /** The attackLogic inputs of the attacker's first ticks into the defender. */
  function attackInputs(game: Game, attacker: Player, defender: Player) {
    const inputs: AttackLogicInput[] = [];
    const config = game.config();
    const original = config.attackLogic.bind(config);
    const spy = vi.spyOn(config, "attackLogic").mockImplementation((input) => {
      inputs.push(input);
      return original(input);
    });
    attacker.setTroops(200_000);
    defender.setTroops(100_000);
    game.addExecution(new AttackExecution(50_000, attacker, defender.id()));
    executeTicks(game, 3);
    spy.mockRestore();
    return inputs;
  }

  test("a post 29 tiles behind the front defends it; one 31 tiles back doesn't", async () => {
    for (const x of [79, 81]) {
      const { game, attacker, defender } = await plainsGame();
      // The front column is x = 50.
      postAt(game, defender, x, 50);
      const inputs = attackInputs(game, attacker, defender);
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.some((i) => i.defenderHasDefensePost)).toBe(x === 79);
    }
  });

  test("the post shells hostile convoys within 30 tiles", async () => {
    const { game, attacker, defender } = await plainsGame();
    const post = postAt(game, defender, 85, 50);
    const exec = new DefensePostExecution(post);
    exec.init(game, game.ticks());
    const target = () =>
      (
        exec as unknown as { findConvoyTarget(): Unit | null }
      ).findConvoyTarget();
    // 31 tiles from the post.
    const far: Unit = attacker.buildUnit(UnitType.Convoy, game.ref(54, 50), {
      troops: 1_000,
      targetTile: game.ref(10, 10),
      targetPlayer: attacker,
    });
    expect(target()).toBeNull();
    // 30 tiles.
    far.move(game.ref(55, 50));
    expect(target()).toBe(far);
  });
});
