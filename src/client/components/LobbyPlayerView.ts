import {
  ColoredTeams,
  Difficulty,
  Duos,
  GameMode,
  HumansVsNations,
  PlayerInfo,
  PlayerType,
  Quads,
  Team,
  Trios,
  formatPlayerDisplayName,
} from "@openfront/engine-api/game/GameTypes";
import {
  BOSS_RAID_NATION_BOSS,
  BossRaidConfig,
  ClientID,
  TeamCountConfig,
} from "@openfront/engine-api/Schemas";
import {
  BOSS_RAID_BOSS_TEAM,
  BOSS_RAID_RAIDER_TEAM,
  bossRaidHumanTeams,
} from "@openfront/engine-lib/game/BossRaid";
import {
  assignTeamsLobbyPreview,
  harderDifficulty,
  previewTeamNations,
  TeamNationsPreview,
} from "@openfront/engine-lib/game/TeamAssignment";
import {
  type LevelBadge,
  unpackLevelBadge,
} from "@openfront/shared/LevelBadgeWire";
import { createRandomName } from "@openfront/shared/SharedUtil";
import { ClientInfo } from "@openfront/shared/WireSchemas";
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ownHiddenLevelBadge,
  refreshOwnHiddenLevelBadge,
} from "../OwnLevelBadge";
import { Theme, themeProvider } from "../theme/ThemeProvider";
import { UserSettings } from "../UserSettings";
import {
  getTranslatedPlayerTeamLabel,
  resolveTeamClanTag,
  translateText,
} from "../Utils";
import "./LevelBadge";

function sameBadge(
  a: LevelBadge | undefined,
  b: LevelBadge | undefined,
): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.level === b.level &&
      a.prestige === b.prestige &&
      a.legend === b.legend)
  );
}

export interface TeamPreviewData {
  team: Team;
  players: ClientInfo[];
  clanTag?: string | null;
}

@customElement("lobby-player-view")
export class LobbyTeamView extends LitElement {
  @property({ type: String }) gameMode: GameMode = GameMode.FFA;
  @property({ type: Array }) clients: ClientInfo[] = [];
  @state() private teamPreview: TeamPreviewData[] = [];
  @state() private teamMaxSize: number = 0;
  // Plain team games: the nations the game deals each team, and whether the
  // teams are stacked (engine-lib TeamAssignment, the game's own rule).
  @state() private nationPreview: TeamNationsPreview | null = null;
  @property({ type: String }) lobbyCreatorClientID: string = "";
  @property({ type: String }) currentClientID: string = "";
  @property({ attribute: "team-count" }) teamCount: TeamCountConfig = 2;
  @property({ type: Function }) onKickPlayer?: (clientID: string) => void;
  @property({ type: Function }) onToggleNameReveal?: (clientID: string) => void;
  @property({ type: Array }) nameReveals: string[] = [];
  @property({ type: Boolean }) anonymizeNames: boolean = false;
  @property({ type: Number }) nationCount: number = 0;
  // The lobby's nation difficulty, for the nations each team is dealt.
  @property({ type: String }) difficulty: Difficulty = Difficulty.Medium;
  @property({ type: Boolean }) isPublicGame: boolean = false;
  // Host team picking (src/server/HostTeamPins.ts): the lobby shows who is
  // pinned and who is left to auto balancing. Everyone sees it; only a view
  // given onAssignTeam (the host's) can move players.
  @property({ type: Boolean }) teamPicking: boolean = false;
  @property({ attribute: false }) onAssignTeam?: (
    clientID: string,
    teamIndex: number | null,
  ) => void;
  // Boss Raid: the preview is the Boss against everyone else.
  @property({ attribute: false }) bossRaid: BossRaidConfig | null = null;
  // Tap to pick a player up, tap a team to drop them (touch has no drag).
  @state() private pickedUp: string | null = null;
  @state() private pickError: string | null = null;

  private get theme(): Theme {
    return themeProvider.current();
  }
  @state() private showTeamColors: boolean = false;
  private _clanUpdateTimeout: number | null = null;
  private _teamClanTags: Map<Team, string | null> = new Map();
  private _viewerFriends: ReadonlySet<ClientID> = new Set();
  // The viewer's own badge while they hide their level: the server leaves it
  // off their roster entry, but they still see their own level.
  @state() private _ownHiddenBadge: LevelBadge | undefined =
    ownHiddenLevelBadge();

  // Spectators are in the lobby roster (flagged) but hold no seat and never
  // reach the simulation — so the count header, the team preview and both
  // player lists show PLAYERS only, and spectators get their own bubble below.
  private get activePlayers(): ClientInfo[] {
    return this.clients.filter((c) => !c.spectator);
  }
  private get spectators(): ClientInfo[] {
    return this.clients.filter((c) => c.spectator === true);
  }
  private userSettings: UserSettings = new UserSettings();

  /**
   * For public HumansVsNations games, nation count always matches human count
   * (server enforces this in NationCreation). For private games, the host
   * controls the nation count via the slider.
   */
  private get effectiveNationCount(): number {
    if (this.isPublicGame && this.teamCount === HumansVsNations) {
      return this.activePlayers.length;
    }
    return this.nationCount;
  }

  willUpdate(changedProperties: Map<string, any>) {
    if (
      changedProperties.has("clients") ||
      changedProperties.has("currentClientID")
    ) {
      const self = this.currentClientID
        ? this.clients.find((c) => c.clientID === this.currentClientID)
        : undefined;
      this._viewerFriends = new Set(self?.friends ?? []);
    }
    // On joining and on every roster update, so a visibility change made in
    // the account settings shows by the next lobby_info. From the memoised
    // /users/@me, so normally no request at all.
    if (
      (changedProperties.has("currentClientID") ||
        changedProperties.has("clients")) &&
      this.currentClientID
    ) {
      const forClient = this.currentClientID;
      void refreshOwnHiddenLevelBadge().then((badge) => {
        if (this.currentClientID !== forClient) return;
        if (!sameBadge(badge, this._ownHiddenBadge)) {
          this._ownHiddenBadge = badge;
        }
      });
    }
    // Recompute team preview when relevant properties change
    // clients is updated from WebSocket lobby_info events
    if (
      changedProperties.has("gameMode") ||
      changedProperties.has("clients") ||
      changedProperties.has("teamCount") ||
      changedProperties.has("nationCount") ||
      changedProperties.has("difficulty") ||
      changedProperties.has("isPublicGame") ||
      changedProperties.has("bossRaid")
    ) {
      const teamsList = this.getTeamList();
      this.computeTeamPreview(teamsList);
      this.showTeamColors = teamsList.length <= 7;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._clanUpdateTimeout !== null) {
      window.clearTimeout(this._clanUpdateTimeout);
      this._clanUpdateTimeout = null;
    }
  }

  render() {
    return html`
      <div class="border-t border-white/10 pt-6">
        <div class="flex justify-between items-center mb-4">
          <div
            class="text-xs font-bold text-white/40 uppercase tracking-widest"
          >
            ${this.activePlayers.length}
            ${
              this.activePlayers.length === 1
                ? translateText("host_modal.player")
                : translateText("host_modal.players")
            }
            <span style="margin: 0 8px;">•</span>
            ${this.effectiveNationCount}
            ${
              this.effectiveNationCount === 1
                ? translateText("host_modal.nation_player")
                : translateText("host_modal.nation_players")
            }
          </div>
        </div>
        <div
          class="players-list block rounded-lg border border-white/10 bg-white/5 p-2"
        >
          ${
            this.gameMode === GameMode.Team
              ? this.renderTeamMode()
              : this.renderFreeForAll()
          }
        </div>
        ${this.renderSpectators()}
      </div>
    `;
  }

  // Watchers, in their own bubble under the players box — they hold no seat, so
  // mixing them into the lists above would show them as people about to play.
  // Mirrors the players section: the count header sits ABOVE the box (same
  // classes as the "N players" header) and the box reuses .players-list, which
  // is what centers the tags.
  private renderSpectators() {
    const spectators = this.spectators;
    if (spectators.length === 0) return html``;
    return html`
      <div class="mt-4">
        <div
          class="text-xs font-bold text-white/40 uppercase tracking-widest mb-4"
        >
          ${spectators.length}
          ${
            spectators.length === 1
              ? translateText("host_modal.spectator")
              : translateText("host_modal.spectators")
          }
        </div>
        <div
          class="players-list block rounded-lg border border-white/10 bg-white/5 p-2"
        >
          ${repeat(
            spectators,
            (c) => c.clientID ?? c.username,
            (client) =>
              html`<span
                class="player-tag ${
                  this.isCurrentPlayer(client) ? "current-player" : ""
                }"
              >
                <span class="text-white"
                  >${this.renderLevelBadge(
                    client,
                    false,
                  )}${this.getClientDisplayName(client)}
                  ${this.renderVerifiedBadge(client)}</span
                >
              </span>`,
          )}
        </div>
      </div>
    `;
  }

  createRenderRoot() {
    return this;
  }

  private renderTeamMode() {
    const alwaysShown = (t: TeamPreviewData) =>
      t.team === ColoredTeams.Nations ||
      this.bossRaid !== null ||
      this.nationsOn(t.team) > 0;
    const active = this.teamPreview.filter(
      (t) => t.players.length > 0 || alwaysShown(t),
    );
    const empty = this.teamPreview.filter(
      (t) => t.players.length === 0 && !alwaysShown(t),
    );
    // With team picking the left list is the "auto" bucket: the players the
    // host hasn't pinned, whom the game balances into the open seats.
    const picking = this.teamPickingActive();
    const listed = picking
      ? this.activePlayers.filter((c) => c.teamIndex === undefined)
      : this.activePlayers;
    const listSlot = this.anyVisibleLevelBadge(listed);
    return html` <div
      class="flex flex-col md:flex-row gap-3 md:gap-4 items-stretch"
    >
      <div
        class="w-full md:w-60 bg-gray-800 p-2 border rounded-lg ${
          picking && this.pickedUp !== null
            ? "border-sky-500/60 cursor-pointer"
            : "border-gray-700"
        }"
        data-team-drop="auto"
        @dragover=${this.allowDrop}
        @drop=${(e: DragEvent) => this.dropOn(e, null)}
        @click=${() => this.dropPickedUp(null)}
      >
        <div class="font-bold mb-1.5 text-gray-300 text-sm">
          ${
            picking
              ? translateText("host_modal.team_pick_auto_bucket")
              : translateText("host_modal.players")
          }
        </div>
        ${
          picking
            ? html`<div class="text-[11px] text-gray-400 mb-1.5">
                ${
                  this.onAssignTeam
                    ? translateText("host_modal.team_pick_hint")
                    : translateText("host_modal.team_pick_viewer_hint")
                }
              </div>`
            : nothing
        }
        ${repeat(
          listed,
          (c) => c.clientID ?? c.username,
          (client) => {
            const displayName = this.getClientDisplayName(client);
            return html`<div
              class="px-2 py-1 rounded-sm mb-1 text-xs text-white border break-words
                ${
                this.pickedUp === client.clientID
                  ? "bg-sky-500/30 border-sky-400"
                  : this.isCurrentPlayer(client)
                    ? "bg-malibu-blue/20 border-sky-500/40"
                    : "bg-gray-700/70 border-transparent"
              } ${this.canMovePlayers() ? "cursor-grab" : ""}"
              data-chip=${client.clientID}
              draggable=${this.canMovePlayers() ? "true" : "false"}
              @dragstart=${(e: DragEvent) => this.dragStart(e, client.clientID)}
              @click=${(e: Event) => this.pickUp(e, client.clientID)}
            >
              ${this.renderLevelBadge(client, listSlot)}${displayName}
              ${this.renderVerifiedBadge(client)}
              ${this.renderFriendBadge(client)}
            </div>`;
          },
        )}
      </div>
      <div class="flex-1 flex flex-col gap-3 md:gap-4 md:pr-1">
        <div>
          <div class="font-semibold text-gray-200 mb-1 text-sm">
            ${translateText("host_modal.assigned_teams")}
          </div>
          ${
            (this.nationPreview?.stacked.length ?? 0) > 0
              ? html`<div
                  class="stacked-teams-note text-xs text-amber-300 mb-1.5"
                  role="note"
                >
                  ${translateText("host_modal.stacked_teams")}
                </div>`
              : nothing
          }
          ${
            this.pickError !== null
              ? html`<div
                  class="team-pick-error text-xs text-red-300 mb-1.5"
                  role="alert"
                >
                  ${this.pickError}
                </div>`
              : nothing
          }
          <div class="w-full grid grid-cols-1 sm:grid-cols-2 gap-2 md:gap-3">
            ${repeat(
              active,
              (p) => p.team,
              (preview) => this.renderTeamCard(preview, false),
            )}
          </div>
        </div>
        <div>
          ${
            empty.length > 0
              ? html`<div class="font-semibold text-gray-200 mb-1 text-sm">
                  ${translateText("host_modal.empty_teams")}
                </div>`
              : ""
          }
          <div class="w-full grid grid-cols-1 sm:grid-cols-2 gap-2 md:gap-3">
            ${repeat(
              empty,
              (p) => p.team,
              (preview) => this.renderTeamCard(preview, true),
            )}
          </div>
        </div>
      </div>
    </div>`;
  }

  // Host-only per-player toggle for who may see real names under anonymizeNames.
  private renderRevealToggle(clientID: string) {
    if (!this.onToggleNameReveal || !this.anonymizeNames) return html``;
    const on = this.nameReveals.includes(clientID);
    return html`<button
      @click=${() => this.onToggleNameReveal?.(clientID)}
      title=${translateText("host_modal.toggle_name_reveal")}
      style="background:none;border:none;cursor:pointer;font-size:13px;line-height:1;margin-left:4px;opacity:${
        on ? "1" : "0.35"
      };"
    >
      👁
    </button>`;
  }

  private renderFreeForAll() {
    return html`${repeat(
      this.activePlayers,
      (c) => c.clientID ?? c.username,
      (client) => {
        const displayName = this.getClientDisplayName(client);
        return html`<span
          class="player-tag ${
            this.isCurrentPlayer(client) ? "current-player" : ""
          }"
        >
          <span class="text-white"
            >${this.renderLevelBadge(client, false)}${displayName}
            ${this.renderVerifiedBadge(client)}
            ${this.renderFriendBadge(client)}</span
          >
          ${this.renderRevealToggle(client.clientID)}
          ${
            client.clientID === this.lobbyCreatorClientID
              ? html`<span class="host-badge"
                  >(${translateText("host_modal.host_badge")})</span
                >`
              : this.onKickPlayer
                ? html`<button
                    class="remove-player-btn"
                    @click=${() => this.onKickPlayer?.(client.clientID)}
                    aria-label=${translateText("host_modal.remove_player", {
                      username: displayName,
                    })}
                  >
                    <svg
                      class="h-2.5 w-2.5 stroke-white"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"
                    >
                      <line x1="4" y1="4" x2="12" y2="12" />
                      <line x1="12" y1="4" x2="4" y2="12" />
                    </svg>
                  </button>`
                : html``
          }
        </span>`;
      },
    )} `;
  }

  private renderTeamCard(preview: TeamPreviewData, isEmpty: boolean = false) {
    const bossRaidCount = this.bossRaidCount(preview);
    const displayCount =
      bossRaidCount ??
      (preview.team === ColoredTeams.Nations
        ? this.effectiveNationCount
        : preview.players.length);

    const maxTeamSize =
      bossRaidCount ??
      (preview.team === ColoredTeams.Nations
        ? this.effectiveNationCount
        : this.teamMaxSize);
    const teamIndex = this.teamPreview.findIndex(
      (t) => t.team === preview.team,
    );
    const picking = this.teamPickingActive();

    const clanTag = this._teamClanTags.get(preview.team) ?? null;
    const teamLabel = getTranslatedPlayerTeamLabel(preview.team, clanTag);
    const badgeSlot = this.anyVisibleLevelBadge(preview.players);

    return html`
      <div
        class="bg-gray-800 border rounded-xl flex flex-col
          ${
          this.teamContainsCurrentPlayer(preview) ||
          (picking && this.pickedUp !== null)
            ? "border-sky-500/60"
            : "border-gray-700"
        } ${picking && this.pickedUp !== null ? "cursor-pointer" : ""}"
        data-team-drop=${String(teamIndex)}
        @dragover=${this.allowDrop}
        @drop=${(e: DragEvent) => this.dropOn(e, teamIndex)}
        @click=${() => this.dropPickedUp(teamIndex)}
      >
        <div
          class="px-2 py-1 font-bold flex items-center justify-between text-white rounded-t-xl text-[13px] gap-2 bg-gray-700/70"
        >
          <div class="flex items-center gap-1.5 min-w-0">
            ${
              this.showTeamColors
                ? html` <span
                    class="inline-block w-2.5 h-2.5 rounded-full border-2 border-white/90 shadow-inner bg-(--bg) shrink-0"
                    style="--bg:${this.teamHeaderColor(preview.team)};"
                  ></span>`
                : null
            }
            <span class="truncate">${teamLabel}</span>
          </div>
          <span class="text-white/90 font-bold text-[13px] shrink-0"
            >${displayCount}/${maxTeamSize}</span
          >
        </div>
        <div class="p-2 ${isEmpty ? "" : "flex flex-col gap-1.5"}">
          ${this.renderNationBoss(preview)} ${this.renderTeamNations(preview)}
          ${
            isEmpty
              ? html`<div class="text-[11px] italic text-gray-400">
                  ${translateText("host_modal.empty_team")}
                </div>`
              : repeat(
                  preview.players,
                  (p) => p.clientID ?? p.username,
                  (p) => {
                    const displayName = this.getClientDisplayName(p);
                    return html` <div
                      class="px-2 py-1 rounded-sm text-xs flex items-center justify-between border
                      ${
                        this.pickedUp === p.clientID
                          ? "bg-sky-500/30 border-sky-400"
                          : this.isCurrentPlayer(p)
                            ? "bg-malibu-blue/20 border-sky-500/40"
                            : "bg-gray-700/70 border-transparent"
                      } ${this.canMovePlayers() ? "cursor-grab" : ""}"
                      data-chip=${p.clientID}
                      draggable=${this.canMovePlayers() ? "true" : "false"}
                      @dragstart=${(e: DragEvent) =>
                        this.dragStart(e, p.clientID)}
                      @click=${(e: Event) => this.pickUp(e, p.clientID)}
                    >
                      <span class="flex items-center gap-1 min-w-0">
                        ${this.renderLevelBadge(p, badgeSlot)}
                        <span class="truncate text-white">${displayName}</span>
                        ${this.renderVerifiedBadge(p)}
                        ${this.renderFriendBadge(p)}
                        ${picking ? this.renderPinTag(p) : nothing}
                      </span>
                      ${this.renderRevealToggle(p.clientID)}
                      ${
                        p.clientID === this.lobbyCreatorClientID
                          ? html`<span class="ml-2 text-[11px] text-green-300"
                              >(${translateText("host_modal.host_badge")})</span
                            >`
                          : this.onKickPlayer
                            ? html`<button
                                class="remove-player-btn ml-2"
                                @click=${() => this.onKickPlayer?.(p.clientID)}
                                aria-label=${translateText(
                                  "host_modal.remove_player",
                                  {
                                    username: displayName,
                                  },
                                )}
                              >
                                <svg
                                  class="h-2.5 w-2.5 stroke-white"
                                  viewBox="0 0 16 16"
                                  fill="none"
                                  stroke="currentColor"
                                  stroke-width="2.5"
                                  stroke-linecap="round"
                                >
                                  <line x1="4" y1="4" x2="12" y2="12" />
                                  <line x1="12" y1="4" x2="4" y2="12" />
                                </svg>
                              </button>`
                            : html``
                      }
                    </div>`;
                  },
                )
          }
        </div>
      </div>
    `;
  }

  /** Nations the game will deal `team` (plain team games only). */
  private nationsOn(team: Team): number {
    return this.nationPreview?.nations.get(team) ?? 0;
  }

  // The nations a team will get and the difficulty they play at: one step
  // harder on a stacked game's short-handed teams.
  private renderTeamNations(preview: TeamPreviewData) {
    const count = this.nationsOn(preview.team);
    if (count === 0 || this.nationPreview === null) return nothing;
    const stacked = this.nationPreview.stacked.includes(preview.team);
    const difficulty = stacked
      ? harderDifficulty(this.difficulty)
      : this.difficulty;
    const key =
      stacked && this.difficulty === Difficulty.Impossible
        ? "host_modal.team_nations_growth"
        : "host_modal.team_nations";
    return html`<div
      class="team-nations px-2 py-1 rounded-sm text-xs border ${
        stacked
          ? "text-amber-200 border-amber-500/40 bg-amber-500/10"
          : "text-gray-300 border-white/10 bg-white/5"
      }"
    >
      ${translateText(key, {
        count,
        difficulty: translateText(`difficulty.${difficulty.toLowerCase()}`),
      })}
    </div>`;
  }

  private getTeamList(): Team[] {
    if (this.gameMode !== GameMode.Team) return [];
    if (this.bossRaid !== null) {
      return [BOSS_RAID_BOSS_TEAM, BOSS_RAID_RAIDER_TEAM];
    }
    const playerCount = this.activePlayers.length + this.effectiveNationCount;
    const config = this.teamCount;

    if (config === HumansVsNations) {
      return [ColoredTeams.Humans, ColoredTeams.Nations];
    }

    let numTeams: number;
    if (typeof config === "number") {
      numTeams = Math.max(2, config);
    } else {
      const divisor =
        config === Duos ? 2 : config === Trios ? 3 : config === Quads ? 4 : 2;
      numTeams = Math.max(2, Math.ceil(playerCount / divisor));
    }

    if (numTeams < 8) {
      const ordered: Team[] = [
        ColoredTeams.Red,
        ColoredTeams.Blue,
        ColoredTeams.Yellow,
        ColoredTeams.Green,
        ColoredTeams.Purple,
        ColoredTeams.Orange,
        ColoredTeams.Teal,
      ];
      return ordered.slice(0, numTeams);
    }

    return Array.from({ length: numTeams }, (_, i) => `Team ${i + 1}`);
  }

  private teamHeaderColor(team: Team): string {
    try {
      return this.theme.teamColor(team).toHex();
    } catch {
      return "#3b3f46"; // Default gray for unknown teams
    }
  }

  private computeTeamPreview(teams: Team[] = []) {
    this.nationPreview = null;
    if (this.gameMode !== GameMode.Team) {
      this.teamPreview = [];
      this.teamMaxSize = 0;
      this._teamClanTags.clear();
      if (this._clanUpdateTimeout !== null) {
        window.clearTimeout(this._clanUpdateTimeout);
        this._clanUpdateTimeout = null;
      }
      return;
    }

    // Boss Raid: the Boss alone (a volunteer, or a nation shown as a row of
    // its own), everyone else a Raider. Same rule the game uses.
    if (this.bossRaid !== null) {
      const teamOf = bossRaidHumanTeams(
        this.bossRaid,
        this.activePlayers,
        this.effectiveNationCount,
      );
      const players = this.activePlayers;
      this.teamMaxSize = players.length + this.effectiveNationCount;
      this.teamPreview = [
        {
          team: BOSS_RAID_BOSS_TEAM,
          players: players.filter((_, i) => teamOf[i] === BOSS_RAID_BOSS_TEAM),
        },
        {
          team: BOSS_RAID_RAIDER_TEAM,
          players: players.filter((_, i) => teamOf[i] !== BOSS_RAID_BOSS_TEAM),
        },
      ];
      this.triggerClanUpdate();
      return;
    }

    // HumansVsNations: show all clients under Humans initially
    if (this.teamCount === HumansVsNations) {
      this.teamMaxSize = this.activePlayers.length;
      this.teamPreview = [
        { team: ColoredTeams.Humans, players: [...this.activePlayers] },
        { team: ColoredTeams.Nations, players: [] },
      ];
      this.triggerClanUpdate();
      return;
    }

    const players = this.activePlayers.map(
      (c) =>
        new PlayerInfo(
          c.username,
          PlayerType.Human,
          c.clientID,
          c.clientID,
          false,
          c.clanTag,
          c.friends ?? [],
          c.teamIndex ?? null,
        ),
    );
    const assignment = assignTeamsLobbyPreview(
      players,
      teams,
      this.teamCount,
      this.effectiveNationCount,
    );
    this.nationPreview = previewTeamNations(
      players,
      teams,
      this.teamCount,
      this.effectiveNationCount,
      this.difficulty,
    );
    const buckets = new Map<Team, ClientInfo[]>();
    for (const t of teams) buckets.set(t, []);

    for (const [p, team] of assignment.entries()) {
      if (team === "kicked") continue;
      const bucket = buckets.get(team);
      if (!bucket) continue;
      const client = this.clients.find((c) => c.clientID === p.clientID);
      if (client) bucket.push(client);
    }

    // Compute per-team capacity safely and align with common team sizes
    if (this.teamCount === Duos) {
      this.teamMaxSize = 2;
    } else if (this.teamCount === Trios) {
      this.teamMaxSize = 3;
    } else if (this.teamCount === Quads) {
      this.teamMaxSize = 4;
    } else {
      // Fallback: divide players across teams; guard against 0 and empty lobbies
      this.teamMaxSize = Math.max(
        1,
        Math.ceil(
          (this.activePlayers.length + this.effectiveNationCount) /
            teams.length,
        ),
      );
    }
    this.teamPreview = teams.map((t) => ({
      team: t,
      players: buckets.get(t) ?? [],
    }));
    this.triggerClanUpdate();
  }

  private teamPickingActive(): boolean {
    return (
      this.teamPicking &&
      this.gameMode === GameMode.Team &&
      this.bossRaid === null &&
      this.teamCount !== HumansVsNations
    );
  }

  private canMovePlayers(): boolean {
    return this.teamPickingActive() && this.onAssignTeam !== undefined;
  }

  private readonly allowDrop = (e: DragEvent) => {
    if (!this.canMovePlayers()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  };

  private dragStart(e: DragEvent, clientID: string) {
    if (!this.canMovePlayers()) return;
    e.dataTransfer?.setData("text/plain", clientID);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    this.pickedUp = clientID;
  }

  private dropOn(e: DragEvent, teamIndex: number | null) {
    if (!this.canMovePlayers()) return;
    e.preventDefault();
    e.stopPropagation();
    const dragged = e.dataTransfer?.getData("text/plain") ?? "";
    const clientID = dragged !== "" ? dragged : this.pickedUp;
    this.pickedUp = null;
    if (clientID !== null) this.assignTeam(clientID, teamIndex);
  }

  private pickUp(e: Event, clientID: string) {
    if (!this.canMovePlayers()) return;
    e.stopPropagation();
    this.pickedUp = this.pickedUp === clientID ? null : clientID;
  }

  private dropPickedUp(teamIndex: number | null) {
    if (!this.canMovePlayers() || this.pickedUp === null) return;
    const clientID = this.pickedUp;
    this.pickedUp = null;
    this.assignTeam(clientID, teamIndex);
  }

  /**
   * Moves a player for the host. A full team is refused here with a message,
   * before anything is sent; the server checks the same rule.
   */
  assignTeam(clientID: string, teamIndex: number | null) {
    if (!this.canMovePlayers()) return;
    const client = this.activePlayers.find((c) => c.clientID === clientID);
    if (client === undefined) return;
    if ((client.teamIndex ?? null) === teamIndex) {
      this.pickError = null;
      return;
    }
    if (teamIndex !== null) {
      const pinned = this.activePlayers.filter(
        (c) => c.teamIndex === teamIndex && c.clientID !== clientID,
      ).length;
      if (pinned >= this.teamMaxSize) {
        const team = this.teamPreview[teamIndex]?.team ?? "";
        this.pickError = translateText("team_pick.team_full_named", {
          team: getTranslatedPlayerTeamLabel(team),
          max: this.teamMaxSize,
        });
        return;
      }
    }
    this.pickError = null;
    this.onAssignTeam?.(clientID, teamIndex);
  }

  private renderPinTag(client: ClientInfo) {
    return client.teamIndex !== undefined
      ? html`<span
          class="team-pin-tag ml-1 text-[10px] uppercase tracking-wide text-amber-300 shrink-0"
          >${translateText("host_modal.team_pick_pinned")}</span
        >`
      : html`<span
          class="team-auto-tag ml-1 text-[10px] uppercase tracking-wide text-gray-400 shrink-0"
          >${translateText("host_modal.team_pick_auto")}</span
        >`;
  }

  // Boss Raid head counts, nations included: the Boss team holds one, the
  // Raiders everyone else. Null outside a Boss Raid.
  private bossRaidCount(preview: TeamPreviewData): number | null {
    if (this.bossRaid === null) return null;
    if (preview.team === BOSS_RAID_BOSS_TEAM) return 1;
    const nationBoss = this.isNationBoss();
    return (
      preview.players.length +
      Math.max(0, this.effectiveNationCount - (nationBoss ? 1 : 0))
    );
  }

  private isNationBoss(): boolean {
    if (this.bossRaid === null) return false;
    const boss = this.teamPreview.find((t) => t.team === BOSS_RAID_BOSS_TEAM);
    return (
      this.bossRaid.boss === BOSS_RAID_NATION_BOSS ||
      (boss !== undefined && boss.players.length === 0)
    );
  }

  private renderNationBoss(preview: TeamPreviewData) {
    if (
      this.bossRaid === null ||
      preview.team !== BOSS_RAID_BOSS_TEAM ||
      preview.players.length > 0
    ) {
      return nothing;
    }
    return html`<div
      class="boss-raid-nation-boss px-2 py-1 rounded-sm text-xs text-red-200 border border-red-500/40 bg-red-500/10"
    >
      ${translateText("boss_raid.nation_boss")}
    </div>`;
  }

  private triggerClanUpdate() {
    if (this._teamClanTags.size === 0) {
      this.updateTeamClanTags();
    } else {
      this.scheduleClanUpdate();
    }
  }

  private scheduleClanUpdate() {
    if (this._clanUpdateTimeout !== null) return;
    this._clanUpdateTimeout = window.setTimeout(() => {
      this.updateTeamClanTags();
      this._clanUpdateTimeout = null;
      this.requestUpdate();
    }, 500);
  }

  private updateTeamClanTags() {
    this._teamClanTags.clear();
    for (const preview of this.teamPreview) {
      const tag = resolveTeamClanTag(preview.players);
      this._teamClanTags.set(preview.team, tag);
    }
  }

  private isCurrentPlayer(client: ClientInfo): boolean {
    return !!this.currentClientID && client.clientID === this.currentClientID;
  }

  private teamContainsCurrentPlayer(preview: TeamPreviewData): boolean {
    return preview.players.some((p) => this.isCurrentPlayer(p));
  }

  private getClientDisplayName(client: ClientInfo): string {
    const full = formatPlayerDisplayName(client.username, client.clanTag);
    if (!this.userSettings.anonymousNames()) {
      return full;
    }
    if (this.currentClientID && client.clientID === this.currentClientID) {
      return full;
    }
    // Keep clan tag visible while anonymizing only the username.
    const anonymizedUsername =
      createRandomName(client.username, PlayerType.Human) ?? client.username;
    return formatPlayerDisplayName(anonymizedUsername, client.clanTag);
  }

  // Blue check for players on their server-validated account name. Withheld
  // when this row's name is locally anonymized — the badge vouches for the
  // exact displayed name.
  private renderVerifiedBadge(client: ClientInfo) {
    const anonymized =
      this.userSettings.anonymousNames() && !this.isCurrentPlayer(client);
    if (client.verified !== true || anonymized) return html``;
    return html`<svg
      viewBox="0 0 24 24"
      class="inline-block w-3.5 h-3.5 align-[-2px] text-blue-400 shrink-0"
      aria-label=${translateText("username.verified_heading")}
    >
      <circle cx="12" cy="12" r="10" fill="currentColor"></circle>
      <path
        d="M7.5 12.5l3 3 6-6.5"
        stroke="white"
        stroke-width="2.2"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></path>
    </svg>`;
  }

  // The level badge this viewer may see for `client`: none for guests and
  // server-anonymized entries (they arrive without one), and none for other
  // players while the viewer has anonymous names on — the badge belongs to
  // the real name, like the verified check above.
  // The viewer's own entry has no badge while they hide their level, so it
  // falls back to the one from their own /users/@me.
  private visibleLevelBadge(client: ClientInfo): LevelBadge | undefined {
    if (this.isCurrentPlayer(client)) {
      return unpackLevelBadge(client.levelBadge) ?? this._ownHiddenBadge;
    }
    return this.userSettings.anonymousNames()
      ? undefined
      : unpackLevelBadge(client.levelBadge);
  }

  private anyVisibleLevelBadge(clients: readonly ClientInfo[]): boolean {
    return clients.some((c) => this.visibleLevelBadge(c) !== undefined);
  }

  // The player's level badge, in front of their name. With `slot`, a player
  // without one gets an empty space the same size instead, so the names in a
  // column line up; column layouts pass it only when someone in the list has
  // a visible badge, so a list with no badges renders exactly as before.
  // `stagger`: a full lobby's badges arriving at once are drawn over the
  // next few frames instead of all in one (see LevelBadgeFill); a few at a
  // time, like a player joining, are drawn straight away.
  private renderLevelBadge(client: ClientInfo, slot: boolean) {
    const badge = this.visibleLevelBadge(client);
    if (badge === undefined) {
      return slot
        ? html`<span
            class="lobby-level-slot inline-block w-6 h-6 align-[-7px] shrink-0 mr-1.5"
            aria-hidden="true"
          ></span>`
        : html``;
    }
    return html`<level-badge
      stagger
      class="inline-block align-[-7px] shrink-0 mr-1.5"
      .level=${badge.level}
      .prestige=${badge.prestige}
      ?legend=${badge.legend}
      size="24"
    ></level-badge>`;
  }

  // A mark for players on the viewer's friends list
  private renderFriendBadge(client: ClientInfo) {
    if (!this._viewerFriends.has(client.clientID)) return html``;
    if (this.isCurrentPlayer(client)) return html``;
    if (this.anonymizeNames || this.userSettings.anonymousNames())
      return html``;
    return html`<svg
      viewBox="0 0 24 24"
      class="lobby-friend-badge inline-block w-4 h-4 align-[-3px] text-emerald-400 shrink-0"
      fill="currentColor"
      aria-label=${translateText("friends.lobby_marker")}
    >
      <title>${translateText("friends.lobby_marker")}</title>
      <circle cx="9" cy="8" r="3.6"></circle>
      <path
        d="M9 13.2c-3.4 0-6.3 1.7-6.3 3.9V20h12.6v-2.9c0-2.2-2.9-3.9-6.3-3.9z"
      ></path>
      <circle cx="17.4" cy="8.6" r="2.9"></circle>
      <path
        d="M17.4 13.4c-.7 0-1.3.06-1.9.18 1.2 1 1.9 2.24 1.9 3.52V20h5.4v-2.6c0-1.9-2.4-4-5.4-4z"
      ></path>
    </svg>`;
  }
}
