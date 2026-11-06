import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { renderNumber, renderTroops } from "@openfront/engine-lib/Format";
import {
  contactInfectionBps,
  contactInfectionLoss,
  INFECTED_NAME,
  INFECTED_PLAYER_ID,
  outbreakTiles,
  pickOutbreakCenter,
  PLAGUE_COMEBACK_DELAY_TICKS,
  PLAGUE_CURE_GROWTH_PERCENT,
  PLAGUE_CURE_GROWTH_TICKS,
  PLAGUE_INTERVAL_TICKS,
  PLAGUE_MIN_SPAWN_DISTANCE,
  PLAGUE_OUTBREAK_DELAY_TICKS,
  PLAGUE_OUTBREAK_RETRY_TICKS,
  PLAGUE_SPREAD_INTERVAL_TICKS,
  plagueComebackTroops,
  plagueComesBack,
  plagueCureGold,
  plagueDecay,
  plagueSiteCount,
  plagueSpreadTroops,
  plagueStartTroops,
} from "@openfront/engine-lib/game/Plague";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRandom,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { listenForInfectedConquest } from "../game/PlagueCure";
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
 * infection from everyone bordering it, and sends half its pool across its
 * borders as attacks. When it is wiped out it pays the cure to whoever took
 * its last tile, and schedules the comeback outbreak. Capture conversion
 * lives in AttackExecution; pocket annexation and death in The Infected's own
 * PlayerExecution.
 */
export class PlagueExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private infected: Player | null = null;
  // Players that lost troops to contact infection last interval (small ids,
  // ascending): only those just starting to bleed get the message.
  private bleeding: number[] = [];
  // Outbreaks so far, and the troops the last one started with.
  private outbreaks = 0;
  private lastStartTroops = 0;
  // Ticks since the spawn phase at which the next outbreak comes; null when
  // none is due.
  private nextOutbreakTick: number | null = PLAGUE_OUTBREAK_DELAY_TICKS;
  // Whether The Infected was alive at the end of the last tick.
  private infectedAlive = false;
  // The last player to conquer The Infected (GameImpl.conquerPlayer).
  private lastConqueror: Player | null = null;
  // Whoever cured the last outbreak grows faster until this tick.
  private cureBonusPlayer: Player | null = null;
  private cureBonusUntil = 0;

  /** `seed` is the game id. */
  constructor(seed: string) {
    this.random = new PseudoRandom(simpleHash(seed) + PLAGUE_SEED_OFFSET);
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game): void {
    this.mg = mg;
    listenForInfectedConquest(mg, this);
  }

  infectedConquered(conqueror: Player): void {
    this.lastConqueror = conqueror;
  }

  tick(ticks: number): void {
    if (this.mg.getWinner() !== null) {
      this.active = false;
      return;
    }
    const since = this.mg.ticksSinceStart();
    this.growCurer(since);

    const infected = this.infected;
    if (infected !== null && infected.isAlive()) {
      this.infectedAlive = true;
      if (ticks % PLAGUE_INTERVAL_TICKS !== 0) return;
      refuseAllianceRequests(infected);
      razeNextStructure(this.mg, infected);
      decayInfected(infected);
      const border = infectedBorderCounts(this.mg, infected);
      this.bleeding = infectByContact(this.mg, infected, border, this.bleeding);
      if (ticks % PLAGUE_SPREAD_INTERVAL_TICKS === 0) {
        spreadInfected(this.mg, infected, border);
      }
      return;
    }
    if (this.infectedAlive) {
      this.infectedAlive = false;
      this.cured(since);
    }
    if (this.nextOutbreakTick !== null && since >= this.nextOutbreakTick) {
      this.breakOut(since);
    }
  }

  /** The Infected, once it has broken out. */
  infectedPlayer(): Player | null {
    return this.infected;
  }

  /** Outbreaks so far. */
  outbreakCount(): number {
    return this.outbreaks;
  }

  /** Ticks since the spawn phase of the next outbreak, or null. */
  nextOutbreak(): number | null {
    return this.nextOutbreakTick;
  }

  // The Infected was just wiped out: pay whoever took its last tile, and
  // schedule the comeback.
  private cured(since: number): void {
    this.bleeding = [];
    const curer = this.lastConqueror;
    this.lastConqueror = null;
    if (
      curer !== null &&
      curer.isAlive() &&
      (curer.type() === PlayerType.Human || curer.type() === PlayerType.Nation)
    ) {
      const gold = plagueCureGold(
        this.outbreaks,
        this.mg.config().goldMultiplier(),
      );
      curer.addGold(gold);
      this.cureBonusPlayer = curer;
      this.cureBonusUntil = since + PLAGUE_CURE_GROWTH_TICKS;
      this.mg.displayMessage(
        "events_display.plague_cured_you",
        MessageType.CONQUERED_PLAYER,
        curer.id(),
        gold,
        { gold: renderNumber(gold), percent: PLAGUE_CURE_GROWTH_PERCENT },
      );
      this.mg.displayMessage(
        "events_display.plague_cured",
        MessageType.NAVAL_INVASION_INBOUND,
        null,
        undefined,
        { name: curer.displayName() },
      );
    }
    if (plagueComesBack(this.outbreaks, since)) {
      this.nextOutbreakTick = since + PLAGUE_COMEBACK_DELAY_TICKS;
      this.mg.displayMessage(
        "events_display.plague_comeback",
        MessageType.NAVAL_INVASION_INBOUND,
        null,
        undefined,
        { minutes: PLAGUE_COMEBACK_DELAY_TICKS / 600 },
      );
    } else {
      this.nextOutbreakTick = null;
      this.active = this.cureBonusPlayer !== null;
    }
  }

  // The cure's reward: +25% troop growth for its player while it lasts.
  private growCurer(since: number): void {
    const player = this.cureBonusPlayer;
    if (player === null) return;
    if (since >= this.cureBonusUntil || !player.isAlive()) {
      this.cureBonusPlayer = null;
      if (this.nextOutbreakTick === null && !this.infectedAlive) {
        this.active = false;
      }
      return;
    }
    const rate = this.mg.config().troopIncreaseRate(player, since);
    if (rate > 0) player.addTroops((rate * PLAGUE_CURE_GROWTH_PERCENT) / 100);
  }

  private breakOut(since: number): void {
    const players = this.mg
      .players()
      .filter(
        (p) => p.type() === PlayerType.Human || p.type() === PlayerType.Nation,
      );
    const spawns: TileRef[] = [];
    for (const p of this.mg.allPlayers()) {
      if (p.type() === PlayerType.Bot) continue;
      const spawn = p.spawnTile();
      if (spawn !== undefined) spawns.push(spawn);
    }
    const centers: TileRef[] = [];
    for (let i = 0; i < plagueSiteCount(players.length); i++) {
      const pick = pickOutbreakCenter(this.mg.map(), this.random, [
        ...spawns,
        ...centers,
      ]);
      if (pick === null) break;
      if (!pick.farEnough) {
        console.log(
          `plague: no free land ${PLAGUE_MIN_SPAWN_DISTANCE} tiles from every spawn, breaking out on the farthest`,
        );
      }
      centers.push(pick.tile);
    }
    if (centers.length === 0) {
      // No free land at all: try again shortly.
      this.nextOutbreakTick = since + PLAGUE_OUTBREAK_RETRY_TICKS;
      return;
    }

    let strongest = 0;
    for (const p of players) strongest = Math.max(strongest, p.troops());
    const troops =
      this.outbreaks === 0
        ? plagueStartTroops(strongest)
        : plagueComebackTroops(this.lastStartTroops);
    this.outbreaks++;
    this.lastStartTroops = troops;
    this.nextOutbreakTick = null;

    let infected: Player;
    if (this.mg.hasPlayer(INFECTED_PLAYER_ID)) {
      infected = this.mg.player(INFECTED_PLAYER_ID);
    } else {
      infected = this.mg.addPlayer(
        new PlayerInfo(INFECTED_NAME, PlayerType.Bot, null, INFECTED_PLAYER_ID),
      );
    }
    for (const center of centers) {
      for (const tile of outbreakTiles(this.mg.map(), center)) {
        infected.conquer(tile);
      }
    }
    if (!infected.isAlive()) {
      this.nextOutbreakTick = since + PLAGUE_OUTBREAK_RETRY_TICKS;
      this.outbreaks--;
      return;
    }
    infected.setSpawnTile(centers[0]);
    infected.setTroops(troops);
    this.mg.addExecution(new PlayerExecution(infected));
    this.infected = infected;
    this.infectedAlive = true;
    this.lastConqueror = null;
    this.mg.displayMessage(
      "events_display.plague_outbreak",
      MessageType.NAVAL_INVASION_INBOUND,
      null,
      undefined,
      { troops: renderTroops(troops) },
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
      outbreaks: this.outbreaks,
      lastStartTroops: this.lastStartTroops,
      nextOutbreakTick: this.nextOutbreakTick,
      infectedAlive: this.infectedAlive,
      lastConqueror:
        this.lastConqueror === null ? null : w.player(this.lastConqueror),
      cureBonusPlayer:
        this.cureBonusPlayer === null ? null : w.player(this.cureBonusPlayer),
      cureBonusUntil: this.cureBonusUntil,
    });
  }

  restoreSnapshot(s: PlagueState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) {
      this.mg = r.game;
      listenForInfectedConquest(r.game, this);
    }
    this.random = r.random(s.random);
    this.infected = s.infected === null ? null : r.player(s.infected);
    this.bleeding = [...s.bleeding];
    this.outbreaks = s.outbreaks;
    this.lastStartTroops = s.lastStartTroops;
    this.nextOutbreakTick = s.nextOutbreakTick;
    this.infectedAlive = s.infectedAlive;
    this.lastConqueror =
      s.lastConqueror === null ? null : r.player(s.lastConqueror);
    this.cureBonusPlayer =
      s.cureBonusPlayer === null ? null : r.player(s.cureBonusPlayer);
    this.cureBonusUntil = s.cureBonusUntil;
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
 * The Infected sends half its pool (PLAGUE_SPREAD_PERCENT) out as attacks on
 * every neighbour, free land included, shared by how long each border is.
 * The rest stays home as a garrison.
 */
export function spreadInfected(
  game: Game,
  infected: Player,
  border: Map<number, number>,
): void {
  const pool = plagueSpreadTroops(infected.troops());
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
  outbreaks: zInt(),
  lastStartTroops: zNum(),
  nextOutbreakTick: zInt().nullable(),
  infectedAlive: z.boolean(),
  lastConqueror: zPlayerRef().nullable(),
  cureBonusPlayer: zPlayerRef().nullable(),
  cureBonusUntil: zInt(),
});
type PlagueState = z.infer<typeof PlagueStateSchema>;

export const PlagueExecutionSnapshot = execSnapshotType({
  name: "Plague",
  version: 2,
  schema: PlagueStateSchema,
  // v2: outbreaks at 4:00 that come back, and the cure. An older game had
  // its one outbreak at 2:00 (or has it still to come) and never comes back.
  migrations: {
    1: (d) => {
      const old = d as Record<string, unknown>;
      const broke = old.infected !== null;
      return {
        ...old,
        outbreaks: broke ? 3 : 0,
        lastStartTroops: 30_000,
        nextOutbreakTick: broke ? null : 2 * 60 * 10,
        infectedAlive: broke,
        lastConqueror: null,
        cureBonusPlayer: null,
        cureBonusUntil: 0,
      };
    },
  },
  cls: () => PlagueExecution,
});
