import {
  MessageType,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  CALL_TO_WAR_ATTACK_WINDOW_TICKS,
  CALL_TO_WAR_CHECK_TICKS,
  CALL_TO_WAR_COOLDOWN_TICKS,
  CALL_TO_WAR_TICKS,
  callToWarCost,
  INCOME_BONUS_TICKS,
  namesProtectedState,
  PATRON_RECOMPUTE_TICKS,
  patronConvoyTroops,
  PEACE_CONVOY_SHARE,
  PEACE_CONVOY_TICKS,
  PROTECTED_STATE_MODE_NAME,
  PROTECTED_STATE_NATION,
  PROTECTED_STATE_PATRONS,
  protectedIncomeBonus,
  TRIBUTE_TICKS,
  tributePerPatron,
  UNDER_ATTACK_TICKS,
  WAR_CONVOY_SHARE,
  WAR_CONVOY_TICKS,
} from "@openfront/engine-lib/game/ProtectedState";
import {
  zInt,
  zNum,
  zPlayerRef,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import {
  linkProtectedState,
  ProtectedStateMode,
} from "../game/ProtectedStateLink";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { CONVOY_TILES_PER_TICK, ConvoyExecution } from "./ConvoyExecution";
import { convoyStraightDistance, planConvoyRoute } from "./ConvoyRoute";

/** An attack on the Protected State, as last seen. */
interface AttackSeen {
  id: string;
  attacker: Player;
  /** The most troops it has had. */
  troops: number;
  /** The last tick it was running. */
  tick: number;
}

/** Troops sent with no route, delivered at `tick`. */
interface DirectDelivery {
  sender: Player;
  troops: number;
  tick: number;
}

interface CallToWar {
  target: Player;
  endTick: number;
}

/**
 * The Protected State mode (rules and numbers in engine-lib
 * game/ProtectedState.ts). On its first tick after the spawn phase it picks
 * the Protected State and its patrons; from then on it pays the income bonus
 * and the tribute, sends the patrons' troop convoys, and has the Protected
 * State call its patrons to war. The attack rules and the nation AI ask it
 * through game/ProtectedStateLink.ts. It ends, quietly, when the Protected
 * State falls.
 */
export class ProtectedStateExecution implements Execution, ProtectedStateMode {
  private active = true;
  private mg: Game;
  private picked = false;
  // Null until picked, and if no nation qualifies.
  private state: Player | null = null;
  // Strongest first.
  private patrons: Player[] = [];
  private nextPatronTick = 0;
  private nextTributeTick = 0;
  private nextBonusTick = 0;
  // Its goldEarned at the last tribute and at the last income bonus.
  private earnedAtTribute = 0n;
  private earnedAtBonus = 0n;
  private lastConvoyTick = 0;
  private lastAttackedTick: number | null = null;
  private attacks: AttackSeen[] = [];
  private deliveries: DirectDelivery[] = [];
  private call: CallToWar | null = null;
  private lastCallTick: number | null = null;
  private callsToWar = 0;
  private tributePaid = 0n;

  /** `nation`: the nation that gets the status, by name (null: the smallest). */
  constructor(private nation: string | null = PROTECTED_STATE_NATION) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game): void {
    this.mg = mg;
    linkProtectedState(mg, this);
  }

  tick(): void {
    const now = this.mg.ticks();
    if (!this.picked) {
      this.picked = true;
      this.pick(now);
    }
    const state = this.state;
    if (state === null) {
      this.active = false;
      return;
    }
    if (!state.isAlive()) {
      this.end();
      return;
    }
    this.payIncomeBonus(state, now);
    this.watchAttacks(state, now);
    if (now >= this.nextPatronTick) this.choosePatrons(state, now);
    if (now >= this.nextTributeTick) this.payTribute(state, now);
    this.deliverDue(state, now);
    this.sendConvoys(state, now);
    if (this.call !== null) {
      const call = this.call;
      if (now >= call.endTick || !call.target.isAlive()) this.call = null;
    }
    if (now % CALL_TO_WAR_CHECK_TICKS === 0) this.considerCallToWar(state, now);
  }

  // --- ProtectedStateMode -----------------------------------------------------

  protectedState(): Player | null {
    const state = this.state;
    if (!this.active || state === null || !state.isAlive()) return null;
    return state;
  }

  isPatron(player: Player): boolean {
    return this.protectedState() !== null && this.patrons.includes(player);
  }

  callToWarTarget(patron: Player): Player | null {
    const call = this.call;
    if (call === null || this.mg.ticks() >= call.endTick) return null;
    if (!this.isPatron(patron) || patron === call.target) return null;
    if (!call.target.isAlive() || patron.isFriendly(call.target)) return null;
    return call.target;
  }

  // --- What tests and the view read ----------------------------------------

  /** The patrons now, strongest first. */
  currentPatrons(): readonly Player[] {
    return this.protectedState() === null ? [] : this.patrons;
  }

  /** The running call to war, or null. */
  currentCallToWar(): Readonly<CallToWar> | null {
    return this.call;
  }

  /** Calls to war made so far. */
  callsToWarMade(): number {
    return this.callsToWar;
  }

  /** Gold paid to patrons so far. */
  totalTributePaid(): bigint {
    return this.tributePaid;
  }

  /**
   * The Protected State calls its patrons to war on `target`, if it can now:
   * the target is alive, neither it, a friend of it, a patron, a tribe nor
   * a city-state, no call is running or cooling down, and it can pay
   * callToWarCost. Each patron not friendly with the target attacks it for
   * CALL_TO_WAR_TICKS (NationAttackBehavior). Returns whether it called.
   */
  callToWar(target: Player): boolean {
    const state = this.protectedState();
    if (state === null || !this.canBeCalledOn(state, target)) return false;
    const now = this.mg.ticks();
    if (this.call !== null) return false;
    if (
      this.lastCallTick !== null &&
      now - this.lastCallTick < CALL_TO_WAR_COOLDOWN_TICKS
    ) {
      return false;
    }
    const cost = callToWarCost(state.gold());
    if (cost === null) return false;
    state.removeGold(cost);
    this.call = { target, endTick: now + CALL_TO_WAR_TICKS };
    this.lastCallTick = now;
    this.callsToWar++;
    this.mg.displayMessage(
      "events_display.protected_state_call_to_war",
      MessageType.ATTACK_REQUEST,
      null,
      undefined,
      { nation: state.displayName(), target: target.displayName() },
      undefined,
      target.id(),
    );
    return true;
  }

  // --- The rules --------------------------------------------------------------

  // The named nation, else the nation with the fewest tiles (lowest smallID
  // on a tie). Only nations qualify: never a human, tribe or city-state.
  private pick(now: number): void {
    const nations = this.mg
      .players()
      .filter(
        (p) =>
          p.type() === PlayerType.Nation && !p.isCityState() && p.isAlive(),
      );
    let chosen: Player | null = null;
    for (const p of nations) {
      if (
        namesProtectedState(p.name(), this.nation) ||
        namesProtectedState(p.displayName(), this.nation)
      ) {
        chosen = p;
        break;
      }
    }
    if (chosen === null) {
      for (const p of nations) {
        if (
          chosen === null ||
          p.numTilesOwned() < chosen.numTilesOwned() ||
          (p.numTilesOwned() === chosen.numTilesOwned() &&
            p.smallID() < chosen.smallID())
        ) {
          chosen = p;
        }
      }
    }
    if (chosen === null) return;
    this.state = chosen;
    this.earnedAtTribute = chosen.goldEarned();
    this.earnedAtBonus = chosen.goldEarned();
    this.nextTributeTick = now + TRIBUTE_TICKS;
    this.nextBonusTick = now + INCOME_BONUS_TICKS;
    this.lastConvoyTick = now;
    this.mg.displayMessage(
      "events_display.protected_state_named",
      MessageType.ALLIANCE_ACCEPTED,
      null,
      undefined,
      { nation: chosen.displayName(), mode: PROTECTED_STATE_MODE_NAME },
      undefined,
      chosen.id(),
    );
    this.choosePatrons(chosen, now);
    this.emit();
  }

  // The PROTECTED_STATE_PATRONS strongest nations by troops (lowest smallID
  // on a tie), never the Protected State, a human, a tribe or a city-state.
  private choosePatrons(state: Player, now: number): void {
    this.nextPatronTick = now + PATRON_RECOMPUTE_TICKS;
    const next = this.mg
      .players()
      .filter(
        (p) =>
          p !== state &&
          p.isAlive() &&
          p.type() === PlayerType.Nation &&
          !p.isCityState(),
      )
      .sort((a, b) => b.troops() - a.troops() || a.smallID() - b.smallID())
      .slice(0, PROTECTED_STATE_PATRONS);
    const changed =
      next.length !== this.patrons.length ||
      next.some((p, i) => p !== this.patrons[i]);
    this.patrons = next;
    // Patrons never attack it: one that was attacking it pulls back, its
    // attacks and its boats alike.
    for (const patron of next) {
      for (const attack of patron.outgoingAttacks()) {
        if (attack.target() === state && !attack.retreating()) {
          attack.orderRetreat();
        }
      }
      for (const boat of patron.units(UnitType.TransportShip)) {
        const dst = boat.targetTile();
        if (
          dst !== undefined &&
          this.mg.owner(dst) === state &&
          !boat.transportShipState().isRetreating
        ) {
          boat.updateTransportShipState({ isRetreating: true });
        }
      }
    }
    // A target that became a patron is off: patrons don't fight each other.
    if (this.call !== null && next.includes(this.call.target)) {
      this.call = null;
    }
    if (changed) this.emit();
  }

  // Every INCOME_BONUS_TICKS: PROTECTED_INCOME_MULTIPLIER - 1 times the gold
  // it earned since the last bonus, so it earns that multiple in all.
  private payIncomeBonus(state: Player, now: number): void {
    if (now < this.nextBonusTick) return;
    this.nextBonusTick = now + INCOME_BONUS_TICKS;
    const bonus = protectedIncomeBonus(state.goldEarned() - this.earnedAtBonus);
    if (bonus > 0n) state.addGold(bonus);
    this.earnedAtBonus = state.goldEarned();
  }

  // TRIBUTE_SHARE of the gold earned since the last tribute (the bonus
  // included), split evenly among the living patrons.
  private payTribute(state: Player, now: number): void {
    this.nextTributeTick = now + TRIBUTE_TICKS;
    const earned = state.goldEarned() - this.earnedAtTribute;
    this.earnedAtTribute = state.goldEarned();
    const patrons = this.patrons.filter((p) => p.isAlive());
    const each = tributePerPatron(earned, patrons.length);
    if (each <= 0n) return;
    for (const patron of patrons) {
      const paid = state.removeGold(each);
      if (paid <= 0n) break;
      patron.addGold(paid);
      this.tributePaid += paid;
    }
  }

  private watchAttacks(state: Player, now: number): void {
    for (const attack of state.incomingAttacks()) {
      this.lastAttackedTick = now;
      const id = attack.id();
      const seen = this.attacks.find((a) => a.id === id);
      if (seen === undefined) {
        this.attacks.push({
          id,
          attacker: attack.attacker(),
          troops: attack.troops(),
          tick: now,
        });
      } else {
        seen.troops = Math.max(seen.troops, attack.troops());
        seen.tick = now;
      }
    }
    if (this.attacks.length > 0) {
      this.attacks = this.attacks.filter(
        (a) => now - a.tick < CALL_TO_WAR_ATTACK_WINDOW_TICKS,
      );
    }
  }

  private underAttack(now: number): boolean {
    return (
      this.lastAttackedTick !== null &&
      now - this.lastAttackedTick < UNDER_ATTACK_TICKS
    );
  }

  // Each patron, strongest first, sends PEACE_CONVOY_SHARE of its troops
  // every PEACE_CONVOY_TICKS, or WAR_CONVOY_SHARE every WAR_CONVOY_TICKS
  // under attack. Like any donation, no more than the Protected State has
  // room for, counting the troops already on the way.
  private sendConvoys(state: Player, now: number): void {
    const underAttack = this.underAttack(now);
    const interval = underAttack ? WAR_CONVOY_TICKS : PEACE_CONVOY_TICKS;
    if (now - this.lastConvoyTick < interval) return;
    this.lastConvoyTick = now;
    const share = underAttack ? WAR_CONVOY_SHARE : PEACE_CONVOY_SHARE;
    let room = this.room(state);
    for (const patron of this.patrons) {
      if (room < 1) break;
      if (!patron.isAlive()) continue;
      const troops = Math.min(patronConvoyTroops(patron.troops(), share), room);
      if (troops < 1) continue;
      room -= troops;
      this.sendConvoy(patron, state, troops, now);
    }
  }

  // Troops the Protected State can still take: its cap, less its troops and
  // what is already on the way to it.
  private room(state: Player): number {
    let coming = 0;
    for (const convoy of this.mg.units(UnitType.Convoy)) {
      if (convoy.isActive() && convoy.targetPlayer() === state) {
        coming += convoy.troops();
      }
    }
    for (const d of this.deliveries) coming += d.troops;
    return Math.floor(
      this.mg.config().maxTroops(state) - state.troops() - coming,
    );
  }

  // A troop convoy by the usual route and ambush rules; with no route, the
  // troops leave now and arrive after the time a convoy would take.
  private sendConvoy(
    patron: Player,
    state: Player,
    troops: number,
    now: number,
  ): void {
    const route = planConvoyRoute(this.mg, patron, state, troops);
    if (route === null) {
      const sent = patron.removeTroops(troops);
      if (sent <= 0) return;
      const distance = convoyStraightDistance(this.mg, patron, state);
      this.deliveries.push({
        sender: patron,
        troops: sent,
        tick: now + Math.ceil(distance / CONVOY_TILES_PER_TICK),
      });
      return;
    }
    // buildUnit takes the convoy's troops from the patron.
    const convoy = patron.buildUnit(UnitType.Convoy, route[0], {
      troops,
      targetTile: route[route.length - 1],
      targetPlayer: state,
    });
    this.mg.addExecution(new ConvoyExecution(convoy, state, route, 0, true));
  }

  private deliverDue(state: Player, now: number): void {
    if (this.deliveries.length === 0) return;
    const due = this.deliveries.filter((d) => d.tick <= now);
    if (due.length === 0) return;
    this.deliveries = this.deliveries.filter((d) => d.tick > now);
    for (const d of due) {
      const room = Math.max(
        0,
        Math.floor(this.mg.config().maxTroops(state) - state.troops()),
      );
      const delivered = Math.min(d.troops, room);
      state.receiveTroopDonation(d.sender, delivered);
      this.refund(d.sender, d.troops - delivered);
    }
  }

  // Troops back to `sender`, up to its troop cap, as a convoy refunds.
  private refund(sender: Player, troops: number): void {
    if (troops <= 0 || !sender.isAlive()) return;
    const room = Math.max(
      0,
      Math.floor(this.mg.config().maxTroops(sender) - sender.troops()),
    );
    const back = Math.min(troops, room);
    if (back > 0) sender.addTroops(back);
  }

  // The AI: on whoever attacked it most over the last minute; when nobody is
  // attacking it, on its strongest neighbour. Only when it can pay.
  private considerCallToWar(state: Player, now: number): void {
    if (this.call !== null || this.patrons.length === 0) return;
    if (
      this.lastCallTick !== null &&
      now - this.lastCallTick < CALL_TO_WAR_COOLDOWN_TICKS
    ) {
      return;
    }
    if (callToWarCost(state.gold()) === null) return;
    const target =
      this.topAttacker(state) ??
      (this.underAttack(now) ? null : this.strongestNeighbour(state));
    if (target !== null) this.callToWar(target);
  }

  // Tribes are left out, as the nation AI leaves them out of its threats.
  private canBeCalledOn(state: Player, target: Player): boolean {
    return (
      target !== state &&
      target.isAlive() &&
      target.type() !== PlayerType.Bot &&
      !target.isCityState() &&
      !this.patrons.includes(target) &&
      !state.isFriendly(target)
    );
  }

  // Most troops sent at it over CALL_TO_WAR_ATTACK_WINDOW_TICKS (lowest
  // smallID on a tie).
  private topAttacker(state: Player): Player | null {
    const sent = new Map<Player, number>();
    for (const a of this.attacks) {
      if (!this.canBeCalledOn(state, a.attacker)) continue;
      sent.set(a.attacker, (sent.get(a.attacker) ?? 0) + a.troops);
    }
    return mostOf(sent);
  }

  private strongestNeighbour(state: Player): Player | null {
    const troops = new Map<Player, number>();
    for (const n of state.nearby()) {
      if (n.isPlayer() && this.canBeCalledOn(state, n)) {
        troops.set(n, n.troops());
      }
    }
    return mostOf(troops);
  }

  // The mode ends: troops sent with no route go back to their senders.
  private end(): void {
    this.active = false;
    for (const d of this.deliveries) this.refund(d.sender, d.troops);
    this.deliveries = [];
    this.patrons = [];
    this.call = null;
    this.emit();
  }

  private emit(): void {
    const state = this.protectedState();
    this.mg.addUpdate({
      type: GameUpdateType.Cataclysm,
      kind: "protectedState",
      state: state === null ? 0 : state.smallID(),
      patrons: state === null ? [] : this.patrons.map((p) => p.smallID()),
    });
  }

  viewResync(): void {
    if (this.mg !== undefined && this.picked) this.emit();
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return ProtectedStateExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      nation: this.nation,
      picked: this.picked,
      state: this.state === null ? null : w.player(this.state),
      patrons: this.patrons.map((p) => w.player(p)),
      nextPatronTick: this.nextPatronTick,
      nextTributeTick: this.nextTributeTick,
      nextBonusTick: this.nextBonusTick,
      earnedAtTribute: this.earnedAtTribute,
      earnedAtBonus: this.earnedAtBonus,
      lastConvoyTick: this.lastConvoyTick,
      lastAttackedTick: this.lastAttackedTick,
      attacks: this.attacks.map((a) => ({
        id: a.id,
        attacker: w.player(a.attacker),
        troops: a.troops,
        tick: a.tick,
      })),
      deliveries: this.deliveries.map((d) => ({
        sender: w.player(d.sender),
        troops: d.troops,
        tick: d.tick,
      })),
      call:
        this.call === null
          ? null
          : { target: w.player(this.call.target), endTick: this.call.endTick },
      lastCallTick: this.lastCallTick,
      callsToWar: this.callsToWar,
      tributePaid: this.tributePaid,
    });
  }

  restoreSnapshot(s: ProtectedStateState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) {
      this.mg = r.game;
      linkProtectedState(r.game, this);
    }
    this.nation = s.nation;
    this.picked = s.picked;
    this.state = s.state === null ? null : r.player(s.state);
    this.patrons = s.patrons.map((p) => r.player(p));
    this.nextPatronTick = s.nextPatronTick;
    this.nextTributeTick = s.nextTributeTick;
    this.nextBonusTick = s.nextBonusTick;
    this.earnedAtTribute = s.earnedAtTribute;
    this.earnedAtBonus = s.earnedAtBonus;
    this.lastConvoyTick = s.lastConvoyTick;
    this.lastAttackedTick = s.lastAttackedTick;
    this.attacks = s.attacks.map((a) => ({
      id: a.id,
      attacker: r.player(a.attacker),
      troops: a.troops,
      tick: a.tick,
    }));
    this.deliveries = s.deliveries.map((d) => ({
      sender: r.player(d.sender),
      troops: d.troops,
      tick: d.tick,
    }));
    this.call =
      s.call === null
        ? null
        : { target: r.player(s.call.target), endTick: s.call.endTick };
    this.lastCallTick = s.lastCallTick;
    this.callsToWar = s.callsToWar;
    this.tributePaid = s.tributePaid;
  }
}

/** The key with the largest value, the lowest smallID on a tie. */
function mostOf(values: Map<Player, number>): Player | null {
  let best: Player | null = null;
  let bestValue = -Infinity;
  for (const [p, v] of values) {
    if (
      best === null ||
      v > bestValue ||
      (v === bestValue && p.smallID() < best.smallID())
    ) {
      best = p;
      bestValue = v;
    }
  }
  return best;
}

const ProtectedStateStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  nation: z.string().nullable(),
  picked: z.boolean(),
  state: zPlayerRef().nullable(),
  patrons: z.array(zPlayerRef()),
  nextPatronTick: zInt(),
  nextTributeTick: zInt(),
  nextBonusTick: zInt(),
  earnedAtTribute: z.bigint(),
  earnedAtBonus: z.bigint(),
  lastConvoyTick: zInt(),
  lastAttackedTick: zInt().nullable(),
  attacks: z.array(
    z.object({
      id: z.string(),
      attacker: zPlayerRef(),
      troops: zNum(),
      tick: zInt(),
    }),
  ),
  deliveries: z.array(
    z.object({ sender: zPlayerRef(), troops: zNum(), tick: zInt() }),
  ),
  call: z.object({ target: zPlayerRef(), endTick: zInt() }).nullable(),
  lastCallTick: zInt().nullable(),
  callsToWar: zInt(),
  tributePaid: z.bigint(),
});
type ProtectedStateState = z.infer<typeof ProtectedStateStateSchema>;

export const ProtectedStateExecutionSnapshot = execSnapshotType({
  name: "ProtectedState",
  version: 1,
  schema: ProtectedStateStateSchema,
  cls: () => ProtectedStateExecution,
});
