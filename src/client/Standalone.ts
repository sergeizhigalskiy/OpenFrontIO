import { ClientEnv } from "./ClientEnv";

/**
 * Whether this page runs standalone: STANDALONE=true on the server that
 * rendered it, a private copy of the game with no account backend behind it.
 *
 * Standalone is not dev mode. It switches off the account and API parts
 * only: the page signs nobody in, contacts no account API, ad, Turnstile or
 * telemetry host, and shows none of the account UI (sign in, store,
 * inventory, leaderboard, clans, ranked, Buy on Steam, ad slots). Play,
 * Solo, Tutorial, Create and Join Lobby, the public lobby cards, settings and
 * help all stay.
 *
 * The same answer as ClientEnv.standalone(), but it never throws: components
 * render in places (tests, a broken shell) with no BOOTSTRAP_CONFIG at all,
 * and a page that names no environment is not standalone. Code that is about
 * to build an account API URL needs no guard of its own to stay safe:
 * getApiBase() and ClientEnv.jwtIssuer() both refuse in standalone, so a
 * forgotten check fails into the caller's catch instead of sending anything.
 */
export function isStandalone(): boolean {
  try {
    return ClientEnv.standalone();
  } catch {
    return false;
  }
}
