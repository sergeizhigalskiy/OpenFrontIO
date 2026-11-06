import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { renderTroops } from "@openfront/engine-lib/Format";
import {
  convoyAmbushDensityLoss,
  convoyAmbushLoss,
  convoyShellLoss,
  isConvoyHostileTo,
} from "@openfront/engine-lib/game/Convoys";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRandom,
  zRef,
  zTiles,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { EmojiExecution } from "./EmojiExecution";
import {
  EMOJI_DONATION_TOO_SMALL,
  EMOJI_LOVE,
} from "./nation/NationEmojiBehavior";

/**
 * Donated troops travel as a convoy instead of teleporting.
 *
 * The rules, kept small on purpose (the numbers live in engine-lib
 * game/Convoys.ts, which the donate panel's forecast uses too):
 * - The convoy follows the route planned when it left (ConvoyRoute.ts).
 * - Each land tile it enters that belongs to a hostile player (friendly with
 *   neither the sender nor the recipient, and not a city-state) costs it
 *   CONVOY_AMBUSH_PERMILLE of its troops plus CONVOY_AMBUSH_DENSITY_MULTIPLIER
 *   times that player's troops per tile.
 * - A shell from a hostile defense post or warship kills
 *   CONVOY_SHELL_LOSS_PERCENT of its troops; each shells it once.
 * - At 0 troops it is destroyed.
 * - It delivers on reaching the recipient's land, up to the recipient's
 *   troop cap. What does not fit goes back to the sender, up to the sender's
 *   own cap; the rest is lost, and the sender is told.
 * - If the recipient dies or stops being friendly with the sender, it
 *   disbands and the sender gets the rest back, up to the same cap.
 * - While it travels its troops still count as the sender's for troop growth
 *   (Config.troopIncreaseRate).
 */

/** Tiles a convoy moves per tick, on land and at sea. */
export const CONVOY_TILES_PER_TICK = 1;

/**
 * True when `player` attacks `convoy` on sight: anyone friendly with neither
 * its sender nor its recipient, except city-states (isConvoyHostileTo). A
 * disconnected friend still counts as friendly.
 */
export function isConvoyHostile(convoy: Unit, player: Player): boolean {
  const recipient = convoy.targetPlayer();
  return isConvoyHostileTo(
    convoy.owner(),
    recipient !== undefined && recipient.isPlayer() ? recipient : null,
    player,
  );
}

/** A shell from `attacker` hit `convoy`. */
export function shellConvoy(convoy: Unit, attacker: Player): void {
  damageConvoy(convoy, convoyShellLoss(convoy.troops()), attacker);
}

function damageConvoy(convoy: Unit, loss: number, attacker: Player): void {
  if (!convoy.isActive() || loss <= 0) return;
  convoy.setTroops(convoy.troops() - loss);
  if (convoy.troops() <= 0) {
    convoy.delete(true, attacker);
  }
}

/** Moves a convoy along its route and settles how it ends. */
export class ConvoyExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private sender: Player;
  private path: TileRef[];
  private pathIndex = 0;
  private sentTroops: number;

  /**
   * @param minTroopsForRelation delivering at least this many troops improves
   *   the recipient's relation with the sender (see DonateTroopsExecution).
   */
  constructor(
    private convoy: Unit,
    private recipient: Player,
    path: readonly TileRef[],
    private minTroopsForRelation: number,
  ) {
    this.sender = convoy.owner();
    this.path = [...path];
    this.sentTroops = convoy.troops();
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks());
  }

  tick(ticks: number): void {
    if (!this.convoy.isActive()) {
      // A shell or a nuke got it, or its owner died.
      this.active = false;
      const destroyer = this.convoy.destroyer();
      if (destroyer !== undefined) this.reportDestroyed(destroyer);
      return;
    }

    if (!this.recipient.isAlive() || !this.sender.isFriendly(this.recipient)) {
      this.disband();
      return;
    }

    // weather-seasons hook: a sea storm halves a convoy's speed at sea.
    if (this.mg.weather()?.stormMove(this.convoy, ticks).hold) return;

    for (let step = 0; step < CONVOY_TILES_PER_TICK; step++) {
      if (this.pathIndex + 1 >= this.path.length) {
        this.deliver();
        return;
      }
      this.pathIndex++;
      const tile = this.path[this.pathIndex];
      this.convoy.move(tile);
      if (
        this.mg.owner(tile) === this.recipient ||
        this.pathIndex + 1 >= this.path.length
      ) {
        this.deliver();
        return;
      }
      this.ambush(tile);
      if (!this.convoy.isActive()) {
        this.active = false;
        this.reportDestroyed(this.convoy.destroyer()!);
        return;
      }
    }
  }

  private ambush(tile: TileRef): void {
    if (!this.mg.isLand(tile)) return;
    const owner = this.mg.owner(tile);
    if (!owner.isPlayer() || !isConvoyHostile(this.convoy, owner)) return;
    const loss = convoyAmbushLoss(
      this.convoy.troops(),
      convoyAmbushDensityLoss(owner.troops(), owner.numTilesOwned()),
    );
    damageConvoy(this.convoy, loss, owner);
  }

  private deliver(): void {
    this.active = false;
    const troops = this.convoy.troops();
    const room = Math.max(
      0,
      Math.floor(
        this.mg.config().maxTroops(this.recipient) - this.recipient.troops(),
      ),
    );
    const delivered = Math.min(troops, room);
    this.convoy.setReachedTarget();
    this.convoy.delete(false);

    this.recipient.receiveTroopDonation(this.sender, delivered);
    this.refund(troops - delivered);

    // Prevent players from just buying a good relation by sending 1% troops.
    // Instead, a minimum is needed, and it's random.
    const enough = delivered >= this.minTroopsForRelation;
    if (enough) {
      this.recipient.updateRelation(this.sender, 50);
    }

    // Only AI nations auto-respond with emojis, human players should not
    if (
      this.recipient.type() === PlayerType.Nation &&
      this.recipient.canSendEmoji(this.sender)
    ) {
      this.mg.addExecution(
        new EmojiExecution(
          this.recipient,
          this.sender.id(),
          this.random.randElement(
            enough ? EMOJI_LOVE : EMOJI_DONATION_TOO_SMALL,
          ),
        ),
      );
    }
  }

  private disband(): void {
    this.active = false;
    const troops = this.convoy.troops();
    // Not destroyed: no explosion on the map.
    this.convoy.setReachedTarget();
    this.convoy.delete(false);
    if (!this.sender.isAlive()) return;
    const returned = this.refund(troops);
    this.mg.displayMessage(
      "events_display.convoy_disbanded",
      MessageType.DONATION_SENT,
      this.sender.id(),
      undefined,
      { name: this.recipient.displayName(), troops: renderTroops(returned) },
      undefined,
      this.recipient.id(),
    );
  }

  /**
   * Gives `troops` back to the sender, up to the sender's troop cap, and
   * tells the sender about any that didn't fit, which are lost. Returns how
   * many went back.
   */
  private refund(troops: number): number {
    if (troops <= 0 || !this.sender.isAlive()) return 0;
    const room = Math.max(
      0,
      Math.floor(
        this.mg.config().maxTroops(this.sender) - this.sender.troops(),
      ),
    );
    const returned = Math.min(troops, room);
    if (returned > 0) this.sender.addTroops(returned);
    const lost = troops - returned;
    if (lost > 0) {
      this.mg.displayMessage(
        "events_display.convoy_troops_lost",
        MessageType.DONATION_SENT,
        this.sender.id(),
        undefined,
        { name: this.recipient.displayName(), troops: renderTroops(lost) },
        undefined,
        this.recipient.id(),
      );
    }
    return returned;
  }

  private reportDestroyed(destroyer: Player): void {
    const troops = renderTroops(this.sentTroops);
    if (this.sender.isAlive()) {
      this.mg.displayMessage(
        "events_display.convoy_destroyed",
        MessageType.UNIT_DESTROYED,
        this.sender.id(),
        undefined,
        { name: destroyer.displayName(), troops },
        undefined,
        destroyer.id(),
      );
    }
    if (this.recipient.isAlive()) {
      this.mg.displayMessage(
        "events_display.convoy_to_you_destroyed",
        MessageType.UNIT_DESTROYED,
        this.recipient.id(),
        undefined,
        { name: destroyer.displayName(), troops },
        undefined,
        destroyer.id(),
      );
    }
    if (destroyer !== this.recipient && destroyer.isAlive()) {
      this.mg.displayMessage(
        "events_display.convoy_destroyed_by_you",
        MessageType.CAPTURED_ENEMY_UNIT,
        destroyer.id(),
        undefined,
        { name: this.sender.displayName(), troops },
        undefined,
        this.sender.id(),
      );
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return ConvoyExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      random: this.random === undefined ? null : w.random(this.random),
      convoy: w.unit(this.convoy),
      sender: w.player(this.sender),
      recipient: w.player(this.recipient),
      path: w.tiles(this.path),
      pathIndex: this.pathIndex,
      sentTroops: this.sentTroops,
      minTroopsForRelation: this.minTroopsForRelation,
    });
  }

  restoreSnapshot(s: ConvoyState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    if (s.random !== null) this.random = r.random(s.random);
    this.convoy = r.unit(s.convoy);
    this.sender = r.player(s.sender);
    this.recipient = r.player(s.recipient);
    this.path = Array.from(s.path);
    this.pathIndex = s.pathIndex;
    this.sentTroops = s.sentTroops;
    this.minTroopsForRelation = s.minTroopsForRelation;
  }
}

const ConvoyStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  random: zRandom().nullable(),
  convoy: zRef(),
  sender: zPlayerRef(),
  recipient: zPlayerRef(),
  path: zTiles(),
  pathIndex: zInt(),
  sentTroops: zNum(),
  minTroopsForRelation: zNum(),
});
type ConvoyState = z.infer<typeof ConvoyStateSchema>;

export const ConvoyExecutionSnapshot = execSnapshotType({
  name: "Convoy",
  version: 1,
  schema: ConvoyStateSchema,
  cls: () => ConvoyExecution,
});
