import { describe, expect, test } from "bun:test";
import { narinfoUrl } from "./cache.ts";

describe("narinfoUrl", () => {
  test("removes Nix store settings from the HTTP request", () => {
    expect(
      narinfoUrl(
        "https://cache.numtide.com?priority=41&trusted=true&compression=zstd&want-mass-query=false",
        "m3wvxvsrcrggpkm748b4iqhdy86q32aa",
      ),
    ).toBe(
      "https://cache.numtide.com/m3wvxvsrcrggpkm748b4iqhdy86q32aa.narinfo",
    );
  });

  test("keeps a cache path prefix", () => {
    expect(
      narinfoUrl(
        "https://cache.example.test/nix/cache/?priority=10",
        "0123456789abcdfghijklmnpqrsvwxyz",
      ),
    ).toBe(
      "https://cache.example.test/nix/cache/0123456789abcdfghijklmnpqrsvwxyz.narinfo",
    );
  });
});
