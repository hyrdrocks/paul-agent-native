import path from "path";

import { describe, expect, it } from "vitest";

import {
  PUBLIC_GENERATED_DIR,
  PUBLIC_LOGOS_DIR,
  legacyAssetTarget,
  lookupPublicFile,
} from "./public-media";

describe("legacyAssetTarget", () => {
  it("maps generated images to the /generated namespace", () => {
    expect(legacyAssetTarget("generated/slide21-v1.png")).toEqual({
      dir: PUBLIC_GENERATED_DIR,
      relative: "slide21-v1.png",
      url: "/generated/slide21-v1.png",
    });
  });

  it("maps a hand-named logo to the /logos namespace", () => {
    expect(legacyAssetTarget("builder-logo-white.svg")).toEqual({
      dir: PUBLIC_LOGOS_DIR,
      relative: "builder-logo-white.svg",
      url: "/logos/builder-logo-white.svg",
    });
  });

  it("keeps nested paths under the generated namespace", () => {
    expect(legacyAssetTarget("generated/nested/preview.html")?.url).toBe(
      "/generated/nested/preview.html",
    );
  });

  it("has no target for an empty path", () => {
    expect(legacyAssetTarget("")).toBeNull();
  });
});

describe("lookupPublicFile", () => {
  it("finds a file that moved out of public/assets", async () => {
    const target = legacyAssetTarget("generated/slide21-v1.png");
    expect(target).not.toBeNull();
    const found = await lookupPublicFile(target!.dir, target!.relative);
    expect(found).toEqual({
      status: "found",
      filepath: path.join(PUBLIC_GENERATED_DIR, "slide21-v1.png"),
    });
  });

  it("reports a missing file as missing, not as an empty success", async () => {
    expect(await lookupPublicFile(PUBLIC_GENERATED_DIR, "nope.png")).toEqual({
      status: "missing",
    });
  });

  it("reports a traversal attempt as forbidden, distinct from missing", async () => {
    expect(
      await lookupPublicFile(PUBLIC_GENERATED_DIR, "../../package.json"),
    ).toEqual({ status: "forbidden" });
  });
});
