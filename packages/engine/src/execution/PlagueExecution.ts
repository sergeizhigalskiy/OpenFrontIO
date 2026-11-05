import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { renderTroops } from "@openfront/engine-lib/Format";
import {
  contactInfectionBps,
  contactInfectionLoss,
  INFECTED_NAME,
  INFECTED_PLAYER_ID,
  outbreakTiles,
  pickOutbreakCenter,
  PLAGUE_INTERVAL_TICKS,
  PLAGUE_OUTBREAK_DELAY_TICKS,
  PLAGUE_SPREAD_INTERVAL_TICKS,
  PLAGUE_START_TROOPS,
  plagueDecay,
} from "@openfront/engine-lib/game/Plague";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zPlayerRef,
  zRandom,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { AttackExecution } from "./AttackExecution";
import { PlayerExecution } from "./PlayerExecution";
import {
  razeNextStructure,
  refuseAllianceRequests,
} from "./utils/HostileFaction";

// Distinct from the other per-game seeds (runner +0, Executor +1,
// TribeSpawner +2, city-states +3, ruins +4, Horde Night +5).
const PLAGUE_SEED_OFFSET = 6;

// Reusable neighbor buffer; the simulation is single-threaded.
const NEIGHBORS: TileRef[] = [0, 0, 0, 0];

/**
 * The zombie plague (see engine-lib/game/Plague.ts). Breaks The Infected out
 * on schedule, then every interval: decays its pool, takes contact
 * infection from everyone bordering it, and spreads its whole pool across
 * all its borders as attacks. Capture conversion lives in AttackExecution;
 * pocket annexation and death in The Infected's own PlayerExecution.
 */
export class PlagueExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private infected: Player | null = null;
  // Players that lost troops to contact infection last interval (small ids,
  // ascending): only those just starting to bleed get the message.
  private bleeding: number[] = [];

  /** `seed` is the game id. */
  constructor(seed: string) {
    this.random = new PseudoRandom(simpleHash(seed) + PLAGUE_SEED_OFFSET);
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (this.mg.getWinner() !== null) {
      this.active = false;
      return;
    }
    if (this.infected === null) {
      const ticksSinceStart = Math.round(this.mg.elapsedGameSeconds() * 10);
      if (ticksSinceStart >= PLAGUE_OUTBREAK_DELAY_TICKS) this.breakOut();
      return;
    }
    const infected = this.infected;
    if (!infected.isAlive()) {
      // Wiped out: the plague is over (WinCheckExecution names the winner).
      this.active = false;
      return;
    }
    if (ticks % PLAGUE_INTERVAL_TICKS !== 0) return;
    refuseAllianceRequests(infected);
    razeNextStructure(this.mg, infected);
    decayInfected(infected);
    const border = infectedBorderCounts(this.mg, infected);
    this.bleeding = infectByContact(this.mg, infected, border, this.bleeding);
    if (ticks % PLAGUE_SPREAD_INTERVAL_TICKS === 0) {
      spreadInfected(this.mg, infected, border);
    }
  }

  /** The Infected, once it has broken out. */
  infectedPlayer(): Player | null {
    return this.infected;
  }

  private breakOut(): void {
    const spawns: TileRef[] = [];
    for (const p of this.mg.allPlayers()) {
      const spawn = p.spawnTile();
      if (spawn !== undefined) spawns.push(spawn);
    }
    const center = pickOutbreakCenter(this.mg.map(), this.random, spawns);
    if (center === null || this.mg.hasPlayer(INFECTED_PLAYER_ID)) {
      this.active = false;
      return;
    }
    const infected = this.mg.addPlayer(
      new PlayerInfo(INFECTED_NAME, PlayerType.Bot, null, INFECTED_PLAYER_ID),
    );
    for (const tile of outbreakTiles(this.mg.map(), center)) {
      infected.conquer(tile);
    }
    infected.setSpawnTile(center);
    infected.setTroops(PLAGUE_START_TROOPS);
    this.mg.addExecution(new PlayerExecution(infected));
    this.infected = infected;
    this.mg.displayMessage(
      "events_display.plague_outbreak",
      MessageType.NAVAL_INVASION_INBOUND,
      null,
      undefined,
      { troops: renderTroops(PLAGUE_START_TROOPS) },
    );
    spreadInfected(this.mg, infected, infectedBorderCounts(this.mg, infected));
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return PlagueExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      random: w.random(this.random),
      infected: this.infected === null ? null : w.player(this.infected),
      bleeding: [...this.bleeding],
    });
  }

  restoreSnapshot(s: PlagueState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.random = r.random(s.random);
    this.infected = s.infected === null ? null : r.player(s.infected);
    this.bleeding = [...s.bleeding];
  }
}

/** The pool decays: the troops at home and in every attack under way. */
export function decayInfected(infected: Player): void {
  infected.removeTroops(plagueDecay(infected.troops()));
  for (const attack of infected.outgoingAttacks()) {
    attack.setTroops(attack.troops() - plagueDecay(attack.troops()));
  }
}

/**
 * Per neighbour of The Infected (small id, 0 for free land), how many of its
 * land tiles touch infected land. Each tile counts once; in border order.
 */
export function infectedBorderCounts(
  game: Game,
  infected: Player,
): Map<number, number> {
  const map = game.map();
  const self = infected.smallID();
  const counts = new Map<number, number>();
  const seen = new Set<TileRef>();
  infected.borderTiles().forEach((tile) => {
    const n = map.neighbors4(tile, NEIGHBORS);
    for (let i = 0; i < n; i++) {
      const t = NEIGHBORS[i];
      if (!map.isLand(t) || map.isImpassable(t)) continue;
      const owner = map.ownerID(t);
      if (owner === self) continue;
      if (owner === 0 && map.hasFallout(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
  });
  return counts;
}

/**
 * Contact infection: everyone bordering infected land bleeds troops into
 * The Infected, by the shared border (`border`, from infectedBorderCounts).
 * Humans not in `wasBleeding` are told they've started losing troops.
 * Returns who bled this time (small ids, ascending).
 */
export function infectByContact(
  game: Game,
  infected: Player,
  border: Map<number, number>,
  wasBleeding: readonly number[],
): number[] {
  const bleeding: number[] = [];
  for (const [id, shared] of border) {
    if (id === 0) continue;
    const player = game.playerBySmallID(id);
    if (!player.isPlayer()) continue;
    const lost = player.removeTroops(
      contactInfectionLoss(player.troops(), shared),
    );
    if (lost <= 0) continue;
    infected.addTroops(lost);
    bleeding.push(id);
    if (!wasBleeding.includes(id) && player.type() === PlayerType.Human) {
      game.displayMessage(
        "events_display.plague_contact_infection",
        MessageType.UNIT_DESTROYED,
        player.id(),
        undefined,
        { percent: contactInfectionBps(shared) / 100 },
      );
    }
  }
  return bleeding.sort((a, b) => a - b);
}

/**
 * The Infected sends its whole pool out as attacks on every neighbour, free
 * land included, shared by how long each border is.
 */
export function spreadInfected(
  game: Game,
  infected: Player,
  border: Map<number, number>,
): void {
  const pool = infected.troops();
  if (pool < 1) return;
  let total = 0;
  for (const count of border.values()) total += count;
  if (total === 0) return;
  const neighbors = [...border];
  let sent = 0;
  neighbors.forEach(([id, count], i) => {
    const share =
      i === neighbors.length - 1
        ? pool - sent
        : Math.floor((pool * count) / total);
    sent += share;
    if (share < 1) return;
    const target = game.playerBySmallID(id);
    game.addExecution(
      new AttackExecution(
        share,
        infected,
        target.isPlayer() ? target.id() : game.terraNullius().id(),
      ),
    );
  });
}

const PlagueStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  random: zRandom(),
  infected: zPlayerRef().nullable(),
  bleeding: z.array(zInt()),
});
type PlagueState = z.infer<typeof PlagueStateSchema>;

export const PlagueExecutionSnapshot = execSnapshotType({
  name: "Plague",
  version: 1,
  schema: PlagueStateSchema,
  cls: () => PlagueExecution,
});
