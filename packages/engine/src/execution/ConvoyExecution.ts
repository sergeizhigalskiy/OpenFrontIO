import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { renderTroops } from "@openfront/engine-lib/Format";
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
import { PathFinding } from "../pathfinding/PathFinder";
import { SpatialQuery } from "../pathfinding/spatial/SpatialQuery";
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
 * The rules, kept small on purpose:
 * - The convoy leaves from the sender's border tile nearest the recipient and
 *   follows a fixed route: overland when one exists, else by sea from a
 *   sender shore to a recipient shore.
 * - Each land tile it enters that belongs to a hostile third player (not the
 *   sender, not the recipient, not friendly with the sender) costs it
 *   CONVOY_AMBUSH_DENSITY_MULTIPLIER times that player's troops per tile.
 * - A shell from a hostile defense post or warship kills
 *   CONVOY_SHELL_LOSS_PERCENT of its troops.
 * - At 0 troops it is destroyed.
 * - It delivers on reaching the recipient's land, up to the recipient's
 *   troop cap; what does not fit goes back to the sender.
 * - If the recipient dies or stops being friendly with the sender, it
 *   disbands and the sender gets the rest back.
 */

/** Tiles a convoy moves per tick, on land and at sea. */
export const CONVOY_TILES_PER_TICK = 1;

/**
 * Troops a convoy loses per hostile land tile it enters, as a multiple of
 * that tile owner's troop density (troops / tiles owned).
 */
export const CONVOY_AMBUSH_DENSITY_MULTIPLIER = 20;

/** Share of its current troops a convoy loses to one shell hit, in percent. */
export const CONVOY_SHELL_LOSS_PERCENT = 50;

/**
 * True when `player` attacks `convoy` on sight: anyone but the sender, the
 * recipient, and the sender's allies and teammates. A disconnected ally
 * still counts as friendly.
 */
export function isConvoyHostile(convoy: Unit, player: Player): boolean {
  const sender = convoy.owner();
  if (player === sender || player === convoy.targetPlayer()) return false;
  return !sender.isFriendly(player, true);
}

/** A shell from `attacker` hit `convoy`. */
export function shellConvoy(convoy: Unit, attacker: Player): void {
  const loss = Math.ceil((convoy.troops() * CONVOY_SHELL_LOSS_PERCENT) / 100);
  damageConvoy(convoy, loss, attacker);
}

function damageConvoy(convoy: Unit, loss: number, attacker: Player): void {
  if (!convoy.isActive() || loss <= 0) return;
  convoy.setTroops(convoy.troops() - loss);
  if (convoy.troops() <= 0) {
    convoy.delete(true, attacker);
  }
}

/**
 * The route a troop convoy from `sender` to `recipient` takes, first tile to
 * last, or null when neither a land nor a sea route reaches the recipient
 * (say, an overseas ally with no shore on a sea the sender touches).
 */
export function planConvoyRoute(
  game: Game,
  sender: Player,
  recipient: Player,
): TileRef[] | null {
  const anchor = anchorTile(game, recipient);
  if (anchor === null) return null;
  const isLandTile = (t: TileRef) => game.isLand(t) && !game.isImpassable(t);
  const start = nearestTile(game, sender.borderTiles(), anchor, isLandTile);
  if (start === null) return null;
  const end = nearestTile(game, recipient.borderTiles(), start, isLandTile);
  if (end === null) return null;

  // The rail pathfinder walks land, preferring straight lines, and bridges
  // water only where a rail could (rivers and straits up to about six tiles
  // wide). It searches the half-resolution minimap, so a route can clip a
  // coastal water tile; ambushes only happen on land.
  const land = PathFinding.Rail(game).findPath(start, end);
  if (land !== null && land.length > 0) {
    return withEndpoints(land, start, end);
  }
  return seaRoute(game, sender, recipient, start);
}

/** By sea, like a transport ship: from a sender shore to a recipient shore. */
function seaRoute(
  game: Game,
  sender: Player,
  recipient: Player,
  from: TileRef,
): TileRef[] | null {
  const seas = new Set<number>();
  sender.borderTiles().forEach((t) => {
    if (!game.isShore(t) || !game.isLand(t)) return;
    const component = game.getWaterComponent(t);
    if (component !== null) seas.add(component);
  });
  if (seas.size === 0) return null;

  const landing = nearestTile(game, recipient.borderTiles(), from, (t) => {
    if (!game.isShore(t) || !game.isLand(t)) return false;
    const component = game.getWaterComponent(t);
    return component !== null && seas.has(component);
  });
  if (landing === null) return null;

  const launch = new SpatialQuery(game).closestShoreByWater(sender, landing);
  if (launch === null) return null;

  const path = PathFinding.Water(game).findPath(launch, landing);
  if (path === null || path.length === 0) return null;
  return withEndpoints(path, launch, landing);
}

function withEndpoints(
  path: TileRef[],
  start: TileRef,
  end: TileRef,
): TileRef[] {
  const route = path[0] === start ? [...path] : [start, ...path];
  if (route[route.length - 1] !== end) route.push(end);
  return route;
}

/** A tile in the middle of `player`'s land, to aim convoys at. */
function anchorTile(game: Game, player: Player): TileRef | null {
  // Unset (undefined) until PlayerExecution first measures the player.
  const box = player.largestClusterBoundingBox;
  if (box) {
    const x = Math.floor((box.min.x + box.max.x) / 2);
    const y = Math.floor((box.min.y + box.max.y) / 2);
    if (game.isValidCoord(x, y)) return game.ref(x, y);
  }
  const spawn = player.spawnTile();
  if (spawn !== undefined) return spawn;
  for (const tile of player.borderTiles()) return tile;
  return null;
}

/** The tile of `tiles` nearest `target` that passes `accept` (first wins ties). */
function nearestTile(
  game: Game,
  tiles: Iterable<TileRef>,
  target: TileRef,
  accept: (t: TileRef) => boolean,
): TileRef | null {
  let best: TileRef | null = null;
  let bestDist = Infinity;
  for (const tile of tiles) {
    if (!accept(tile)) continue;
    const dist = game.manhattanDist(tile, target);
    if (dist < bestDist) {
      best = tile;
      bestDist = dist;
      if (dist === 0) break;
    }
  }
  return best;
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
    const tiles = owner.numTilesOwned();
    if (tiles <= 0) return;
    const loss = Math.floor(
      (owner.troops() * CONVOY_AMBUSH_DENSITY_MULTIPLIER) / tiles,
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
    if (troops > delivered && this.sender.isAlive()) {
      this.sender.addTroops(troops - delivered);
    }

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
    this.sender.addTroops(troops);
    this.mg.displayMessage(
      "events_display.convoy_disbanded",
      MessageType.DONATION_SENT,
      this.sender.id(),
      undefined,
      { name: this.recipient.displayName(), troops: renderTroops(troops) },
      undefined,
      this.recipient.id(),
    );
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
