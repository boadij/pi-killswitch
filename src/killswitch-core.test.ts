import { describe, expect, it, vi, type Mock } from "vitest";
import {
  DEFAULT_CONFIG,
  activeThreshold,
  createInitialState,
  disarmKilledSessionBeforeNextRun,
  forceWrapUpNow,
  maybeKill,
  restoreStateFromEntries,
  statusText,
  thresholdReached,
  type ConfigResult,
  type KillswitchConfig,
  type KillswitchState,
} from "./killswitch-core";

const baseConfig: KillswitchConfig = { ...DEFAULT_CONFIG };

type TestDeps = {
  readConfig: Mock<() => Promise<ConfigResult>>;
  saveState: Mock<(state: KillswitchState) => void>;
  sendUserMessage: Mock<
    (
      prompt: string,
      options?: { deliverAs: "steer" | "followUp" },
    ) => Promise<void>
  >;
  updateStatus: Mock<(config?: KillswitchConfig) => void>;
  notify: Mock<(message: string, level?: string) => void>;
  killRun: Mock<() => Promise<void>>;
};

function ok(config: KillswitchConfig = baseConfig): ConfigResult {
  return { ok: true, config, source: "file" };
}

function createDeps(result: ConfigResult = ok()): TestDeps {
  return {
    readConfig: vi.fn(async () => result),
    saveState: vi.fn(),
    sendUserMessage: vi.fn(async () => undefined),
    updateStatus: vi.fn(),
    notify: vi.fn(),
    killRun: vi.fn(async () => undefined),
  };
}

function createState(patch: Partial<KillswitchState> = {}): KillswitchState {
  return { ...createInitialState(), ...patch };
}

function runtime(state = createState()) {
  return { state };
}

function usage(tokens: number | null, percent: number | null) {
  return { getContextUsage: () => ({ tokens, percent }) };
}

describe("statusText", () => {
  it("formats core states", () => {
    expect(
      statusText(undefined, createState(), usage(1, 1).getContextUsage()),
    ).toBe("✕ off");
    expect(
      statusText(
        baseConfig,
        createState({ killed: true }),
        usage(1, 1).getContextUsage(),
      ),
    ).toBe("✕ killed");
    expect(
      statusText(
        baseConfig,
        createState({ sessionEnabled: false, autoDisabled: true }),
        usage(1, 1).getContextUsage(),
      ),
    ).toBe("✕ paused");
    expect(
      statusText(
        baseConfig,
        createState({ sessionEnabled: false }),
        usage(1, 1).getContextUsage(),
      ),
    ).toBe("✕ off");
  });

  it("uses the active threshold for simple modes", () => {
    expect(
      statusText(
        { ...baseConfig, mode: "kill" },
        createState(),
        usage(10_000, 77).getContextUsage(),
      ),
    ).toBe("✕ kill 8%");
    expect(
      statusText(
        { ...baseConfig, mode: "wrap-up" },
        createState(),
        usage(10_000, 70).getContextUsage(),
      ),
    ).toBe("✕ wrap 5%");
  });

  it("shows the next event in wrap-up-then-kill mode", () => {
    expect(
      statusText(
        baseConfig,
        createState(),
        usage(10_000, 67).getContextUsage(),
      ),
    ).toBe("✕ wrap 8%");
    expect(
      statusText(
        baseConfig,
        createState({ wrapUpRequested: true }),
        usage(10_000, 76).getContextUsage(),
      ),
    ).toBe("✕ kill 9%");
  });

  it("handles token thresholds and unknown usage", () => {
    expect(
      statusText(
        {
          ...baseConfig,
          mode: "kill",
          killThreshold: { metric: "tokens", value: 12_000 },
        },
        createState(),
        usage(10_000, 77).getContextUsage(),
      ),
    ).toBe("✕ kill 2k");
    expect(statusText(baseConfig, createState(), undefined)).toBe("✕ ?");
  });
});

describe("thresholdReached", () => {
  it("handles token and percent thresholds", () => {
    expect(
      thresholdReached(
        { tokens: 99, percent: null },
        { metric: "tokens", value: 100 },
      ),
    ).toBe(false);
    expect(
      thresholdReached(
        { tokens: 100, percent: null },
        { metric: "tokens", value: 100 },
      ),
    ).toBe(true);
    expect(
      thresholdReached(
        { tokens: null, percent: 49 },
        { metric: "percent", value: 50 },
      ),
    ).toBe(false);
    expect(
      thresholdReached(
        { tokens: null, percent: 50 },
        { metric: "percent", value: 50 },
      ),
    ).toBe(true);
  });

  it("ignores missing usage", () => {
    expect(thresholdReached(undefined, { metric: "percent", value: 50 })).toBe(
      false,
    );
    expect(
      thresholdReached(
        { tokens: null, percent: null },
        { metric: "tokens", value: 1 },
      ),
    ).toBe(false);
  });
});

describe("activeThreshold", () => {
  it("returns kill threshold in kill mode and wrap threshold otherwise", () => {
    expect(activeThreshold({ ...baseConfig, mode: "kill" })).toEqual(
      baseConfig.killThreshold,
    );
    expect(activeThreshold({ ...baseConfig, mode: "wrap-up" })).toEqual(
      baseConfig.wrapUpThreshold,
    );
  });
});

describe("maybeKill", () => {
  it("uses safe defaults and notifies when config is invalid", async () => {
    const deps = createDeps({
      ok: false,
      error: "bad json",
      fallback: DEFAULT_CONFIG,
    });
    const rt = runtime();
    await maybeKill(deps, rt, usage(1_000, 1), "immediate");
    expect(deps.notify).toHaveBeenCalledWith(
      "killswitch config error: config: bad json. Using safe defaults.",
      "error",
    );
  });

  it("does nothing when globally disabled", async () => {
    const deps = createDeps(ok({ ...baseConfig, enabled: false }));
    const rt = runtime();
    await maybeKill(deps, rt, usage(1_000, 99), "immediate");
    expect(deps.saveState).not.toHaveBeenCalled();
  });

  it("does nothing when manually disabled", async () => {
    const deps = createDeps();
    const rt = runtime(createState({ sessionEnabled: false }));
    await maybeKill(deps, rt, usage(1_000, 99), "immediate");
    expect(deps.saveState).not.toHaveBeenCalled();
  });

  it("sends a wrap-up once when the wrap-up threshold is reached", async () => {
    const deps = createDeps();
    const rt = runtime();
    await maybeKill(deps, rt, usage(1_000, 76), "immediate");
    expect(rt.state.wrapUpRequested).toBe(true);
    expect(deps.sendUserMessage).toHaveBeenCalledWith(baseConfig.wrapUpMessage);
  });

  it("leaves failed wrap-up retryable", async () => {
    const deps = createDeps();
    deps.sendUserMessage.mockRejectedValueOnce(new Error("send failed"));
    const rt = runtime();
    await maybeKill(deps, rt, usage(1_000, 76), "immediate");
    expect(rt.state.wrapUpRequested).toBe(false);
    expect(rt.state.lastError).toBe("send failed");
    await maybeKill(deps, rt, usage(1_000, 76), "immediate");
    expect(deps.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(rt.state.wrapUpRequested).toBe(true);
  });

  it("does not duplicate wrap-up messages", async () => {
    const deps = createDeps();
    const rt = runtime(createState({ wrapUpRequested: true }));
    await maybeKill(deps, rt, usage(1_000, 76), "immediate");
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("wrap-up clears when context falls below the wrap-up threshold", async () => {
    const deps = createDeps();
    const rt = runtime(createState({ wrapUpRequested: true }));
    await maybeKill(deps, rt, usage(1_000, 60), "immediate");
    expect(rt.state.wrapUpRequested).toBe(false);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("kills when the kill threshold is reached", async () => {
    const deps = createDeps();
    const rt = runtime();
    await maybeKill(deps, rt, usage(1_000, 85), "immediate");
    expect(rt.state.killed).toBe(true);
    expect(rt.state.wrapUpRequested).toBe(false);
    expect(deps.killRun).toHaveBeenCalledTimes(1);
  });

  it("records and rethrows kill failures", async () => {
    const deps = createDeps();
    deps.killRun.mockRejectedValueOnce(new Error("abort failed"));
    const rt = runtime();
    await expect(
      maybeKill(deps, rt, usage(1_000, 85), "immediate"),
    ).rejects.toThrow("abort failed");
    expect(rt.state.killed).toBe(true);
    expect(rt.state.lastError).toBe("abort failed");
    expect(deps.notify).toHaveBeenCalledWith(
      "killswitch: kill failed: abort failed",
      "error",
    );
  });

  it("respects mode", async () => {
    const wrapDeps = createDeps(ok({ ...baseConfig, mode: "wrap-up" }));
    const wrapRt = runtime();
    await maybeKill(wrapDeps, wrapRt, usage(1_000, 99), "immediate");
    expect(wrapRt.state.killed).toBe(false);
    expect(wrapRt.state.wrapUpRequested).toBe(true);

    const killDeps = createDeps(ok({ ...baseConfig, mode: "kill" }));
    const killRt = runtime();
    await maybeKill(killDeps, killRt, usage(1_000, 85), "immediate");
    expect(killDeps.sendUserMessage).not.toHaveBeenCalled();
    expect(killRt.state.killed).toBe(true);
  });

  it("auto-off re-arms when the kill threshold drops below the limit", async () => {
    const deps = createDeps();
    const rt = runtime(
      createState({ sessionEnabled: false, autoDisabled: true }),
    );
    await maybeKill(deps, rt, usage(1_000, 50), "immediate");
    expect(rt.state.sessionEnabled).toBe(true);
    expect(rt.state.autoDisabled).toBe(false);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("forceWrapUpNow", () => {
  it("requests wrap-up manually", async () => {
    const deps = createDeps();
    const rt = runtime();
    await forceWrapUpNow(deps, rt, "immediate");
    expect(rt.state.killed).toBe(false);
    expect(rt.state.wrapUpRequested).toBe(true);
    expect(deps.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("uses steer delivery when requested", async () => {
    const deps = createDeps();
    const rt = runtime();
    await forceWrapUpNow(deps, rt, "steer");
    expect(deps.sendUserMessage).toHaveBeenCalledWith(
      baseConfig.wrapUpMessage,
      { deliverAs: "steer" },
    );
  });
});

describe("disarmKilledSessionBeforeNextRun", () => {
  it("switches killed to auto-off before the next prompt", () => {
    const deps = createDeps();
    const rt = runtime(createState({ killed: true }));

    expect(disarmKilledSessionBeforeNextRun(deps, rt, baseConfig)).toBe(true);
    expect(rt.state).toEqual(
      expect.objectContaining({
        sessionEnabled: false,
        autoDisabled: true,
        killed: false,
        wrapUpRequested: false,
      }),
    );
  });
});

describe("restoreStateFromEntries", () => {
  it("restores latest valid state", () => {
    const restored = restoreStateFromEntries(
      [
        {
          type: "custom",
          customType: "killswitch-state",
          data: { version: 1, killed: false },
        },
        {
          type: "custom",
          customType: "killswitch-state",
          data: {
            version: 1,
            killed: true,
            wrapUpRequested: true,
            autoDisabled: true,
          },
        },
      ],
      "session-1",
    );
    expect(restored).toEqual({
      sessionId: "session-1",
      sessionEnabled: false,
      autoDisabled: true,
      killed: true,
      wrapUpRequested: true,
      lastError: undefined,
    });
  });

  it("ignores invalid and future-version custom entries", () => {
    const restored = restoreStateFromEntries(
      [
        { type: "custom", customType: "other", data: { killed: true } },
        {
          type: "custom",
          customType: "killswitch-state",
          data: { version: 99, killed: true },
        },
      ],
      "session-1",
    );
    expect(restored).toBeUndefined();
  });
});
