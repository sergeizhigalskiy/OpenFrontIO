import { normalizeShareOrigin } from "@openfront/shared/configuration/ShareOrigin";
import { afterEach, describe, expect, it } from "vitest";
import { ClientEnv } from "../../src/client/ClientEnv";

// SHARE_ORIGIN: the host plays on localhost while friends come in through a
// tunnel, so the invite links the host copies must carry the tunnel address,
// not the host's own localhost one.

describe("normalizeShareOrigin", () => {
  it("keeps an http(s) origin and drops any path or trailing slash", () => {
    expect(normalizeShareOrigin("https://some-words.trycloudflare.com")).toBe(
      "https://some-words.trycloudflare.com",
    );
    expect(normalizeShareOrigin("https://some-words.trycloudflare.com/")).toBe(
      "https://some-words.trycloudflare.com",
    );
    expect(normalizeShareOrigin("http://192.168.0.5:9000/play?x=1")).toBe(
      "http://192.168.0.5:9000",
    );
  });

  it("reads anything else as unset", () => {
    expect(normalizeShareOrigin(undefined)).toBeUndefined();
    expect(normalizeShareOrigin("")).toBeUndefined();
    expect(normalizeShareOrigin("not a url")).toBeUndefined();
    expect(normalizeShareOrigin("ftp://example.com")).toBeUndefined();
    expect(normalizeShareOrigin("javascript:alert(1)")).toBeUndefined();
  });
});

describe("invite links with an injected share origin", () => {
  afterEach(() => {
    delete (window as any).BOOTSTRAP_CONFIG;
    ClientEnv.reset();
  });

  it("uses the page's own origin when none is injected", () => {
    expect(ClientEnv.shareOrigin()).toBe(window.location.origin);
    expect(ClientEnv.shareBase()).toBe(
      `${window.location.origin}${window.location.pathname}`,
    );
  });

  it("uses the injected origin for lobby links and hash links", () => {
    (window as any).BOOTSTRAP_CONFIG = {
      shareOrigin: "https://some-words.trycloudflare.com",
    };
    expect(ClientEnv.shareOrigin()).toBe(
      "https://some-words.trycloudflare.com",
    );
    expect(ClientEnv.shareBase()).toBe(
      `https://some-words.trycloudflare.com${window.location.pathname}`,
    );
  });

  it("needs nothing else from BOOTSTRAP_CONFIG to build the link", () => {
    // Only shareOrigin is present: ClientEnv.get() would throw on this page,
    // so reaching it would fail the test.
    (window as any).BOOTSTRAP_CONFIG = { shareOrigin: "https://a.example" };
    expect(() => ClientEnv.shareOrigin()).not.toThrow();
  });
});
