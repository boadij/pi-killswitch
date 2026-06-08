import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  activeThreshold,
  createInitialState,
  disarmKilledSessionBeforeNextRun,
  forceWrapUpNow,
  formatCompactNumber,
  maybeKill,
  restoreStateFromEntries,
  statusText,
  type KillswitchConfig,
  type KillswitchMode,
  type KillswitchState,
  type Threshold,
} from "./killswitch-core";
import {
  formatThreshold,
  readConfig as readConfigFile,
  thresholdIsSet,
  validateConfig,
  writeConfig as writeConfigFile,
} from "./killswitch-config";

const CONFIG_PATH = join(getAgentDir(), "killswitch.json");
const CUSTOM_TYPE = "killswitch-state";

type StateEntry = Partial<KillswitchState> & { version?: number };
type Runtime = { state: KillswitchState };
type ConfigField =
  | "enabled"
  | "mode"
  | "autoDisarmAfterKill"
  | "autoRearmWhenSafe"
  | "wrapUpThreshold"
  | "killThreshold"
  | "wrapUpMessage";

type MenuItem = { field: ConfigField; label: string };
type ThresholdEditResult =
  | { action: "cancel" }
  | { action: "unset" }
  | { action: "set"; threshold: Threshold };

type ConfigFieldEditor = (
  ctx: ExtensionCommandContext,
  config: KillswitchConfig,
) => Promise<KillswitchConfig | undefined>;

let runtime: Runtime = { state: createInitialState() };

function readPackageVersion(): string {
  try {
    const raw = readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

const VERSION = readPackageVersion();

function readConfig() {
  return readConfigFile(CONFIG_PATH);
}

function writeConfig(config: KillswitchConfig): Promise<void> {
  return writeConfigFile(CONFIG_PATH, config);
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function updateStatus(ctx: ExtensionContext, config?: KillswitchConfig): void {
  ctx.ui.setStatus(
    "killswitch",
    statusText(config, runtime.state, ctx.getContextUsage()),
  );
}

function saveState(pi: ExtensionAPI, patch?: Partial<KillswitchState>): void {
  if (patch) runtime.state = { ...runtime.state, ...patch };
  pi.appendEntry<StateEntry>(CUSTOM_TYPE, { version: 1, ...runtime.state });
}

function restoreState(ctx: ExtensionContext): boolean {
  const restored = restoreStateFromEntries(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getSessionId(),
  );
  if (!restored) return false;
  runtime.state = restored;
  return true;
}

function coreDeps(pi: ExtensionAPI, ctx: ExtensionContext) {
  return {
    readConfig,
    saveState: (next: KillswitchState) => {
      runtime.state = next;
      saveState(pi);
    },
    sendUserMessage: (
      prompt: string,
      options?: { deliverAs: "steer" | "followUp" },
    ) => pi.sendUserMessage(prompt, options),
    updateStatus: (config?: KillswitchConfig) => updateStatus(ctx, config),
    notify: (message: string, level?: string) =>
      ctx.ui.notify(message, level as any),
    killRun: () => ctx.abort(),
  };
}

async function promptNumber(
  ctx: ExtensionCommandContext,
  title: string,
  placeholder: string,
): Promise<number | undefined> {
  const raw = await ctx.ui.input(title, placeholder);
  if (!raw?.trim()) return undefined;
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function selectBoolean(
  ctx: ExtensionCommandContext,
  title: string,
  current: boolean,
): Promise<boolean | undefined> {
  const options = current ? ["yes", "no"] : ["no", "yes"];
  const selected = await ctx.ui.select(
    `${title} (current: ${yesNo(current)})`,
    options,
  );
  return selected ? selected === "yes" : undefined;
}

async function editThreshold(
  ctx: ExtensionCommandContext,
  title: string,
  previous: Threshold | undefined,
  allowUnset: boolean,
): Promise<ThresholdEditResult> {
  const currentMetric = previous?.metric ?? "unset";
  const metrics = allowUnset
    ? ["unset", "tokens", "percent"]
    : ["tokens", "percent"];
  const selected = await ctx.ui.select(
    `${title} (current: ${formatThreshold(previous)})`,
    [currentMetric, ...metrics.filter((metric) => metric !== currentMetric)],
  );
  if (!selected) return { action: "cancel" };
  if (selected === "unset") return { action: "unset" };

  const value = await promptNumber(
    ctx,
    selected === "tokens" ? "Token threshold" : "Percent threshold",
    previous?.metric === selected
      ? previous.value.toString()
      : selected === "tokens"
        ? "100000"
        : "85",
  );
  if (!value) return { action: "cancel" };
  if (selected === "percent" && value > 100) {
    ctx.ui.notify(
      "Percent threshold must be positive and 100 or less",
      "error",
    );
    return { action: "cancel" };
  }
  return {
    action: "set",
    threshold: { metric: selected as "tokens" | "percent", value },
  };
}

function configMenuItems(config: KillswitchConfig): MenuItem[] {
  return [
    { field: "enabled", label: `enabled: ${yesNo(config.enabled)}` },
    { field: "mode", label: `mode: ${config.mode}` },
    {
      field: "autoDisarmAfterKill",
      label: `auto-disarm after kill: ${yesNo(config.autoDisarmAfterKill)}`,
    },
    {
      field: "autoRearmWhenSafe",
      label: `auto-rearm when safe: ${yesNo(config.autoRearmWhenSafe)}`,
    },
    {
      field: "wrapUpThreshold",
      label: `wrap-up threshold: ${formatThreshold(config.wrapUpThreshold)}`,
    },
    {
      field: "killThreshold",
      label: `kill threshold: ${formatThreshold(config.killThreshold)}`,
    },
    {
      field: "wrapUpMessage",
      label: `wrap-up message: ${config.wrapUpMessage}`,
    },
  ];
}

async function configure(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) return;
  const result = await readConfig();
  let config = result.ok ? result.config : result.fallback;
  if (!result.ok)
    ctx.ui.notify(
      `killswitch config error: ${result.error}. Editing safe defaults.`,
      "error",
    );

  while (true) {
    const items = configMenuItems(config);
    const selected = await ctx.ui.select(
      `✕ Killswitch v${VERSION}`,
      items.map((item) => item.label),
    );
    if (!selected) return;
    const field = items.find((item) => item.label === selected)?.field;
    if (!field) return;
    const next = await editConfigField(ctx, config, field);
    if (!next) continue;
    const error = validateConfig(next);
    if (error) {
      ctx.ui.notify(`Invalid killswitch config: ${error}`, "error");
      continue;
    }
    config = next;
    await writeConfig(config);
    ctx.ui.notify("killswitch config saved", "info");
  }
}

const CONFIG_FIELD_EDITORS: Record<ConfigField, ConfigFieldEditor> = {
  enabled: (ctx, config) => editBooleanConfigField(ctx, config, "enabled"),
  mode: editModeConfigField,
  autoDisarmAfterKill: (ctx, config) =>
    editBooleanConfigField(ctx, config, "autoDisarmAfterKill"),
  autoRearmWhenSafe: (ctx, config) =>
    editBooleanConfigField(ctx, config, "autoRearmWhenSafe"),
  wrapUpThreshold: editWrapUpThresholdConfigField,
  killThreshold: editKillThresholdConfigField,
  wrapUpMessage: editWrapUpMessageConfigField,
};

async function editConfigField(
  ctx: ExtensionCommandContext,
  config: KillswitchConfig,
  field: ConfigField,
): Promise<KillswitchConfig | undefined> {
  return CONFIG_FIELD_EDITORS[field](ctx, config);
}

async function editBooleanConfigField(
  ctx: ExtensionCommandContext,
  config: KillswitchConfig,
  field: "enabled" | "autoDisarmAfterKill" | "autoRearmWhenSafe",
): Promise<KillswitchConfig | undefined> {
  const value = await selectBoolean(
    ctx,
    labelForBooleanField(field),
    config[field],
  );
  return value === undefined ? undefined : { ...config, [field]: value };
}

function labelForBooleanField(
  field: "enabled" | "autoDisarmAfterKill" | "autoRearmWhenSafe",
): string {
  return field === "enabled"
    ? "Enabled"
    : field === "autoDisarmAfterKill"
      ? "Auto-disarm after kill"
      : "Auto-rearm when safe";
}

async function editModeConfigField(
  ctx: ExtensionCommandContext,
  config: KillswitchConfig,
): Promise<KillswitchConfig | undefined> {
  const selected = await ctx.ui.select(`Mode (current: ${config.mode})`, [
    config.mode,
    ...["kill", "wrap-up", "wrap-up-then-kill"].filter(
      (mode) => mode !== config.mode,
    ),
  ]);
  return selected ? { ...config, mode: selected as KillswitchMode } : undefined;
}

async function editWrapUpThresholdConfigField(
  ctx: ExtensionCommandContext,
  config: KillswitchConfig,
): Promise<KillswitchConfig | undefined> {
  const result = await editThreshold(
    ctx,
    "Wrap-up threshold",
    config.wrapUpThreshold,
    config.mode === "kill",
  );
  if (result.action === "cancel") return undefined;
  return {
    ...config,
    wrapUpThreshold: result.action === "unset" ? undefined : result.threshold,
  };
}

async function editKillThresholdConfigField(
  ctx: ExtensionCommandContext,
  config: KillswitchConfig,
): Promise<KillswitchConfig | undefined> {
  const result = await editThreshold(
    ctx,
    "Kill threshold",
    config.killThreshold,
    false,
  );
  return result.action === "set" && thresholdIsSet(result.threshold)
    ? { ...config, killThreshold: result.threshold }
    : undefined;
}

async function editWrapUpMessageConfigField(
  ctx: ExtensionCommandContext,
  config: KillswitchConfig,
): Promise<KillswitchConfig | undefined> {
  const value = await ctx.ui.input("Wrap-up message", config.wrapUpMessage);
  return value?.trim() ? { ...config, wrapUpMessage: value.trim() } : undefined;
}

function formatUsage(usage: ContextUsage | undefined): string {
  if (!usage) return "unknown";
  const tokens =
    usage.tokens === null ? "unknown" : usage.tokens.toLocaleString("en-US");
  const percent =
    usage.percent === null ? "unknown" : `${Math.round(usage.percent)}%`;
  return `${tokens} tokens (${percent})`;
}

function formatRemaining(
  usage: ContextUsage | undefined,
  threshold: Threshold | undefined,
): string {
  if (!usage || !threshold) return "unknown";
  const value = usage[threshold.metric];
  if (value === null) return `?/${formatThreshold(threshold)}`;
  const remaining = Math.max(0, threshold.value - value);
  return threshold.metric === "percent"
    ? `${Math.round(remaining)}% left`
    : `${formatCompactNumber(remaining)} left`;
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
  const result = await readConfig();
  const config = result.ok ? result.config : result.fallback;
  const state = runtime.state;
  const usage = ctx.getContextUsage();
  const lines = [
    `status: ${statusText(config, state, usage)}`,
    `config source: ${result.ok ? result.source : "safe fallback"}`,
    `usage: ${formatUsage(usage)}`,
    `active threshold: ${formatThreshold(activeThreshold(config))}`,
    `remaining active: ${formatRemaining(usage, activeThreshold(config))}`,
    `kill threshold: ${formatThreshold(config.killThreshold)}`,
    `wrap-up threshold: ${formatThreshold(config.wrapUpThreshold)}`,
    `configured mode: ${config.mode}`,
    `session enabled: ${yesNo(state.sessionEnabled)}`,
    `auto disabled: ${yesNo(state.autoDisabled)}`,
    `killed: ${yesNo(state.killed)}`,
    `wrap-up requested: ${yesNo(state.wrapUpRequested)}`,
    `auto-disarm after kill: ${yesNo(config.autoDisarmAfterKill)}`,
    `auto-rearm when safe: ${yesNo(config.autoRearmWhenSafe)}`,
    `config: ${CONFIG_PATH}`,
    `version: ${VERSION}`,
    `commands: /killswitch status | wrap | on | off | help | /wrap-up`,
  ];
  if (!result.ok) lines.push(`config error: ${result.error}`);
  if (state.lastError) lines.push(`last error: ${state.lastError}`);
  ctx.ui.notify(lines.join("\n"), "info");
}

function usageText(): string {
  return [
    `Killswitch v${VERSION}`,
    "",
    "/killswitch - configure Killswitch",
    "/killswitch status - show current usage, config, and version",
    "/killswitch wrap - request a wrap-up immediately",
    "/wrap-up - shortcut for requesting a wrap-up immediately",
    "/killswitch on - enable Killswitch for this session",
    "/killswitch off - disable Killswitch for this session",
    "/killswitch help - show this help",
  ].join("\n");
}

async function runKillswitchCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: string,
): Promise<void> {
  const actions: Record<string, () => Promise<void> | void> = {
    status: () => showStatus(ctx),
    help: () => ctx.ui.notify(usageText(), "info"),
    wrap: () => wrapUpNow(pi, ctx),
    off: () => disableSession(pi, ctx),
    on: () => enableSession(pi, ctx),
    config: () => configure(ctx),
  };
  const action = actions[command];
  if (action) return action();
  ctx.ui.notify(usageText(), "warning");
}

async function wrapUpNow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await forceWrapUpNow(
    coreDeps(pi, ctx),
    runtime,
    ctx.isIdle() ? "immediate" : "steer",
  );
  const result = await readConfig();
  updateStatus(ctx, result.ok ? result.config : result.fallback);
}

async function disableSession(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  saveState(pi, {
    sessionEnabled: false,
    autoDisabled: false,
    killed: false,
    wrapUpRequested: false,
    lastError: undefined,
  });
  const result = await readConfig();
  updateStatus(ctx, result.ok ? result.config : result.fallback);
  ctx.ui.notify("killswitch off for this session", "info");
}

async function enableSession(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  saveState(pi, {
    sessionEnabled: true,
    autoDisabled: false,
    killed: false,
    wrapUpRequested: false,
    lastError: undefined,
  });
  await maybeKill(
    coreDeps(pi, ctx),
    runtime,
    ctx,
    ctx.isIdle() ? "immediate" : "steer",
  );
  const result = await readConfig();
  updateStatus(ctx, result.ok ? result.config : result.fallback);
  ctx.ui.notify("killswitch on for this session", "info");
}

function registerWrapUpCommand(pi: ExtensionAPI): void {
  pi.registerCommand("wrap-up", {
    description: "Request a wrap-up immediately",
    handler: async (_args, ctx) => {
      await wrapUpNow(pi, ctx);
    },
  });
}

async function handleBeforeAgentStart(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const result = await readConfig();
  const config = result.ok ? result.config : result.fallback;
  if (disarmKilledSessionBeforeNextRun(coreDeps(pi, ctx), runtime, config)) {
    updateStatus(ctx, config);
  }
}

async function handleSessionStart(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const hadState = restoreState(ctx);
  if (!hadState) {
    runtime.state = {
      ...createInitialState(),
      sessionId: ctx.sessionManager.getSessionId(),
    };
    saveState(pi);
  }
  const result = await readConfig();
  updateStatus(ctx, result.ok ? result.config : result.fallback);
}

export default function killswitch(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    await handleSessionStart(pi, ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    await handleBeforeAgentStart(pi, ctx);
  });

  pi.on("context", async (_event, ctx) => {
    await maybeKill(
      coreDeps(pi, ctx),
      runtime,
      ctx,
      ctx.isIdle() ? "immediate" : "steer",
    );
  });

  pi.registerCommand("killswitch", {
    description: "Wrap up runs by threshold or command",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (!command) return configure(ctx);
      await runKillswitchCommand(pi, ctx, command);
    },
  });

  registerWrapUpCommand(pi);
}
