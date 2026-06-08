export type Threshold =
  | { metric: "percent"; value: number }
  | { metric: "tokens"; value: number };

export type ContextUsageLike = {
  tokens: number | null;
  percent: number | null;
};

export type KillswitchMode = "kill" | "wrap-up" | "wrap-up-then-kill";

export type KillswitchConfig = {
  enabled: boolean;
  mode: KillswitchMode;
  killThreshold: Threshold;
  wrapUpThreshold?: Threshold;
  wrapUpMessage: string;
  autoDisarmAfterKill: boolean;
  autoRearmWhenSafe: boolean;
};

export type ConfigResult =
  | { ok: true; config: KillswitchConfig; source: "file" | "default" }
  | { ok: false; error: string; fallback: KillswitchConfig };

export type KillswitchState = {
  sessionId?: string;
  sessionEnabled: boolean;
  autoDisabled: boolean;
  killed: boolean;
  wrapUpRequested: boolean;
  lastError?: string;
};

export type Runtime = { state: KillswitchState };
export type SoftStopDelivery = "immediate" | "steer";
export type UserMessageDelivery = "steer" | "followUp";

export type CoreDeps = {
  readConfig: () => Promise<ConfigResult>;
  saveState: (state: KillswitchState) => void;
  sendUserMessage: (
    prompt: string,
    options?: { deliverAs: UserMessageDelivery },
  ) => void | Promise<void>;
  updateStatus: (config?: KillswitchConfig) => void;
  notify: (message: string, level?: string) => void;
  killRun: () => void | Promise<void>;
};

export type UsageContext = {
  getContextUsage: () => ContextUsageLike | undefined;
};

type StateEntry = Partial<KillswitchState> & { version?: number };

type PersistedStateEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

export const DEFAULT_CONFIG: KillswitchConfig = {
  enabled: true,
  mode: "wrap-up-then-kill",
  wrapUpThreshold: { metric: "percent", value: 75 },
  killThreshold: { metric: "percent", value: 85 },
  wrapUpMessage:
    "Context budget reached. Finish gracefully, summarize current state, do not call more tools, and stop.",
  autoDisarmAfterKill: true,
  autoRearmWhenSafe: true,
};

export function createInitialState(): KillswitchState {
  return {
    sessionEnabled: true,
    autoDisabled: false,
    killed: false,
    wrapUpRequested: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function restoreStateFromEntries(
  entries: PersistedStateEntry[],
  sessionId: string,
): KillswitchState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const data = parseStateEntry(entries[index]);
    if (data) return restoredState(data, sessionId);
  }
  return undefined;
}

function parseStateEntry(entry: PersistedStateEntry): StateEntry | undefined {
  if (
    entry.type !== "custom" ||
    entry.customType !== "killswitch-state" ||
    !isRecord(entry.data)
  ) {
    return undefined;
  }
  const data = entry.data as StateEntry;
  return data.version === undefined || data.version === 1 ? data : undefined;
}

function restoredState(data: StateEntry, sessionId: string): KillswitchState {
  const autoDisabled = data.autoDisabled === true;
  return {
    sessionId: typeof data.sessionId === "string" ? data.sessionId : sessionId,
    sessionEnabled: autoDisabled ? false : data.sessionEnabled !== false,
    autoDisabled,
    killed: data.killed === true,
    wrapUpRequested: data.wrapUpRequested === true,
    lastError: typeof data.lastError === "string" ? data.lastError : undefined,
  };
}

export function thresholdReached(
  usage: ContextUsageLike | undefined,
  threshold: Threshold,
): boolean {
  if (!usage) return false;
  const value = usage[threshold.metric];
  return value !== null && value >= threshold.value;
}

function thresholdBelow(
  usage: ContextUsageLike | undefined,
  threshold: Threshold | undefined,
): boolean {
  if (!usage || !threshold) return false;
  const value = usage[threshold.metric];
  return value !== null && value < threshold.value;
}

export function activeThreshold(
  config: KillswitchConfig,
): Threshold | undefined {
  return config.mode === "kill" ? config.killThreshold : config.wrapUpThreshold;
}

function nextStatusEvent(
  config: KillswitchConfig,
  state: KillswitchState,
): { label: "wrap" | "kill"; threshold: Threshold | undefined } {
  if (config.mode === "kill") {
    return { label: "kill", threshold: config.killThreshold };
  }
  if (config.mode === "wrap-up") {
    return { label: "wrap", threshold: config.wrapUpThreshold };
  }
  if (state.wrapUpRequested) {
    return { label: "kill", threshold: config.killThreshold };
  }
  return { label: "wrap", threshold: config.wrapUpThreshold };
}

export function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
  if (absolute >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

function remainingText(
  usage: ContextUsageLike | undefined,
  threshold: Threshold | undefined,
): string | undefined {
  if (!usage || !threshold) return undefined;
  const value = usage[threshold.metric];
  if (value === null) return undefined;
  const remaining = Math.max(0, threshold.value - value);
  return threshold.metric === "percent"
    ? `${Math.round(remaining)}%`
    : formatCompactNumber(remaining);
}

export function statusText(
  config: KillswitchConfig | undefined,
  state: KillswitchState,
  usage: ContextUsageLike | undefined,
): string {
  if (!config?.enabled) return "✕ off";
  if (state.killed) return "✕ killed";
  if (!state.sessionEnabled && state.autoDisabled) return "✕ paused";
  if (!state.sessionEnabled) return "✕ off";

  const event = nextStatusEvent(config, state);
  const remaining = remainingText(usage, event.threshold);
  return remaining ? `✕ ${event.label} ${remaining}` : "✕ ?";
}

function syncStateWithUsage(
  deps: CoreDeps,
  runtime: Runtime,
  config: KillswitchConfig,
  usage: ContextUsageLike | undefined,
): void {
  if (runtime.state.killed) return;

  const patch: Partial<KillswitchState> = {};

  if (
    runtime.state.autoDisabled &&
    config.autoRearmWhenSafe &&
    thresholdBelow(usage, config.killThreshold)
  ) {
    patch.sessionEnabled = true;
    patch.autoDisabled = false;
    patch.lastError = undefined;
  }

  if (
    runtime.state.wrapUpRequested &&
    config.autoRearmWhenSafe &&
    thresholdBelow(usage, config.wrapUpThreshold)
  ) {
    patch.wrapUpRequested = false;
    patch.lastError = undefined;
  }

  if (Object.keys(patch).length === 0) return;

  setState(deps, runtime, patch);
  deps.updateStatus(config);
}

function setState(
  deps: CoreDeps,
  runtime: Runtime,
  patch: Partial<KillswitchState>,
): void {
  runtime.state = { ...runtime.state, ...patch };
  deps.saveState(runtime.state);
}

async function sendSoftStop(
  deps: CoreDeps,
  config: KillswitchConfig,
  delivery: SoftStopDelivery,
): Promise<void> {
  if (delivery === "immediate")
    await deps.sendUserMessage(config.wrapUpMessage);
  else await deps.sendUserMessage(config.wrapUpMessage, { deliverAs: "steer" });
}

function modeAllowsWrapUp(config: KillswitchConfig): boolean {
  return config.mode === "wrap-up" || config.mode === "wrap-up-then-kill";
}

function modeAllowsKill(config: KillswitchConfig): boolean {
  return config.mode === "kill" || config.mode === "wrap-up-then-kill";
}

async function requestWrapUp(
  deps: CoreDeps,
  runtime: Runtime,
  config: KillswitchConfig,
  delivery: SoftStopDelivery,
): Promise<void> {
  try {
    await sendSoftStop(deps, config, delivery);
    setState(deps, runtime, { wrapUpRequested: true, lastError: undefined });
    deps.updateStatus(config);
    deps.notify("killswitch: wrap-up requested", "warning");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState(deps, runtime, { wrapUpRequested: false, lastError: message });
    deps.updateStatus(config);
    deps.notify(`killswitch: wrap-up failed: ${message}`, "error");
  }
}

async function killNow(
  deps: CoreDeps,
  runtime: Runtime,
  config: KillswitchConfig,
  reason: string,
): Promise<KillswitchState> {
  if (runtime.state.killed) return runtime.state;
  setState(deps, runtime, {
    sessionEnabled: true,
    autoDisabled: false,
    killed: true,
    wrapUpRequested: false,
    lastError: undefined,
  });
  deps.updateStatus(config);
  deps.notify(reason, "error");
  try {
    await deps.killRun();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState(deps, runtime, { lastError: message });
    deps.updateStatus(config);
    deps.notify(`killswitch: kill failed: ${message}`, "error");
    throw error;
  }
  return runtime.state;
}

export function disarmKilledSessionBeforeNextRun(
  deps: CoreDeps,
  runtime: Runtime,
  config: KillswitchConfig,
): boolean {
  if (!config.autoDisarmAfterKill || !runtime.state.killed) return false;
  setState(deps, runtime, {
    sessionEnabled: false,
    autoDisabled: true,
    killed: false,
    wrapUpRequested: false,
    lastError: undefined,
  });
  return true;
}

function notifyConfigErrorOnce(
  deps: CoreDeps,
  runtime: Runtime,
  error: string,
): void {
  if (runtime.state.lastError === error) return;
  setState(deps, runtime, { lastError: error });
  deps.notify(
    `killswitch config error: ${error}. Using safe defaults.`,
    "error",
  );
}

async function loadConfig(
  deps: CoreDeps,
  runtime: Runtime,
): Promise<KillswitchConfig> {
  const result = await deps.readConfig();
  if (result.ok) {
    if (runtime.state.lastError?.startsWith("config: ")) {
      setState(deps, runtime, { lastError: undefined });
    }
    return result.config;
  }
  notifyConfigErrorOnce(deps, runtime, `config: ${result.error}`);
  return result.fallback;
}

export async function maybeKill(
  deps: CoreDeps,
  runtime: Runtime,
  ctx: UsageContext,
  delivery: SoftStopDelivery,
): Promise<KillswitchState> {
  const config = await loadConfig(deps, runtime);
  deps.updateStatus(config);
  if (!config.enabled || runtime.state.killed) return runtime.state;

  const usage = ctx.getContextUsage();

  syncStateWithUsage(deps, runtime, config, usage);

  if (!runtime.state.sessionEnabled) return runtime.state;

  if (
    modeAllowsWrapUp(config) &&
    config.wrapUpThreshold &&
    !runtime.state.wrapUpRequested &&
    thresholdReached(usage, config.wrapUpThreshold)
  ) {
    await requestWrapUp(deps, runtime, config, delivery);
  }

  if (modeAllowsKill(config) && thresholdReached(usage, config.killThreshold)) {
    return killNow(
      deps,
      runtime,
      config,
      "killswitch killed: context threshold reached",
    );
  }

  return runtime.state;
}

export async function forceWrapUpNow(
  deps: CoreDeps,
  runtime: Runtime,
  delivery: SoftStopDelivery,
): Promise<KillswitchState> {
  const config = await loadConfig(deps, runtime);
  deps.updateStatus(config);
  if (runtime.state.wrapUpRequested) {
    deps.notify("killswitch: wrap-up already requested", "info");
    return runtime.state;
  }
  await requestWrapUp(deps, runtime, config, delivery);
  return runtime.state;
}
