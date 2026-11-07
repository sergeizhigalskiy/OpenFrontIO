import path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vm from "vm";
import {
  clearAppShellContentCache,
  renderHtmlContent,
} from "../../src/server/RenderHtml";

// The page a standalone server renders (STANDALONE=true) must carry the flag
// to the client and load no third-party script: no ads, no analytics, no
// CrazyGames SDK and no Turnstile.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_TEMPLATE = path.resolve(__dirname, "../../index.html");

function bootstrapConfig(html: string): Record<string, unknown> {
  const match = /window\.BOOTSTRAP_CONFIG = (\{[\s\S]*?\n\s*\});/.exec(html);
  if (match === null) {
    throw new Error("rendered page has no window.BOOTSTRAP_CONFIG assignment");
  }
  return vm.runInNewContext(`(${match[1]})`) as Record<string, unknown>;
}

/**
 * Runs the page's classic inline scripts, in order, against a stub DOM, and
 * returns the src of every script they insert. The bundle itself (a module
 * script with a src) is not run. Each test removes the obfuscated AdShield
 * block itself when it has to: it only stays out of the way on its own when
 * the page is standalone.
 */
function scriptsLoadedBy(html: string): string[] {
  const loaded: string[] = [];
  const classList = {
    add() {},
    remove() {},
    toggle() {},
    contains: () => false,
  };
  const element = (): Record<string, unknown> => ({
    setAttribute() {},
    classList,
    style: { setProperty() {} },
    dataset: {},
  });
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const sandbox: Record<string, unknown> = {
    document: {
      createElement: () => element(),
      head: {
        appendChild: (el: { src?: unknown }) => loaded.push(String(el.src)),
      },
      body: element(),
      documentElement: element(),
      getElementById: () => null,
      addEventListener() {},
      referrer: "",
    },
    location: { search: "", hostname: "friends.example.com" },
    localStorage: storage,
    sessionStorage: storage,
    URL,
    URLSearchParams,
    Date,
    setTimeout: () => 0,
    requestAnimationFrame: () => 0,
    addEventListener() {},
    console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);

  const scripts = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
  for (const [, attrs = "", code] of html.matchAll(scripts)) {
    if (/\ssrc=|type="(module|application\/ld\+json)"/.test(attrs)) continue;
    vm.runInContext(code, sandbox);
  }
  return loaded;
}

function withoutAdShield(html: string): string {
  return html.replace(/<script id="HgWESkOz"[\s\S]*?<\/script>/, "");
}

describe("the page a standalone server renders", () => {
  beforeEach(() => {
    vi.stubEnv("INSTANCE_LETTER", "a");
    vi.stubEnv("NUM_WORKERS", "1");
    vi.stubEnv("DOMAIN", "example.com");
    vi.stubEnv("GIT_COMMIT", "abc");
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("FARO_COLLECTOR_URL", "https://faro.example/collect");
    vi.stubEnv("STANDALONE", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearAppShellContentCache();
  });

  it("tells the client it is standalone, with no Turnstile key or collector", async () => {
    const config = bootstrapConfig(await renderHtmlContent(REAL_TEMPLATE));
    expect(config.standalone).toBe(true);
    expect(config.turnstileSiteKey).toBe("");
    expect(config).not.toHaveProperty("faroCollectorUrl");
  });

  it("loads no third-party script", async () => {
    const html = await renderHtmlContent(REAL_TEMPLATE);
    // Every third-party script is inserted from script, so none can be
    // fetched before the flag is read.
    expect(html).not.toMatch(/<script[^>]*\ssrc="(https?:)?\/\//);
    expect(scriptsLoadedBy(html)).toEqual([]);
  });

  // The control, so the harness above cannot pass by running nothing.
  it("loads them all when the page is not standalone", async () => {
    vi.stubEnv("STANDALONE", "");
    vi.stubEnv("TURNSTILE_SITE_KEY", "test-key");
    const html = await renderHtmlContent(REAL_TEMPLATE);
    expect(bootstrapConfig(html)).not.toHaveProperty("standalone");
    const loaded = scriptsLoadedBy(withoutAdShield(html));
    for (const host of [
      "challenges.cloudflare.com",
      "sdk.crazygames.com",
      "www.googletagmanager.com",
      "static.cloudflareinsights.com",
      "cdn.intergient.com",
    ]) {
      expect(
        loaded.some((src) => src.includes(host)),
        host,
      ).toBe(true);
    }
  });
});
