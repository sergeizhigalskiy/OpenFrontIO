import { ClientEnv } from "./ClientEnv";
import { isStandalone } from "./Standalone";

// The account/shop API origin (api.<audience>). Lives apart from Api.ts so
// modules that Api.ts itself depends on (ServerList) can reach it without an
// import cycle; Api.ts re-exports both for its existing importers.

/** Thrown by getApiBase() on a standalone page. */
export class AccountApiDisabledError extends Error {
  constructor() {
    super("no account API in standalone mode");
    this.name = "AccountApiDisabledError";
  }
}

export function getApiBase() {
  // Fails closed. A standalone page (Standalone.ts) has no account backend
  // and must never send one anything, so it never learns the address: the
  // callers check isStandalone() first and answer as they already do for a
  // signed-out player or an unreachable API, and one that forgot lands in
  // its own catch (or throws) instead of making a request. Every account API
  // URL in the client is built from this or from ClientEnv.jwtIssuer(),
  // which refuses the same way.
  if (isStandalone()) throw new AccountApiDisabledError();
  const domainname = getAudience();

  if (domainname === "localhost") {
    const apiDomain = process.env.API_DOMAIN;
    if (apiDomain) {
      return `https://${apiDomain}`;
    }
    return localStorage.getItem("apiHost") ?? "http://localhost:8787";
  }

  return `https://api.${domainname}`;
}

export function getAudience() {
  // Sourced from BOOTSTRAP_CONFIG (server/desktop-injected) rather than
  // window.location, so the desktop app (app://openfront) targets real infra.
  return ClientEnv.jwtAudience();
}
