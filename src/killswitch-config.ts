import { readFile, writeFile } from "node:fs/promises";
import {
  DEFAULT_CONFIG,
  type ConfigResult,
  type KillswitchConfig,
  type KillswitchMode,
  type Threshold,
} from "./killswitch-core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function parseThreshold(value: unknown): Threshold | undefined {
  if (!isRecord(value)) return undefined;

  if (value.metric === "percent") {
    const percent = positiveNumber(value.value);
    return percent !== undefined && percent <= 100
      ? { metric: "percent", value: percent }
      : undefined;
  }

  if (value.metric === "tokens") {
    const tokens = positiveNumber(value.value);
    return tokens !== undefined
      ? { metric: "tokens", value: tokens }
      : undefined;
  }

  return undefined;
}

function parseMode(value: unknown): KillswitchMode {
  return value === "kill" ||
    value === "wrap-up" ||
    value === "wrap-up-then-kill"
    ? value
    : DEFAULT_CONFIG.mode;
}

function configFromRecord(raw: Record<string, unknown>): KillswitchConfig {
  return {
    enabled: raw.enabled !== false,
    mode: parseMode(raw.mode),
    killThreshold:
      parseThreshold(raw.killThreshold) ?? DEFAULT_CONFIG.killThreshold,
    wrapUpThreshold: parseThreshold(raw.wrapUpThreshold),
    wrapUpMessage:
      typeof raw.wrapUpMessage === "string" && raw.wrapUpMessage.trim()
        ? raw.wrapUpMessage.trim()
        : DEFAULT_CONFIG.wrapUpMessage,
    autoDisarmAfterKill: raw.autoDisarmAfterKill !== false,
    autoRearmWhenSafe: raw.autoRearmWhenSafe !== false,
  };
}

function thresholdParseError(
  raw: Record<string, unknown>,
  field: "killThreshold" | "wrapUpThreshold",
): string | undefined {
  return field in raw && parseThreshold(raw[field]) === undefined
    ? `${field} is invalid`
    : undefined;
}

export function validateConfig(config: KillswitchConfig): string | undefined {
  if (!config.killThreshold) return "killThreshold is required";
  if (config.mode !== "kill" && !config.wrapUpThreshold) {
    return "wrapUpThreshold is required unless mode is kill";
  }
  if (
    config.wrapUpThreshold &&
    config.wrapUpThreshold.metric !== config.killThreshold.metric
  ) {
    return "wrapUpThreshold and killThreshold must use the same metric";
  }
  if (
    config.wrapUpThreshold &&
    config.wrapUpThreshold.value >= config.killThreshold.value
  ) {
    return "wrapUpThreshold must be lower than killThreshold";
  }
  return undefined;
}

export function parseConfig(raw: unknown): ConfigResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: "config must be a JSON object",
      fallback: DEFAULT_CONFIG,
    };
  }

  const parseError =
    thresholdParseError(raw, "killThreshold") ??
    thresholdParseError(raw, "wrapUpThreshold");
  if (parseError)
    return { ok: false, error: parseError, fallback: DEFAULT_CONFIG };

  const config = configFromRecord(raw);
  const error = validateConfig(config);
  return error
    ? { ok: false, error, fallback: DEFAULT_CONFIG }
    : { ok: true, config, source: "file" };
}

export async function readConfig(path: string): Promise<ConfigResult> {
  try {
    const raw = await readFile(path, "utf8");
    return parseConfig(JSON.parse(raw));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { ok: true, config: DEFAULT_CONFIG, source: "default" };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      fallback: DEFAULT_CONFIG,
    };
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function writeConfig(
  path: string,
  config: KillswitchConfig,
): Promise<void> {
  const error = validateConfig(config);
  if (error) throw new Error(error);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function formatThreshold(threshold: Threshold | undefined): string {
  if (!threshold) return "unset";
  return threshold.metric === "percent"
    ? `${threshold.value}%`
    : `${threshold.value.toLocaleString("en-US")} tokens`;
}

export function thresholdIsSet(
  threshold: Threshold | undefined,
): threshold is Threshold {
  return threshold !== undefined;
}
