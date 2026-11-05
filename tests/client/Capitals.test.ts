import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { describe, expect, it } from "vitest";
import {
  CapitalPlayer,
  heldCapitalsGoldBonusPct,
  isCapitalLost,
} from "../../src/client/utilities/Capitals";

interface FakePlayer extends CapitalPlayer {
  friends: Set<FakePlayer>;
  alive: boolean;
}

function player(
  smallID: number,
  capitalTile: number | undefined,
  type = PlayerType.Human,
): FakePlayer {
  const p: FakePlayer = {
    state: { capitalTile },
    friends: new Set(),
    alive: true,
    smallID: () => smallID,
    type: () => type,
    isAlive: () => p.alive,
    isFriendly: (other) => p.friends.has(other as FakePlayer),
  };
  return p;
}

/** Tile n is owned by smallID owners[n]. */
function game(players: FakePlayer[], owners: Record<number, number>) {
  return {
    ownerID: (tile: number) => owners[tile] ?? 0,
    players: () => players,
  };
}

describe("capitals in the HUD", () => {
  it("a capital is lost while anyone else holds its tile", () => {
    const a = player(1, 10);
    expect(isCapitalLost(game([a], { 10: 1 }), a)).toBe(false);
    expect(isCapitalLost(game([a], { 10: 2 }), a)).toBe(true);
    // No capital outside conventional war.
    const plain = player(1, undefined);
    expect(isCapitalLost(game([plain], {}), plain)).toBe(false);
  });

  it("+10% per enemy capital held, capped at +30%", () => {
    const me = player(1, 10);
    const others = [2, 3, 4, 5].map((id) => player(id, 20 + id));
    const all = [me, ...others];
    const held = (n: number) => {
      const owners: Record<number, number> = { 10: 1 };
      others.slice(0, n).forEach((o) => (owners[o.state.capitalTile!] = 1));
      return heldCapitalsGoldBonusPct(game(all, owners), me);
    };
    expect([0, 1, 2, 4].map(held)).toEqual([0, 10, 20, 30]);
  });

  it("no prize for a friend's, a tribe's or a fallen player's capital", () => {
    const me = player(1, 10);
    const friend = player(2, 22);
    me.friends.add(friend);
    const tribe = player(3, 23, PlayerType.Bot);
    const fallen = player(4, 24);
    fallen.alive = false;
    const owners = { 10: 1, 22: 1, 23: 1, 24: 1 };
    expect(
      heldCapitalsGoldBonusPct(game([me, friend, tribe, fallen], owners), me),
    ).toBe(0);
  });
});
