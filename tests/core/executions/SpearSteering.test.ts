/**
 * Steered spearheads (spearhead round, G): a Shift+click spearhead takes the
 * tiles a broad attack would take, the ones nearer the click first, as a
 * bulge. Its tip leads its flanks by at most 15 tiles and moves at most 2.5x
 * as fast as a broad front, and it takes no more land than a broad attack
 * with the same troops. Clicking again carries it on instead of restarting it.
 */
import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  AttackExecution,
  SPEAR_LEAD_SLOPE,
  SPEAR_TIP_LEAD,
  SPEAR_TIP_PACE,
} from "@openfront/engine/execution/AttackExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { describe, expect, it } from "vitest";
import { setup } from "../../util/Setup";
import { UseRealAttackLogic } from "../../util/TestConfig";

const DEPTHS = [5, 10, 20, 30, 40, 60, 80];

/**
 * big_plains, the rest free land: A holds x 40-79 by y 60-139 with `troops`,
 * the nation D an `n` by `n` block east of it (x 80 on, centred on y = 100)
 * with `defense`. A attacks D with a `share` of its troops, as a spearhead
 * aimed at D's far edge on row 100 or broad, and while it runs clicks again
 * with 1 troop every `relaunch` ticks (0: never). Per run: the tick the tip took the
 * click (-1: never), the most the deepest of D's rows led the shallowest,
 * the tiles taken, and the tick row 100 first reached each of DEPTHS.
 */
async function box(opts: {
  share: number;
  spear: boolean;
  troops?: number;
  defense?: number;
  n?: number;
  relaunch?: number;
}) {
  const { share, spear, relaunch = 0 } = opts;
  const troops = opts.troops ?? 135_000;
  const n = opts.n ?? 40;
  const x0 = 80;
  const y0 = 100 - n / 2;
  const game = await setup(
    "big_plains",
    {},
    [
      new PlayerInfo("A", PlayerType.Human, "cA", "A_id"),
      new PlayerInfo("D", PlayerType.Nation, null, "D_id"),
    ],
    undefined,
    UseRealAttackLogic,
  );
  const a = game.player("A_id");
  const d = game.player("D_id");
  for (let x = 40; x < x0; x++) {
    for (let y = 60; y < 140; y++) a.conquer(game.ref(x, y));
  }
  for (let x = x0; x < x0 + n; x++) {
    for (let y = y0; y < y0 + n; y++) d.conquer(game.ref(x, y));
  }
  a.setTroops(troops);
  d.setTroops(opts.defense ?? 25_000);
  for (const p of [a, d]) game.addExecution(new PlayerExecution(p));
  game.executeNextTick();
  const click = game.ref(x0 + n - 1, 100);
  const focus = spear ? click : null;
  game.addExecution(
    new AttackExecution(
      Math.floor(troops * share),
      a,
      d.id(),
      null,
      true,
      focus,
    ),
  );
  const tilesBefore = a.numTilesOwned();
  // How far in row `y` A holds D's block without a gap.
  const depth = (y: number) => {
    let k = 0;
    while (k < n && game.owner(game.ref(x0 + k, y)) === a) k++;
    return k;
  };
  let tipTick = -1;
  let maxLead = 0;
  const reach = new Map<number, number>();
  for (let i = 0; i < 600; i++) {
    const running = a.outgoingAttacks().length > 0;
    if (relaunch > 0 && i > 0 && i % relaunch === 0 && running) {
      game.addExecution(new AttackExecution(1, a, d.id(), null, true, focus));
    }
    game.executeNextTick();
    let hi = 0;
    let lo = Infinity;
    for (let y = y0 + 2; y < y0 + n - 2; y++) {
      const k = depth(y);
      hi = Math.max(hi, k);
      lo = Math.min(lo, k);
    }
    if (hi < n) maxLead = Math.max(maxLead, hi - lo);
    if (tipTick < 0 && game.owner(click) === a) tipTick = i;
    const tip = depth(100);
    for (const k of DEPTHS) if (!reach.has(k) && tip >= k) reach.set(k, i + 1);
    if (a.outgoingAttacks().length === 0 && i > 5) break;
  }
  return {
    tipTick,
    maxLead,
    gained: a.numTilesOwned() - tilesBefore,
    reach,
  };
}

describe("steered spearheads", () => {
  it("lag their flanks at most 14 generations, one per tile off the tip, and at most their own generation", () => {
    expect(SPEAR_TIP_LEAD).toBe(14);
    expect(SPEAR_LEAD_SLOPE).toBe(1);
    expect(SPEAR_TIP_PACE).toBe(2);
  });

  // The playtest: 2.7k troops on a 2.5k nation 40 tiles deep (27k and 25k
  // here, the UI shows a tenth), with 20%, 50% and all of 135k sent.
  it("the designer's case: the tip leads by at most 15 tiles and takes more than twice as long", async () => {
    for (const share of [0.2, 0.5, 1]) {
      const spear = await box({ share, spear: true });
      expect(spear.maxLead, `${share}`).toBeLessThanOrEqual(15);
      if (share === 0.2) {
        // Took the click in 1.1 s before; now it runs out 10 to 12 deep.
        expect(spear.tipTick).toBe(-1);
      } else {
        // 0.7 s before; 4.1 s measured.
        expect(spear.tipTick, `${share}`).toBeGreaterThanOrEqual(35);
      }
    }
  }, 60_000);

  it("moves the tip at most 2.5x as fast as a broad front, and takes no more land", async () => {
    for (const share of [0.2, 0.5, 1]) {
      const spear = await box({ share, spear: true });
      const broad = await box({ share, spear: false });
      for (const k of DEPTHS) {
        const s = spear.reach.get(k);
        const b = broad.reach.get(k);
        if (s === undefined || b === undefined) continue;
        expect(b / s, `${share} depth ${k}`).toBeLessThanOrEqual(2.5);
      }
      // Broad reaches row 100's 10 deep in 25 ticks at 20%, 40 in 54 at more.
      expect(broad.reach.get(share === 0.2 ? 10 : 40)).toBeGreaterThan(20);
      expect(spear.gained, `${share}`).toBeLessThanOrEqual(broad.gained);
    }
  }, 60_000);

  it("clicking again every half second neither stretches the tip ahead nor speeds it up", async () => {
    // 300k on 100k, 80 tiles deep: restarting the lag on each click led the
    // tip 39 tiles ahead and took the click in 6.7 s instead of 10.
    const big = { troops: 300_000, defense: 100_000, n: 80 };
    const once = await box({ ...big, share: 1, spear: true });
    const spam = await box({ ...big, share: 1, spear: true, relaunch: 5 });
    const broad = await box({ ...big, share: 1, spear: false });
    expect(spam.maxLead).toBeLessThanOrEqual(15);
    expect(spam.tipTick).toBeGreaterThanOrEqual(once.tipTick - 2);
    expect(once.tipTick).toBeGreaterThan(90);
    expect(spam.gained).toBeLessThanOrEqual(broad.gained);
  }, 60_000);
});
