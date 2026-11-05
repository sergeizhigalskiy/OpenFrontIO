import {
  Difficulty,
  GameType,
  Gold,
  PlayerInfo,
  PlayerType,
  TerraNullius,
  Tick,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PlayerLike } from "@openfront/engine-api/game/ReadViews";
import { TeamCountConfig } from "@openfront/engine-api/Schemas";
import { NukeType } from "@openfront/engine-api/StatsSchemas";
import { Config } from "@openfront/engine-lib/configuration/Config";
import { exp, pow2 } from "@openfront/engine-lib/DetMath";
import {
  bossGoldIncomePercent,
  isBossRaidBoss,
} from "@openfront/engine-lib/game/BossRaid";
import { CANAL_COST_PER_TILE } from "@openfront/engine-lib/game/Canal";
import {
  AIRDROP_COST,
  BALLISTIC_MISSILE_COST,
  clusterMissileCost,
  airbaseCost,
  AIRSTRIKE_COST,
  CRUISE_MISSILE_COST,
  DRONE_COST,
  flakGunCost,
} from "@openfront/engine-lib/game/ConventionalWar";
import {
  coastalBatteryCost,
  MINEFIELD_DEFAULT_DENSITY,
  minefieldCost,
} from "@openfront/engine-lib/game/NavalDefense";
import { siegeCampCost } from "@openfront/engine-lib/game/Siege";
import {
  assertNever,
  sigmoid,
  toInt,
  within,
} from "@openfront/engine-lib/Util";
import type { EngineUnitInfo, Game, Player, Unit } from "../game/Game";

// The attack math moved to engine-lib (game/AttackLogic.ts) so the client's
// attack forecast runs it too; re-exported for the engine's callers.
export type {
  AttackLogicInput,
  AttackLogicResult,
} from "@openfront/engine-lib/game/AttackLogic";
export { CHEAPEST_TROOP_RATIO } from "@openfront/engine-lib/game/AttackLogic";

/**
 * The engine's rules: everything in Config plus the tunables only the
 * simulation reads (attack resolution, costs, warships, nukes, trade).
 */
export class EngineConfig extends Config {
  private engineUnitInfoCache = new Map<UnitType, EngineUnitInfo>();

  teamLandShareWinThresholdTenths(): number {
    return 7;
  }

  setDifficulty(difficulty: Difficulty): void {
    this._gameConfig = { ...this._gameConfig, difficulty };
  }

  setGameType(gameType: GameType): void {
    this._gameConfig = { ...this._gameConfig, gameType };
  }

  playerTeams(): TeamCountConfig {
    return this._gameConfig.playerTeams ?? 0;
  }

  spawnNations(): boolean {
    return this._gameConfig.nations !== "disabled";
  }

  bots(): number {
    return this._gameConfig.bots;
  }
  disableNavMesh(): boolean {
    return this._gameConfig.disableNavMesh ?? false;
  }
  waterNukes(): boolean {
    return this._gameConfig.waterNukes ?? false;
  }
  infiniteGold(): boolean {
    return this._gameConfig.infiniteGold;
  }
  donateGold(): boolean {
    return this._gameConfig.donateGold;
  }
  goldMultiplier(): number {
    return this._gameConfig.goldMultiplier ?? 1;
  }
  startingGold(playerInfo: PlayerInfo): Gold {
    if (playerInfo.playerType === PlayerType.Bot) {
      return 0n;
    }
    return this.startingGoldFor(playerInfo);
  }

  /**
   * Global spawn throttle for the train economy, counted in Train *units*
   * (~7 per train: engine, tail, 5 cars). A capacity sigmoid damps
   * spawning past the ~560-unit midpoint. The damping flattens onto a
   * ~0.25 plateau past ~810 units (~115 trains), so a big
   * enough rail economy still scales at a quarter of the un-damped rate,
   * until a global hard cap far beyond any normal game collapses the
   * plateau past ~900 units (~130 trains).
   *
   * The midpoint was 300 units in v34.0. Public-game telemetry put a real
   * lobby at ~4.2 train units per player, so a 50-player game sat at ~210
   * units and a 70-player game at ~300 — i.e. normal lobbies were landing
   * on and past the knee, costing factories 35-56% of their v33 income.
   * The 61-nation benchmark this curve was tuned against peaks at 91 units,
   * roughly a quarter of a full public lobby, so it never saw that region.
   * v34.5 moved it to 500 (measured +32% train gold in matched lobbies);
   * 560 softens the remaining early/mid-game gap vs v33 (~-8% at 50
   * players, ~-18% at 80) without re-opening v33's big-lobby train
   * dominance, and leaves the plateau and hard cap untouched.
   *
   * Small economies are sped up by smallEconomySpawnBoost (per player),
   * which replaced a fleet-size boost that kept small lobbies boosted all
   * game.
   */
  trainSaturation(numTrainUnits: number): number {
    const damping = 1 - sigmoid(numTrainUnits, Math.LN2 / 100, 560);
    const plateau = 0.25 * (1 - sigmoid(numTrainUnits, Math.LN2 / 150, 900));
    return Math.max(damping, plateau);
  }

  trainSpawnRate(numPlayerFactories: number, numTrainUnits: number): number {
    // hyperbolic decay, midpoint at 10 factories
    // expected number of trains = numPlayerFactories  / trainSpawnRate(numPlayerFactories)
    const rate = (numPlayerFactories + 10) * 15;
    const boost = this.smallEconomySpawnBoost(numPlayerFactories);
    return Math.max(
      1,
      Math.floor(rate / (this.trainSaturation(numTrainUnits) * boost)),
    );
  }

  /**
   * Per-unit spawn multiplier for a player's first few ports or factories
   * (counted in levels), so a new or knocked-back economy gets going
   * faster: up to half an extra unit's worth of spawns, 1.5x at 1 level,
   * fading out by 6 levels. Additive, so total spawns still rise with every level
   * built. Keyed on the player rather than game time or the world fleet, so
   * it works the same in every lobby size and doubles as a comeback boost.
   */
  smallEconomySpawnBoost(levels: number): number {
    if (levels <= 0) return 1;
    return 1 + (0.5 * within((6 - levels) / 5, 0, 1)) / levels;
  }

  trainGold(
    rel: "self" | "team" | "ally" | "other",
    citiesVisited: number,
    player: PlayerLike,
  ): Gold {
    // No penalty for the first 10 cities.
    citiesVisited = Math.max(0, citiesVisited - 9);
    let baseGold: number;
    switch (rel) {
      case "ally":
        baseGold = 35_000;
        break;
      case "team":
      case "other":
        baseGold = 25_000;
        break;
      case "self":
        baseGold = 10_000;
        break;
    }
    const distPenalty = citiesVisited * 5_000;
    const gold = Math.max(5000, baseGold - distPenalty);
    return toInt(gold * this.goldMultiplierFor(player));
  }

  trainStationMinRange(): number {
    return 15;
  }
  railroadMaxSize(): number {
    return this.trainStationMaxRange() * 1.4142;
  }

  tradeShipGold(dist: number, player: PlayerLike): Gold {
    // Sigmoid: concave start, sharp S-curve middle, linear end - heavily punishes trades under range debuff.
    const debuff = this.tradeShipShortRangeDebuff();
    const baseGold = 75_000 / (1 + exp(-0.03 * (dist - debuff))) + 50 * dist;
    return BigInt(Math.floor(baseGold * this.goldMultiplierFor(player)));
  }

  /**
   * Global spawn throttle for the trade-ship economy. A capacity sigmoid
   * damps spawning past the ~330-ship midpoint. The damping flattens onto
   * a 0.25 plateau past ~415 ships (~half cadence per port after the pity
   * timer), so heavy port
   * investment keeps scaling income linearly, until a global hard cap far
   * beyond any normal game collapses the plateau past ~800 at sea.
   *
   * The midpoint was 230 in v34.0. v33's was 400, so fleets of 150-350 —
   * reached within the opening minutes of a 40+ player lobby — ran 30-64%
   * below v33's spawn odds, which is where the "no early gold for nukes"
   * deficit lived; the opening (<130 ships) was already above v33 via a
   * fleet-size boost. 330 restores that window to near-v33 while the
   * plateau keeps everything past ~450 ships (the late game) numerically
   * unchanged.
   *
   * Small economies are sped up by smallEconomySpawnBoost (per player),
   * which replaced that fleet-size boost: keyed on fleet size, it kept
   * small lobbies boosted all game, and the pity timer cancelled most of
   * it.
   */
  tradeShipSaturation(numTradeShips: number): number {
    const damping = 1 - sigmoid(numTradeShips, Math.LN2 / 50, 330);
    const plateau = 0.25 * (1 - sigmoid(numTradeShips, Math.LN2 / 100, 800));
    return Math.max(damping, plateau);
  }

  // Probability of trade ship spawn = 1 / tradeShipSpawnRate
  tradeShipSpawnRate(
    tradeShipSpawnRejections: number,
    numTradeShips: number,
    playerPortLevels: number,
  ): number {
    // Pity timer: increases spawn chance after consecutive rejections
    const rejectionModifier = 1 / (tradeShipSpawnRejections + 1);
    // The pity timer square-roots odds changes, so squaring the boost makes
    // it the realized ship multiplier (1 port level: one every ~8s, not ~12s).
    const boost = this.smallEconomySpawnBoost(playerPortLevels);
    const base = 100 / (boost * boost);

    return Math.max(
      1,
      Math.floor(
        (base * rejectionModifier) / this.tradeShipSaturation(numTradeShips),
      ),
    );
  }

  private hasInfiniteGoldFor(player: PlayerLike): boolean {
    if (this.infiniteGold()) return true;
    const hc = this._gameConfig.hostCheats;
    return (hc?.infiniteGold ?? false) && player.isLobbyCreator();
  }

  override unitInfo(type: UnitType): EngineUnitInfo {
    const cached = this.engineUnitInfoCache.get(type);
    if (cached !== undefined) {
      return cached;
    }
    const info = { ...super.unitInfo(type), cost: this.unitCost(type) };
    this.engineUnitInfoCache.set(type, info);
    return info;
  }

  private unitCost(type: UnitType): EngineUnitInfo["cost"] {
    switch (type) {
      case UnitType.Warship:
        return this.costWrapper(
          (numUnits: number) => Math.min(1_000_000, (numUnits + 1) * 250_000),
          UnitType.Warship,
        );
      case UnitType.Port:
        return this.costWrapper(
          (numUnits: number) => Math.min(1_000_000, pow2(numUnits) * 125_000),
          UnitType.Port,
          UnitType.Factory,
        );
      case UnitType.AtomBomb:
        return this.costWrapper(() => 750_000, UnitType.AtomBomb);
      case UnitType.HydrogenBomb:
        return this.costWrapper(() => 5_000_000, UnitType.HydrogenBomb);
      case UnitType.MIRV:
        return (game: Game, player: Player) => {
          if (
            player.type() === PlayerType.Human &&
            this.hasInfiniteGoldFor(player)
          ) {
            return 0n;
          }
          return 25_000_000n + BigInt(game.mirvsLaunched()) * 15_000_000n;
        };
      case UnitType.MissileSilo:
        return this.costWrapper(() => 1_000_000, UnitType.MissileSilo);
      case UnitType.DefensePost:
        return this.costWrapper(
          (numUnits: number) => Math.min(250_000, (numUnits + 1) * 50_000),
          UnitType.DefensePost,
        );
      case UnitType.SAMLauncher:
        return this.costWrapper(
          (numUnits: number) => Math.min(3_000_000, (numUnits + 1) * 1_500_000),
          UnitType.SAMLauncher,
        );
      case UnitType.City:
        return this.costWrapper(
          (numUnits: number) => Math.min(1_000_000, pow2(numUnits) * 125_000),
          UnitType.City,
        );
      case UnitType.Factory:
        return this.costWrapper(
          (numUnits: number) => Math.min(1_000_000, pow2(numUnits) * 125_000),
          UnitType.Factory,
          UnitType.Port,
        );
      case UnitType.Minefield:
        // The price at the default density, for menus and nations. A real
        // placement is charged for its own density (minefieldCost below).
        return this.costWrapper(
          (numUnits: number) =>
            minefieldCost(MINEFIELD_DEFAULT_DENSITY, numUnits),
          UnitType.Minefield,
        );
      case UnitType.CoastalBattery:
        return this.costWrapper(
          (numUnits: number) => coastalBatteryCost(numUnits),
          UnitType.CoastalBattery,
        );
      case UnitType.Airbase:
        return this.costWrapper(
          (numUnits: number) => airbaseCost(numUnits),
          UnitType.Airbase,
        );
      case UnitType.FlakGun:
        return this.costWrapper(
          (numUnits: number) => flakGunCost(numUnits),
          UnitType.FlakGun,
        );
      case UnitType.SiegeCamp:
        return this.costWrapper(
          (numUnits: number) => siegeCampCost(numUnits),
          UnitType.SiegeCamp,
        );
      case UnitType.Airstrike:
        return this.costWrapper(() => AIRSTRIKE_COST, UnitType.Airstrike);
      case UnitType.Airdrop:
        return this.costWrapper(() => AIRDROP_COST, UnitType.Airdrop);
      case UnitType.CruiseMissile:
        return this.costWrapper(
          () => CRUISE_MISSILE_COST,
          UnitType.CruiseMissile,
        );
      case UnitType.Drone:
        return this.costWrapper(() => DRONE_COST, UnitType.Drone);
      case UnitType.BallisticMissile:
        return this.costWrapper(
          () => BALLISTIC_MISSILE_COST,
          UnitType.BallisticMissile,
        );
      case UnitType.ClusterMissile:
        // Escalates with every cluster missile launched this game (by anyone).
        return (game: Game, player: Player) => {
          if (
            player.type() === PlayerType.Human &&
            this.hasInfiniteGoldFor(player)
          ) {
            return 0n;
          }
          return BigInt(clusterMissileCost(game.clusterMissilesLaunched()));
        };
      case UnitType.ClusterWarhead:
        return () => 0n;
      case UnitType.TransportShip:
      case UnitType.Shell:
      case UnitType.SAMMissile:
      case UnitType.MIRVWarhead:
      case UnitType.TradeShip:
      case UnitType.Train:
      case UnitType.Convoy:
        return () => 0n;
      case UnitType.Canal:
        // Per step of length: a canal is charged this times its length
        // (see engine/game/Canal.ts canalPrice).
        return this.costWrapper(() => CANAL_COST_PER_TILE, UnitType.Canal);
      default:
        assertNever(type);
    }
  }

  private hasInfiniteTroopsForInfo(playerInfo: PlayerInfo): boolean {
    if (this.infiniteTroops()) return true;
    return (
      (this._gameConfig.hostCheats?.infiniteTroops ?? false) &&
      playerInfo.isLobbyCreator
    );
  }

  private goldMultiplierFor(player: PlayerLike): number {
    const base = this.goldMultiplier();
    const hc = this._gameConfig.hostCheats;
    const multiplier =
      hc?.goldMultiplier && player.isLobbyCreator() ? hc.goldMultiplier : base;
    // Boss Raid: only the Boss's income scales, so no one else's changes.
    if (isBossRaidBoss(this._gameConfig, player)) {
      return (multiplier * bossGoldIncomePercent(this.bossRaidRaiders())) / 100;
    }
    return multiplier;
  }

  public conquerGoldAmount(captured: PlayerLike): Gold {
    if (
      captured.type() === PlayerType.Bot ||
      captured.type() === PlayerType.Nation
    ) {
      return captured.gold();
    } else {
      return captured.gold() / 2n;
    }
  }

  private startingGoldFor(playerInfo: PlayerInfo): Gold {
    const base = BigInt(this._gameConfig.startingGold ?? 0);
    const hc = this._gameConfig.hostCheats;
    if (hc?.startingGold && playerInfo.isLobbyCreator) {
      return base + BigInt(hc.startingGold);
    }
    return base;
  }

  /**
   * What `player` pays for a minefield of `density` percent: scales with the
   * density and with the minefields they already own (see NavalDefense.ts).
   */
  minefieldCost(game: Game, player: Player, density: number): Gold {
    return this.costWrapper(
      (numUnits: number) => minefieldCost(density, numUnits),
      UnitType.Minefield,
    )(game, player);
  }

  private costWrapper(
    costFn: (units: number) => number,
    ...types: UnitType[]
  ): (g: Game, p: Player, extraUnits?: number) => bigint {
    return (game: Game, player: Player, extraUnits: number = 0) => {
      if (
        player.type() === PlayerType.Human &&
        this.hasInfiniteGoldFor(player)
      ) {
        return 0n;
      }
      const numUnits = types.reduce(
        (acc, type) =>
          acc +
          Math.min(player.unitsOwned(type), player.unitsConstructed(type)),
        0,
      );
      return BigInt(costFn(numUnits + extraUnits));
    };
  }

  defaultDonationAmount(sender: PlayerLike): number {
    return Math.floor(sender.troops() / 3);
  }
  donateCooldown(): Tick {
    return 10 * 10;
  }
  embargoAllCooldown(): Tick {
    return 10 * 10;
  }
  emojiMessageDuration(): Tick {
    return 5 * 10;
  }
  /** The window emojiMessageLimit counts over. */
  emojiMessageWindow(): Tick {
    return 5 * 10;
  }
  /**
   * How many emojis a human can send one recipient (or everyone) per
   * emojiMessageWindow, so a few can go out in a quick batch.
   */
  emojiMessageLimit(): number {
    return 5;
  }
  quickChatCooldown(): Tick {
    return 3 * 10;
  }
  targetDuration(): Tick {
    return 10 * 10;
  }
  targetCooldown(): Tick {
    return 15 * 10;
  }
  allianceRequestCooldown(): Tick {
    return 30 * 10;
  }
  temporaryEmbargoDuration(): Tick {
    return 300 * 10; // 5 minutes.
  }
  minDistanceBetweenPlayers(): number {
    return 30;
  }
  boatMaxNumber(): number {
    if (this.isUnitDisabled(UnitType.TransportShip)) {
      return 0;
    }
    return 3;
  }
  numBots(): number {
    return this.bots();
  }

  boatAttackAmount(
    attacker: PlayerLike,
    defender: PlayerLike | TerraNullius,
  ): number {
    return Math.floor(attacker.troops() / 5);
  }

  warshipShellLifetime(): number {
    return 20; // in ticks (one tick is 100ms)
  }

  tradeShipShortRangeDebuff(): number {
    return 300;
  }

  proximityBonusPortsNb(totalPorts: number) {
    return within(totalPorts / 3, 4, totalPorts);
  }

  attackAmount(attacker: PlayerLike, defender: PlayerLike | TerraNullius) {
    if (attacker.type() === PlayerType.Bot) {
      return attacker.troops() / 20;
    } else {
      return attacker.troops() / 5;
    }
  }

  startManpower(playerInfo: PlayerInfo): number {
    if (playerInfo.playerType === PlayerType.Bot) {
      return 10_000;
    }
    if (playerInfo.playerType === PlayerType.Nation) {
      switch (this._gameConfig.difficulty) {
        case Difficulty.Easy:
          return 12_500;
        case Difficulty.Medium:
          return 18_750;
        case Difficulty.Hard:
          return 25_000; // Like humans
        case Difficulty.Impossible:
          return 31_250;
        default:
          assertNever(this._gameConfig.difficulty);
      }
    }
    // The onboarding tutorial's player starts about half full, where troops
    // grow fastest, so the first attacks take more land.
    if (this._gameConfig.tutorial) return 60_000;
    return this.hasInfiniteTroopsForInfo(playerInfo) ? 1_000_000 : 25_000;
  }

  /**
   * Passive gold per tick. `bonusPercent` is a whole-percent raise on top
   * (conventional war: enemy capitals held, see Capital.ts), applied in
   * integers so every client agrees.
   */
  goldAdditionRate(player: PlayerLike, bonusPercent = 0): Gold {
    const multiplier = this.goldMultiplierFor(player);
    let baseRate: bigint;
    if (player.type() === PlayerType.Bot) {
      baseRate = 50n;
    } else {
      baseRate = 100n;
    }
    const rate = BigInt(Math.floor(Number(baseRate) * multiplier));
    if (bonusPercent <= 0) return rate;
    return (rate * BigInt(100 + Math.floor(bonusPercent))) / 100n;
  }

  /** What a resource site paying `goldPerTick` gives `player` per tick. */
  resourceSiteGold(player: PlayerLike, goldPerTick: Gold): Gold {
    return BigInt(
      Math.floor(Number(goldPerTick) * this.goldMultiplierFor(player)),
    );
  }

  nukeSpeed(unitType: UnitType): number {
    switch (unitType) {
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
        return 10;
      case UnitType.MIRV:
        return 15;
      case UnitType.MIRVWarhead:
        return 22;
    }
    throw new Error(`Unknown nuke type: ${unitType}`);
  }

  mirvNormalizeTargetTicks(): number {
    return 14;
  }

  defaultNukeTargetableRange(): number {
    return 150;
  }

  defaultSamRange(): number {
    return 70;
  }

  samUpgradeDuration(): number {
    return Math.floor(this.SAMCooldown() / 2);
  }

  dynamicSamRange(sam: Unit, currentTick: number): number {
    const state = sam.samLauncherState();
    if (state === undefined || state.upgradeStartTick === undefined) {
      return this.samRange(sam.level());
    }
    const duration = state.duration ?? this.samUpgradeDuration();
    const elapsed = currentTick - state.upgradeStartTick;
    if (elapsed >= duration) {
      return this.samRange(state.targetLevel);
    }
    const targetRange = this.samRange(state.targetLevel);
    const diff = targetRange - state.startRange;
    return state.startRange + (diff * elapsed) / duration;
  }

  defaultSamMissileSpeed(): number {
    return 12;
  }

  // Humans can be soldiers, soldiers attacking, soldiers in boat etc.
  nukeDeathFactor(
    nukeType: NukeType,
    humans: number,
    tilesOwned: number,
    maxTroops: number,
  ): number {
    if (nukeType !== UnitType.MIRVWarhead) {
      return (5 * humans) / Math.max(1, tilesOwned);
    }
    const targetTroops = 0.03 * maxTroops;
    const excessTroops = Math.max(0, humans - targetTroops);
    const scalingFactor = 500;

    const steepness = 2;
    const normalizedExcess = excessTroops / maxTroops;
    return scalingFactor * (1 - exp(-steepness * normalizedExcess));
  }

  shellLifetime(): number {
    return 50;
  }

  warshipPatrolRange(): number {
    return 100;
  }

  warshipTargettingRange(): number {
    return 130;
  }

  warshipShellAttackRate(): number {
    return 20;
  }

  warshipDockingRange(): number {
    return 5;
  }

  warshipPortHealingBonusPerLevel(): number {
    return 5;
  }

  /** Health at or below which a warship retreats to repair, as a percent of its
   *  (veterancy-adjusted) max health, so the threshold scales with max health. */
  warshipRetreatHealthPercent(): number {
    return 75;
  }

  warshipPassiveHealing(): number {
    return 1;
  }

  warshipPassiveHealingRange(): number {
    return 150;
  }

  warshipPortSwitchThreshold(): number {
    return 0.75;
  }

  // --- Warship veterancy ---

  /** Maximum veterancy level a warship can reach. */
  warshipMaxVeterancy(): number {
    return 3;
  }

  /** Shell-damage boost per veterancy level, as an integer percent of the
   *  rolled damage. Integer-only to keep the engine deterministic. */
  warshipVeterancyShellDamageBonus(): number {
    return 20;
  }

  /** Transport ships a warship must destroy to gain one veterancy level. */
  warshipVeterancyTransportKills(): number {
    return 10;
  }

  /** Trade ships a warship must capture to gain one veterancy level. */
  warshipVeterancyTradeCaptures(): number {
    return 25;
  }

  defensePostShellAttackRate(): number {
    return 100;
  }

  safeFromPiratesCooldownMax(): number {
    return 20;
  }

  defensePostTargettingRange(): number {
    return 75;
  }
}
