import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./killswitch-core";
import {
  parseConfig,
  parseThreshold,
  readConfig,
  validateConfig,
} from "./killswitch-config";

describe("parseThreshold", () => {
  it("parses explicit thresholds", () => {
    expect(parseThreshold({ metric: "percent", value: 75 })).toEqual({
      metric: "percent",
      value: 75,
    });
    expect(parseThreshold({ metric: "tokens", value: 100_000 })).toEqual({
      metric: "tokens",
      value: 100_000,
    });
  });

  it("rejects malformed or invalid thresholds", () => {
    expect(parseThreshold({ percent: 75 })).toBeUndefined();
    expect(parseThreshold({ tokens: 100_000 })).toBeUndefined();
    expect(parseThreshold({ percent: 75, tokens: 100_000 })).toBeUndefined();
    expect(parseThreshold({ metric: "percent", value: 101 })).toBeUndefined();
    expect(parseThreshold({ metric: "tokens", value: 0 })).toBeUndefined();
  });
});

describe("parseConfig", () => {
  it("uses defaults for partial config", () => {
    const result = parseConfig({
      wrapUpThreshold: { metric: "percent", value: 70 },
    });
    expect(result).toEqual({
      ok: true,
      source: "file",
      config: {
        ...DEFAULT_CONFIG,
        wrapUpThreshold: { metric: "percent", value: 70 },
      },
    });
  });

  it("rejects invalid JSON values with fallback", () => {
    const result = parseConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fallback).toEqual(DEFAULT_CONFIG);
  });

  it("rejects invalid percent and equal thresholds", () => {
    expect(
      parseConfig({
        wrapUpThreshold: { metric: "percent", value: 70 },
        killThreshold: { metric: "percent", value: 101 },
      }).ok,
    ).toBe(false);
    expect(
      parseConfig({
        wrapUpThreshold: { metric: "percent", value: 85 },
        killThreshold: { metric: "percent", value: 85 },
      }).ok,
    ).toBe(false);
  });

  it("rejects mixed threshold metrics", () => {
    const result = parseConfig({
      wrapUpThreshold: { metric: "percent", value: 75 },
      killThreshold: { metric: "tokens", value: 100_000 },
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateConfig", () => {
  it("allows kill mode without wrap-up threshold", () => {
    expect(
      validateConfig({
        ...DEFAULT_CONFIG,
        mode: "kill",
        wrapUpThreshold: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("readConfig", () => {
  it("uses defaults when config is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "killswitch-"));
    try {
      await expect(readConfig(join(dir, "missing.json"))).resolves.toEqual({
        ok: true,
        config: DEFAULT_CONFIG,
        source: "default",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns fallback for invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "killswitch-"));
    try {
      const path = join(dir, "killswitch.json");
      await writeFile(path, "{", "utf8");
      const result = await readConfig(path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fallback).toEqual(DEFAULT_CONFIG);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
