/**
 * The game server's ports in development: the master listens on the base
 * port and worker i on base + 1 + i. GAME_PORT_BASE moves the block (the
 * launchers pick a free one, because Windows can reserve 3000 at boot);
 * without it, or with a bad value, the base is 3000.
 */
export const DEFAULT_GAME_PORT_BASE = 3000;

export function gamePortBase(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65500 ? n : DEFAULT_GAME_PORT_BASE;
}
