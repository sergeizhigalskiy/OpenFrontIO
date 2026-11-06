// Every entry is `<ClassName>Snapshot`, exported next to its class.
import { AllianceExtensionExecutionSnapshot } from "../execution/alliance/AllianceExtensionExecution";
import { AllianceRejectExecutionSnapshot } from "../execution/alliance/AllianceRejectExecution";
import { AllianceRequestExecutionSnapshot } from "../execution/alliance/AllianceRequestExecution";
import { BreakAllianceExecutionSnapshot } from "../execution/alliance/BreakAllianceExecution";
import { AttackExecutionSnapshot } from "../execution/AttackExecution";
import { BoatRetreatExecutionSnapshot } from "../execution/BoatRetreatExecution";
import { CityExecutionSnapshot } from "../execution/CityExecution";
import { CityStateExecutionSnapshot } from "../execution/CityStateExecution";
import { ConstructionExecutionSnapshot } from "../execution/ConstructionExecution";
import { ConvoyExecutionSnapshot } from "../execution/ConvoyExecution";
import { DefensePostExecutionSnapshot } from "../execution/DefensePostExecution";
import { DeleteUnitExecutionSnapshot } from "../execution/DeleteUnitExecution";
import { DonateGoldExecutionSnapshot } from "../execution/DonateGoldExecution";
import { DonateTroopsExecutionSnapshot } from "../execution/DonateTroopExecution";
import { DoomsdayClockExecutionSnapshot } from "../execution/DoomsdayClockExecution";
import { EmbargoAllExecutionSnapshot } from "../execution/EmbargoAllExecution";
import { EmbargoExecutionSnapshot } from "../execution/EmbargoExecution";
import { EmojiExecutionSnapshot } from "../execution/EmojiExecution";
import { FactoryExecutionSnapshot } from "../execution/FactoryExecution";
import { HordeBandExecutionSnapshot } from "../execution/HordeBandExecution";
import { HordeNightExecutionSnapshot } from "../execution/HordeNightExecution";
import { MarkDisconnectedExecutionSnapshot } from "../execution/MarkDisconnectedExecution";
import { MirvExecutionSnapshot } from "../execution/MIRVExecution";
import { MissileSiloExecutionSnapshot } from "../execution/MissileSiloExecution";
import { MoveWarshipExecutionSnapshot } from "../execution/MoveWarshipExecution";
import { NationExecutionSnapshot } from "../execution/NationExecution";
import { NoOpExecutionSnapshot } from "../execution/NoOpExecution";
import { NukeExecutionSnapshot } from "../execution/NukeExecution";
import { PauseExecutionSnapshot } from "../execution/PauseExecution";
import { PlagueExecutionSnapshot } from "../execution/PlagueExecution";
import { PlayerExecutionSnapshot } from "../execution/PlayerExecution";
import { PortExecutionSnapshot } from "../execution/PortExecution";
import { QuickChatExecutionSnapshot } from "../execution/QuickChatExecution";
import { RecomputeRailClusterExecutionSnapshot } from "../execution/RecomputeRailClusterExecution";
import { ResourceSiteExecutionSnapshot } from "../execution/ResourceSiteExecution";
import { RetreatExecutionSnapshot } from "../execution/RetreatExecution";
import { RisingTideExecutionSnapshot } from "../execution/RisingTideExecution";
import { RuinsExecutionSnapshot } from "../execution/RuinsExecution";
import { SAMLauncherExecutionSnapshot } from "../execution/SAMLauncherExecution";
import { SAMMissileExecutionSnapshot } from "../execution/SAMMissileExecution";
import { ShellExecutionSnapshot } from "../execution/ShellExecution";
import { SpawnExecutionSnapshot } from "../execution/SpawnExecution";
import { SpawnTimerExecutionSnapshot } from "../execution/SpawnTimerExecution";
import { TargetPlayerExecutionSnapshot } from "../execution/TargetPlayerExecution";
import { TradeShipExecutionSnapshot } from "../execution/TradeShipExecution";
import { TrainExecutionSnapshot } from "../execution/TrainExecution";
import { TrainStationExecutionSnapshot } from "../execution/TrainStationExecution";
import { TransportShipExecutionSnapshot } from "../execution/TransportShipExecution";
import { TribeExecutionSnapshot } from "../execution/TribeExecution";
import { UpgradeStructureExecutionSnapshot } from "../execution/UpgradeStructureExecution";
import { VolcanoExecutionSnapshot } from "../execution/VolcanoExecution";
import { WarshipExecutionSnapshot } from "../execution/WarshipExecution";
import { WeatherExecutionSnapshot } from "../execution/WeatherExecution";
import { WinCheckExecutionSnapshot } from "../execution/WinCheckExecution";
import type { ExecutionSnapshotType } from "./ExecutionSnapshot";

/**
 * Every execution class, by the type name its snapshots are stored under.
 * A class missing here cannot be snapshotted (snapshotGame throws), and a
 * stored type missing here cannot be restored. Retiring a class means
 * keeping an entry whose restoreSnapshot maps old records onto whatever
 * replaced it.
 *
 * Retired without a replacement, so never reuse these record names:
 * "Airbase", "AirMission", "Canal", "CoastalBattery", "Drone", "DroneSwarm",
 * "FlakGun" and "Minefield" (the units removed from the fork; their old
 * records no longer restore, see snapshot/README.md).
 */
export const EXECUTION_SNAPSHOT_TYPES = [
  AllianceExtensionExecutionSnapshot,
  AllianceRejectExecutionSnapshot,
  AllianceRequestExecutionSnapshot,
  AttackExecutionSnapshot,
  BoatRetreatExecutionSnapshot,
  BreakAllianceExecutionSnapshot,
  CityExecutionSnapshot,
  CityStateExecutionSnapshot,
  ConstructionExecutionSnapshot,
  ConvoyExecutionSnapshot,
  DefensePostExecutionSnapshot,
  DeleteUnitExecutionSnapshot,
  DonateGoldExecutionSnapshot,
  DonateTroopsExecutionSnapshot,
  DoomsdayClockExecutionSnapshot,
  EmbargoAllExecutionSnapshot,
  EmbargoExecutionSnapshot,
  EmojiExecutionSnapshot,
  FactoryExecutionSnapshot,
  HordeBandExecutionSnapshot,
  HordeNightExecutionSnapshot,
  MarkDisconnectedExecutionSnapshot,
  MirvExecutionSnapshot,
  MissileSiloExecutionSnapshot,
  MoveWarshipExecutionSnapshot,
  NationExecutionSnapshot,
  NoOpExecutionSnapshot,
  NukeExecutionSnapshot,
  PauseExecutionSnapshot,
  PlagueExecutionSnapshot,
  PlayerExecutionSnapshot,
  PortExecutionSnapshot,
  QuickChatExecutionSnapshot,
  RecomputeRailClusterExecutionSnapshot,
  RetreatExecutionSnapshot,
  RisingTideExecutionSnapshot,
  RuinsExecutionSnapshot,
  SAMLauncherExecutionSnapshot,
  SAMMissileExecutionSnapshot,
  ShellExecutionSnapshot,
  SpawnExecutionSnapshot,
  SpawnTimerExecutionSnapshot,
  TargetPlayerExecutionSnapshot,
  TradeShipExecutionSnapshot,
  TrainExecutionSnapshot,
  TrainStationExecutionSnapshot,
  TransportShipExecutionSnapshot,
  TribeExecutionSnapshot,
  UpgradeStructureExecutionSnapshot,
  VolcanoExecutionSnapshot,
  WarshipExecutionSnapshot,
  WeatherExecutionSnapshot,
  WinCheckExecutionSnapshot,
  ResourceSiteExecutionSnapshot,
] as unknown as readonly ExecutionSnapshotType<unknown>[];
