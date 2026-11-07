/**
 * Supply lines (spearhead round, B): a spearhead gets more expensive the
 * deeper it goes, in troops and in time, from SPEAR_FREE_DEPTH on; broad
 * attacks are unchanged. Depth counts from the spear's origin, which the
 * attacker remembers per target while it keeps spearheading it.
 */
import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  attackForecast,
  spearDepthAt,
} from "@openfront/engine-lib/game/AttackForecast";
import {
  attackLogic,
  AttackLogicInput,
  SPEAR_FREE_DEPTH,
  SPEAR_ORIGIN_MEMORY_TICKS,
  SPEAR_OVEREXTEND_MAX,
  SPEAR_OVEREXTEND_SCALE,
  spearDepth,
  spearOverextension,
} from "@openfront/engine-lib/game/AttackLogic";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, it } from "vitest";
import { setup } from "../../util/Setup";
import { UseRealAttackLogic } from "../../util/TestConfig";
import { executeTicks } from "../../util/utils";

const humans = (...ids: string[]) =>
  ids.map((id) => new PlayerInfo(id, PlayerType.Human, `c_${id}`, id));

/** Spearhead tiles the attacker takes from `defender`, each with its troop cost. */
function tileCosts(game: Game, attacker: Player, defender: Player) {
  const costs: { tile: TileRef; loss: number }[] = [];
  const stack = () =>
    attacker
      .outgoingAttacks()
      .filter((a) => a.target() === defender)
      .reduce((s, a) => s + a.troops(), 0);
  let last = stack();
  const conquer = attacker.conquer.bind(attacker);
  attacker.conquer = (tile: TileRef) => {
    const now = stack();
    if (game.owner(tile) === defender && last - now > 0) {
      costs.push({ tile, loss: last - now });
    }
    last = now;
    conquer(tile);
  };
  return { costs, reset: () => (last = stack()) };
}

/**
 * The spec's corridor: on big_plains the attacker holds y < 60, the defender
 * (400k troops) x 20-179 by y 60-139 and a third player the rest. The
 * spearhead aims at (100, 145), past the defender: the corridor is cut when
 * the attacker takes (100, 139), 80 tiles deep.
 */
async function corridor(send: number, spearhead: boolean, seed?: number) {
  const game = await setup(
    "big_plains",
    {},
    humans("a", "d", "t"),
    undefined,
    UseRealAttackLogic,
  );
  const [a, d, t] = ["a", "d", "t"].map((id) => game.player(id));
  for (let x = 0; x < 200; x++) {
    for (let y = 0; y < 200; y++) {
      (y < 60 ? a : x >= 20 && x < 180 && y < 140 ? d : t).conquer(
        game.ref(x, y),
      );
    }
  }
  a.setTroops(send * 2);
  d.setTroops(400_000);
  t.setTroops(400_000);
  for (const p of [a, d, t]) game.addExecution(new PlayerExecution(p));
  game.executeNextTick();
  const exec = new AttackExecution(
    send,
    a,
    d.id(),
    null,
    true,
    spearhead ? game.ref(100, 145) : null,
  );
  if (seed !== undefined) {
    (exec as unknown as { random: PseudoRandom }).random = new PseudoRandom(
      seed,
    );
  }
  game.addExecution(exec);
  game.executeNextTick();
  const rec = tileCosts(game, a, d);
  rec.reset();
  const left = () =>
    a
      .outgoingAttacks()
      .filter((x) => x.target() === d)
      .reduce((s, x) => s + x.troops(), 0);
  let cutTick = -1;
  let cutSpent = 0;
  const a0 = a.numTilesOwned();
  for (let i = 0; i < 600; i++) {
    game.executeNextTick();
    if (cutTick < 0 && game.owner(game.ref(100, 139)) === a) {
      cutTick = i;
      cutSpent = send - left();
    }
  }
  return {
    game,
    cutTick,
    cutSpent,
    gained: a.numTilesOwned() - a0,
    spent: send - left(),
    costs: rec.costs,
  };
}

/**
 * The spec's post: on big_plains the attacker holds x < 100, the defender
 * (400k troops) the rest with a defense post at (x, 100). A spearhead aims
 * at the post. Returns the ticks until it falls, or -1.
 */
async function postBreak(x: number, send: number, seed: number) {
  const game = await setup(
    "big_plains",
    { instantBuild: true },
    humans("a", "d"),
    undefined,
    UseRealAttackLogic,
  );
  const [a, d] = ["a", "d"].map((id) => game.player(id));
  for (let xx = 0; xx < 200; xx++) {
    for (let y = 0; y < 200; y++) (xx < 100 ? a : d).conquer(game.ref(xx, y));
  }
  a.setTroops(send * 2);
  d.setTroops(400_000);
  const post = d.buildUnit(UnitType.DefensePost, game.ref(x, 100), {});
  for (const p of [a, d]) game.addExecution(new PlayerExecution(p));
  game.executeNextTick();
  const exec = new AttackExecution(
    send,
    a,
    d.id(),
    null,
    true,
    game.ref(x, 100),
  );
  (exec as unknown as { random: PseudoRandom }).random = new PseudoRandom(seed);
  game.addExecution(exec);
  game.executeNextTick();
  for (let i = 0; i < 300; i++) {
    game.executeNextTick();
    if (!post.isActive()) return i;
  }
  return -1;
}

const median = (xs: number[]) => {
  const s = xs.slice().sort((p, q) => p - q);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

describe("the overextension rule", () => {
  it("is free up to 20 deep, then 1x more per 9 tiles, up to 3.25x", () => {
    expect([
      SPEAR_FREE_DEPTH,
      SPEAR_OVEREXTEND_SCALE,
      SPEAR_OVEREXTEND_MAX,
    ]).toEqual([20, 9, 3.25]);
    expect(spearOverextension(0)).toBe(1);
    expect(spearOverextension(20)).toBe(1);
    expect(spearOverextension(29)).toBe(2);
    expect(spearOverextension(38)).toBe(3);
    expect(spearOverextension(40)).toBeCloseTo(1 + 20 / 9);
    expect(spearOverextension(41)).toBe(3.25);
    expect(spearOverextension(200)).toBe(3.25);
  });

  it("measures depth along the line from the origin to the focus", () => {
    // On the line, the focus included: the manhattan distance.
    expect(spearDepth(0, 0, 0, 80, 0, 30)).toBe(30);
    expect(spearDepth(0, 0, 0, 80, 0, 80)).toBe(80);
    expect(spearDepth(0, 0, 40, 40, 20, 20)).toBe(40);
    expect(spearDepth(0, 0, 40, 40, 40, 40)).toBe(80);
    // A flank tile beside the attacker's border, 70 tiles off to the side.
    expect(spearDepth(0, 0, 0, 80, 70, 1)).toBe(1);
    // Behind the origin.
    expect(spearDepth(0, 0, 0, 80, 5, -3)).toBe(0);
  });

  const input = (spearDepth?: number, defender = true): AttackLogicInput => ({
    terrain: TerrainType.Plains,
    attackTroops: 300_000,
    attacker: { type: PlayerType.Human, numTiles: 12_000 },
    defender: defender
      ? {
          type: PlayerType.Nation,
          numTiles: 12_800,
          troops: 400_000,
          isTraitor: false,
          isDisconnectedTeammate: false,
        }
      : null,
    defenderHasDefensePost: false,
    falloutRatio: null,
    borderSize: 50,
    spearDepth,
  });
  const rules = {
    defensePostDefenseBonus: () => 5,
    defensePostSpeedBonus: () => 3,
    falloutDefenseModifier: () => 1,
    traitorDefenseDebuff: () => 1,
    traitorSpeedDebuff: () => 1,
  };

  it("multiplies a deep tile's loss and time on a human's or nation's land, never a tribe's or free land", () => {
    const broad = attackLogic(input(), rules);
    const deep = attackLogic(input(29), rules);
    expect(deep.attackerTroopLoss).toBeCloseTo(broad.attackerTroopLoss * 2);
    expect(deep.tickFraction).toBeCloseTo(broad.tickFraction * 2);
    expect(deep.defenderTroopLoss).toBe(broad.defenderTroopLoss);
    expect(attackLogic(input(20), rules)).toEqual(broad);
    expect(attackLogic(input(0), rules)).toEqual(broad);
    expect(attackLogic(input(60, false), rules)).toEqual(
      attackLogic(input(undefined, false), rules),
    );
    const tribe = (depth?: number) => {
      const i = input(depth);
      i.defender!.type = PlayerType.Bot;
      return attackLogic(i, rules);
    };
    expect(tribe(60)).toEqual(tribe(undefined));
  });
});

describe("spear lines", () => {
  async function band() {
    const game = await setup(
      "big_plains",
      {},
      humans("a", "d"),
      undefined,
      UseRealAttackLogic,
    );
    const [a, d] = ["a", "d"].map((id) => game.player(id));
    for (let x = 0; x < 200; x++) {
      for (let y = 0; y < 200; y++) (y < 60 ? a : d).conquer(game.ref(x, y));
    }
    a.setTroops(1_000_000);
    d.setTroops(100_000);
    return { game, a, d };
  }

  it("start at the attacker's tile nearest the focus and are kept for 60 s after the last spearhead", async () => {
    expect(SPEAR_ORIGIN_MEMORY_TICKS).toBe(600);
    const { game, a, d } = await band();
    const line = a.startSpear(d, game.ref(120, 100));
    expect(line.origin).toBe(game.ref(120, 59));
    // A spearhead joining it the same tick (they merge) keeps the origin.
    expect(a.startSpear(d, game.ref(30, 90)).origin).toBe(line.origin);
    executeTicks(game, 5);
    // One launched later elsewhere on the front, far from the line's tip,
    // starts its own.
    expect(a.startSpear(d, game.ref(30, 90)).origin).toBe(game.ref(30, 59));
    // One relaunched from that line's spearhead, 41 deep, keeps its origin.
    for (let y = 60; y <= 100; y++) a.conquer(game.ref(30, y));
    a.extendSpear(d, game.ref(30, 100), 41);
    executeTicks(game, 5);
    expect(a.startSpear(d, game.ref(30, 150)).origin).toBe(game.ref(30, 59));
    executeTicks(game, SPEAR_ORIGIN_MEMORY_TICKS);
    expect(a.spearLine(d)).not.toBeNull();
    // ...until it has gone 60 s without one.
    executeTicks(game, 1);
    expect(a.spearLine(d)).toBeNull();
    expect(a.startSpear(d, game.ref(30, 150)).origin).toBe(game.ref(30, 100));
  });

  it("relaunching from the tip or merging into a running spearhead keeps the depth", async () => {
    const { game, a, d } = await band();
    const focus = game.ref(100, 150);
    game.addExecution(
      new AttackExecution(60_000, a, d.id(), null, true, focus),
    );
    executeTicks(game, 40);
    const first = a.spearLine(d)!;
    expect(first.origin).toBe(game.ref(100, 59));
    expect(first.tipDepth).toBeGreaterThan(SPEAR_FREE_DEPTH);
    // Merges into the running spearhead: same line, same origin.
    game.addExecution(
      new AttackExecution(10_000, a, d.id(), null, true, focus),
    );
    executeTicks(game, 5);
    expect(a.spearLine(d)!.origin).toBe(first.origin);
    // Let it end, then relaunch from the tip within the minute.
    for (const attack of a.outgoingAttacks()) attack.delete();
    executeTicks(game, 100);
    const tip = a.spearLine(d)!.tip;
    game.addExecution(
      new AttackExecution(10_000, a, d.id(), null, true, game.ref(100, 190)),
    );
    executeTicks(game, 2);
    expect(a.spearLine(d)!.origin).toBe(first.origin);
    expect(game.ownerID(tip)).toBe(a.smallID());
  });

  it("the forecast prices the tile's depth from the remembered origin, else from the attacker's land", async () => {
    const { game, a, d } = await band();
    const deep = game.ref(100, 100); // 41 tiles from (100, 59)
    expect(spearDepthAt(game, deep, null, a.borderTiles())).toBe(41);
    const at = (depth: number) =>
      attackForecast(game, a, d, deep, 300_000, 200, true, true, depth);
    expect(at(41).lossPerTile).toBeCloseTo(
      at(0).lossPerTile * spearOverextension(41),
    );
    expect(at(41).tilesPerSecond!).toBeCloseTo(
      at(0).tilesPerSecond! / spearOverextension(41),
    );
    // A broad attack has no depth.
    expect(
      attackForecast(game, a, d, deep, 300_000, 200, false, true, 41),
    ).toEqual(attackForecast(game, a, d, deep, 300_000, 200, false));
    // A line on the target from far off: a spearhead at the tile starts its
    // own origin, unless it merges into that line's running spearhead.
    const line = a.startSpear(d, game.ref(20, 61));
    expect(line.origin).toBe(game.ref(20, 59));
    expect(spearDepthAt(game, deep, line, a.borderTiles())).toBe(41);
    expect(spearDepthAt(game, deep, line, a.borderTiles(), true)).toBe(
      game.manhattanDist(line.origin, deep),
    );
    // One that starts near the line's tip keeps its origin.
    a.extendSpear(d, game.ref(95, 59), 30);
    expect(spearDepthAt(game, deep, a.spearLine(d), a.borderTiles())).toBe(
      game.manhattanDist(line.origin, deep),
    );
  });
});

describe("the spec's spearhead table", () => {
  it("an 80-tile corridor takes at least 20 s and 2x the troops (300k: 2.1 s and 27.6k before)", async () => {
    const spear = await corridor(300_000, true);
    expect(spear.cutTick).toBeGreaterThanOrEqual(200);
    expect(spear.cutSpent).toBeGreaterThanOrEqual(2 * 27_624);
    // Past 40 deep a spearhead tile costs at least a broad push into a
    // post (152 to 168 a tile).
    const { game } = spear;
    const deep = spear.costs.filter((c) => game.y(c.tile) - 59 > 40);
    expect(deep.length).toBeGreaterThan(50);
    expect(deep.reduce((s, c) => s + c.loss, 0) / deep.length).toBeGreaterThan(
      152,
    );
  }, 60_000);

  it("a broad attack's numbers are what they were", async () => {
    const broad = await corridor(150_000, false);
    expect(broad.gained).toBe(1561);
    expect(broad.spent).toBe(150_000);
  }, 60_000);

  it("a post 25 deep still falls within 4.2 s (3.0 s before), median of 7", async () => {
    const ticks: number[] = [];
    for (let seed = 1; seed <= 7; seed++) {
      const t = await postBreak(125, 300_000, seed);
      ticks.push(t < 0 ? Infinity : t);
    }
    expect(median(ticks)).toBeLessThanOrEqual(42);
  }, 60_000);
});
