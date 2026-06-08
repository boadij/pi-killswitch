import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type PackageJson = {
  main?: unknown;
  exports?: unknown;
  files?: string[];
  pi?: { extensions?: string[]; image?: string };
  peerDependencies?: Record<string, string>;
};

async function packageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
}

describe("package manifest", () => {
  it("is explicitly Pi-extension-only", async () => {
    const pkg = await packageJson();
    expect(pkg.main).toBeUndefined();
    expect(pkg.exports).toBeUndefined();
    expect(pkg.pi?.extensions).toEqual(["./index.ts"]);
  });

  it("publishes every Pi extension target and no missing image", async () => {
    const pkg = await packageJson();
    for (const target of pkg.pi?.extensions ?? []) {
      await expect(
        access(join(process.cwd(), target)),
      ).resolves.toBeUndefined();
      expect(pkg.files).toContain(target.replace(/^\.\//, ""));
    }
    expect(pkg.pi?.image).toBeUndefined();
  });

  it("does not expose unused Pi packages as peers", async () => {
    const pkg = await packageJson();
    expect(pkg.peerDependencies).toEqual({
      "@earendil-works/pi-coding-agent": "*",
    });
  });
});
