import {
  Difficulty,
  MessageType,
  PlayerID,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { renderTroops } from "@openfront/engine-lib/Format";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zNum,
  zPlayerRef,
  zRandom,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { assertNever } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { ConvoyExecution, planConvoyRoute } from "./ConvoyExecution";

/**
 * Sends troops to an ally. The troops leave the sender at once but travel as
 * a convoy unit (ConvoyExecution), which can be ambushed on the way; the
 * recipient only gets what arrives.
 */
export class DonateTroopsExecution implements Execution {
  private recipient: Player;

  private random: PseudoRandom;
  private mg: Game;

  private active = true;

  constructor(
    private sender: Player,
    private recipientID: PlayerID,
    private troops: number | null,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks());

    if (!mg.hasPlayer(this.recipientID)) {
      console.warn(
        `DonateTroopExecution recipient ${this.recipientID} not found`,
      );
      this.active = false;
      return;
    }

    this.recipient = mg.player(this.recipientID);
    this.troops ??= mg.config().defaultDonationAmount(this.sender);
    const maxDonation =
      mg.config().maxTroops(this.recipient) - this.recipient.troops();
    this.troops = Math.min(this.troops, maxDonation);

    if (this.troops <= 0) {
      this.active = false;
    }
  }

  tick(ticks: number): void {
    if (this.troops === null) throw new Error("not initialized");
    this.active = false;

    if (!this.sender.canDonateTroops(this.recipient)) {
      console.warn(
        `cannot send troops from ${this.sender} to ${this.recipient}`,
      );
      return;
    }
    const troops = Math.floor(Math.min(this.troops, this.sender.troops()));
    if (troops <= 0) return;

    const route = planConvoyRoute(this.mg, this.sender, this.recipient);
    if (route === null) {
      this.mg.displayMessage(
        "events_display.convoy_no_route",
        MessageType.ATTACK_FAILED,
        this.sender.id(),
        undefined,
        { name: this.recipient.displayName() },
        undefined,
        this.recipient.id(),
      );
      return;
    }

    const minTroops = this.getMinTroopsForRelationUpdate();
    // buildUnit takes the convoy's troops from the sender.
    const convoy = this.sender.buildUnit(UnitType.Convoy, route[0], {
      troops,
      targetTile: route[route.length - 1],
      targetPlayer: this.recipient,
    });
    this.sender.recordTroopDonation(this.recipient);
    this.mg.addExecution(
      new ConvoyExecution(convoy, this.recipient, route, minTroops),
    );

    const amount = renderTroops(troops);
    this.mg.displayMessage(
      "events_display.convoy_dispatched",
      MessageType.DONATION_SENT,
      this.sender.id(),
      undefined,
      { name: this.recipient.displayName(), troops: amount },
      convoy.id(),
      this.recipient.id(),
    );
    this.mg.displayMessage(
      "events_display.convoy_incoming",
      MessageType.DONATION_RECEIVED,
      this.recipient.id(),
      undefined,
      { name: this.sender.displayName(), troops: amount },
      convoy.id(),
      this.sender.id(),
    );
  }

  private getMinTroopsForRelationUpdate(): number {
    const { difficulty } = this.mg.config().gameConfig();
    const recipientMaxTroops = this.mg.config().maxTroops(this.recipient);

    switch (difficulty) {
      // ~7.7k - ~9.1k troops (for 100k troops)
      case Difficulty.Easy:
        return this.random.nextInt(
          recipientMaxTroops / 13,
          recipientMaxTroops / 11,
        );
      // ~9.1k - ~11.1k troops (for 100k troops)
      case Difficulty.Medium:
        return this.random.nextInt(
          recipientMaxTroops / 11,
          recipientMaxTroops / 9,
        );
      // ~11.1k - ~14.3k troops (for 100k troops)
      case Difficulty.Hard:
        return this.random.nextInt(
          recipientMaxTroops / 9,
          recipientMaxTroops / 7,
        );
      // ~14.3k - ~20k troops (for 100k troops)
      case Difficulty.Impossible:
        return this.random.nextInt(
          recipientMaxTroops / 7,
          recipientMaxTroops / 5,
        );
      default:
        assertNever(difficulty);
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return DonateTroopsExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      recipient: this.recipient === undefined ? null : w.player(this.recipient),
      random: this.random === undefined ? null : w.random(this.random),
      sender: w.player(this.sender),
      recipientID: this.recipientID,
      troops: this.troops,
    });
  }

  restoreSnapshot(s: DonateTroopsState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    if (s.recipient !== null) this.recipient = r.player(s.recipient);
    if (s.random !== null) this.random = r.random(s.random);
    this.sender = r.player(s.sender);
    this.recipientID = s.recipientID;
    this.troops = s.troops;
  }
}

const DonateTroopsStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  recipient: zPlayerRef().nullable(),
  random: zRandom().nullable(),
  sender: zPlayerRef(),
  recipientID: z.string(),
  troops: zNum().nullable(),
});
type DonateTroopsState = z.infer<typeof DonateTroopsStateSchema>;

export const DonateTroopsExecutionSnapshot = execSnapshotType({
  name: "DonateTroops",
  version: 1,
  schema: DonateTroopsStateSchema,
  cls: () => DonateTroopsExecution,
});
