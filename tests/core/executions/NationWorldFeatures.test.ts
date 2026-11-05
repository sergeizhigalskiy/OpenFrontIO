import {
  Difficulty,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { RuinReward } from "@openfront/engine-lib/game/WorldFeatures";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { CityStateExecution } from "@openfront/engine/execution/CityStateExecution";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import {
  cityStateAttackOdds,
  cityStateStrengthRatio,
  cityStateToAttack,
  ruinSeekRange,
  ruinToSeek,
} from "@openfront/engine/execution/nation/NationWorldFeatures";
import { TribeAttackBehavior } from "@openfront/engine/execution/TribeAttackBehavior";
import { Game, Player } from "@openfront/engine/game/Game";
import { conquerRect } from "../../util/ConventionalWar";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

// big_plains: 200x200 tiles of open land.
const MAP = "big_plains";
const DIFFICULTIES = [
  Difficulty.Easy,
  Difficulty.Medium,
  Difficulty.Hard,
  Difficulty.Impossible,
];

function nationBehavior(game: Game, nation: Player): NationAttackBehavior {
  return new NationAttackBehavior(
    new PseudoRandom(42),
    game,
    nation,
    0.5, // triggerRatio
    0.3, // reserveRatio
    0.2, // expandRatio
    { maybeBetray: vi.fn(), maybeSendAllianceRequests: vi.fn() } as never,
    { maybeSendAttackEmoji: vi.fn(), sendEmoji: vi.fn() } as never,
    { clearSeaLane: vi.fn() } as never,
  );
}

function attacksSent(spy: { mock: { calls: unknown[][] } }): AttackExecution[] {
  return spy.mock.calls
    .map(([e]) => e)
    .filter((e): e is AttackExecution => e instanceof AttackExecution);
}

function focusOf(exec: AttackExecution): number | null {
  return (exec as unknown as { focusTile: number | null }).focusTile;
}

describe("nations and ruins", () => {
  async function nationAt(difficulty: Difficulty) {
    const game = await setup(MAP, { difficulty });
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
    );
    conquerRect(game, nation, 20, 20, 40, 40);
    nation.largestClusterBoundingBox = {
      min: { x: 20, y: 20 } as never,
      max: { x: 39, y: 39 } as never,
    };
    nation.setTroops(100_000);
    return { game, nation };
  }

  test("harder nations look further for ruins; easy ones don't", () => {
    expect(ruinSeekRange(Difficulty.Easy)).toBe(0);
    const ranges = DIFFICULTIES.map(ruinSeekRange);
    expect([...ranges].sort((a, b) => a - b)).toEqual(ranges);
  });

  test("a nation steers for the nearest unclaimed ruin in range", async () => {
    const { game, nation } = await nationAt(Difficulty.Impossible);
    expect(ruinToSeek(game, nation)).toBeNull();
    const far = game.ref(150, 150);
    const near = game.ref(50, 30); // 11 tiles past its land
    const nearer = game.ref(30, 45); // 6 tiles
    game.addRuins([
      { tile: far, reward: RuinReward.Gold },
      { tile: near, reward: RuinReward.Gold },
      { tile: nearer, reward: RuinReward.Troops },
    ]);
    expect(ruinToSeek(game, nation)).toBe(nearer);
    nation.conquer(nearer);
    expect(ruinToSeek(game, nation)).toBe(near);
  });

  test("out of range or on easy, it doesn't", async () => {
    const { game, nation } = await nationAt(Difficulty.Medium);
    game.addRuins([{ tile: game.ref(100, 100), reward: RuinReward.Gold }]);
    expect(ruinToSeek(game, nation)).toBeNull();
    const easy = await nationAt(Difficulty.Easy);
    easy.game.addRuins([
      { tile: easy.game.ref(42, 30), reward: RuinReward.Gold },
    ]);
    expect(ruinToSeek(easy.game, easy.nation)).toBeNull();
  });

  test("its free-land expansion spearheads at the ruin", async () => {
    const { game, nation } = await nationAt(Difficulty.Hard);
    const ruin = game.ref(45, 30);
    game.addRuins([{ tile: ruin, reward: RuinReward.Gold }]);
    const added = vi.spyOn(game, "addExecution");
    expect(nationBehavior(game, nation).sendAttack(game.terraNullius())).toBe(
      true,
    );
    expect(attacksSent(added).map(focusOf)).toEqual([ruin]);

    // The spearhead gets there sooner than an even advance would.
    const ticksToClaim = (g: Game) => {
      for (let i = 0; i < 400; i++) {
        if (g.ruins().size === 0) return i;
        g.executeNextTick();
      }
      return Infinity;
    };
    const aimed = ticksToClaim(game);
    const even = await nationAt(Difficulty.Hard);
    even.game.addRuins([{ tile: ruin, reward: RuinReward.Gold }]);
    even.game.addExecution(
      new AttackExecution(50_000, even.nation, even.game.terraNullius().id()),
    );
    expect(aimed).toBeLessThan(ticksToClaim(even.game));
    expect(game.owner(ruin)).toBe(nation);
  });

  test("with no ruin around, expansion is unchanged and tribes never aim", async () => {
    const { game, nation } = await nationAt(Difficulty.Hard);
    const added = vi.spyOn(game, "addExecution");
    nationBehavior(game, nation).sendAttack(game.terraNullius());
    expect(attacksSent(added).map(focusOf)).toEqual([null]);

    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    conquerRect(game, tribe, 120, 120, 130, 130);
    tribe.setTroops(50_000);
    game.addRuins([{ tile: game.ref(132, 125), reward: RuinReward.Gold }]);
    added.mockClear();
    new TribeAttackBehavior(
      new PseudoRandom(1),
      game,
      tribe,
      0,
      0,
      0,
    ).sendAttack(game.terraNullius());
    expect(attacksSent(added).map(focusOf)).toEqual([null]);
  });
});

describe("nations and city-states", () => {
  /**
   * A city-state at (100, 100); `nation` holds the land south of it and an
   * ally holds the rest, so the city-state is the nation's only target.
   */
  async function walledIn(difficulty: Difficulty, troops: number) {
    const game = await setup(MAP, { difficulty });
    game.addExecution(
      new CityStateExecution(
        new PlayerInfo("Aldmere", PlayerType.Bot, null, "cs"),
        game.ref(100, 100),
      ),
    );
    executeTicks(game, 2);
    const cs = game.player("cs");
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
    );
    const ally = game.addPlayer(
      new PlayerInfo("ally", PlayerType.Human, "c_ally", "ally"),
    );
    conquerRect(game, nation, 0, 108, 200, 200);
    game.forEachTile((t) => {
      if (game.isLand(t) && !game.hasOwner(t)) ally.conquer(t);
    });
    nation.createAllianceRequest(ally)?.accept();
    nation.setTroops(troops);
    return { game, cs, nation };
  }

  test("harder nations need less margin and go sooner", () => {
    const ratios = DIFFICULTIES.map(cityStateStrengthRatio);
    const odds = DIFFICULTIES.map(cityStateAttackOdds);
    expect([...ratios].sort((a, b) => b - a)).toEqual(ratios);
    expect([...odds].sort((a, b) => b - a)).toEqual(odds);
    expect(cityStateAttackOdds(Difficulty.Impossible)).toBe(1);
  });

  test("a nation picks a city-state only when comfortably stronger than its garrison", async () => {
    const { game, cs, nation } = await walledIn(Difficulty.Impossible, 0);
    const garrison = cs.troops();
    expect(garrison).toBeGreaterThan(0);
    const pick = () => cityStateToAttack(game, nation, [cs], () => 0);

    nation.setTroops(garrison * 1.5);
    expect(pick()).toBeNull();
    nation.setTroops(garrison * cityStateStrengthRatio(Difficulty.Impossible));
    expect(pick()).toBe(cs);
    // What it keeps home doesn't count.
    expect(cityStateToAttack(game, nation, [cs], () => garrison)).toBeNull();
  });

  test("the same strength is enough on impossible, not on easy", async () => {
    for (const [difficulty, expected] of [
      [Difficulty.Impossible, true],
      [Difficulty.Hard, true],
      [Difficulty.Medium, true],
      [Difficulty.Easy, false],
    ] as const) {
      const { game, cs, nation } = await walledIn(difficulty, 0);
      nation.setTroops(cs.troops() * 3);
      expect(
        cityStateToAttack(game, nation, [cs], () => 0) === cs,
        difficulty,
      ).toBe(expected);
    }
  });

  test("a strong impossible nation attacks the city-state on its attack tick", async () => {
    const { game, cs, nation } = await walledIn(
      Difficulty.Impossible,
      2_000_000,
    );
    const added = vi.spyOn(game, "addExecution");
    nationBehavior(game, nation).maybeAttack();
    expect(attacksSent(added).map((a) => a.targetID())).toEqual([cs.id()]);
  });

  test("a weak nation leaves it alone", async () => {
    const { game, cs, nation } = await walledIn(Difficulty.Impossible, 150_000);
    expect(nation.troops()).toBeLessThan(
      cs.troops() * cityStateStrengthRatio(Difficulty.Impossible),
    );
    const added = vi.spyOn(game, "addExecution");
    const behavior = nationBehavior(game, nation);
    for (let i = 0; i < 20; i++) behavior.maybeAttack();
    expect(attacksSent(added).map((a) => a.targetID())).not.toContain(cs.id());
  });
});
