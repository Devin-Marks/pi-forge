/**
 * Runtime config for the orchestration feature.
 *
 * Instance-level kill switch + tunable limits. Read fresh on every
 * call (no caching) so changing env requires only a process restart,
 * not a code edit. Defaults are safe — orchestration is OFF by
 * default; the operator opts in with `ORCHESTRATION_ENABLED=true`.
 *
 * MINIMAL_UI is a HARD gate (checked separately in routes + tool
 * registration): even with `ORCHESTRATION_ENABLED=true`, a deployment
 * running under MINIMAL_UI never surfaces orchestration. Same posture
 * as the webhooks mutation gate, applied to BOTH routes AND the
 * agent-facing tool surface.
 */
import { config } from "../config.js";
import { DEFAULT_MAX_WORKERS_PER_SUPERVISOR } from "./types.js";

function readBoolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const v = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function readIntEnv(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * True when orchestration tools may surface AND the REST routes may
 * accept mutations. Combines the instance-level env flag with the
 * MINIMAL_UI hard gate — under MINIMAL_UI, orchestration is OFF
 * regardless of the env flag.
 */
export function isOrchestrationEnabled(): boolean {
  if (config.minimalUi) return false;
  return readBoolEnv("ORCHESTRATION_ENABLED", false);
}

/**
 * Reason string for the disabled state — surfaced in 403 responses
 * so the operator/user gets a precise diagnostic instead of a
 * generic "disabled."
 */
export function orchestrationDisabledReason(): "minimal_ui_disabled" | "orchestration_disabled" {
  if (config.minimalUi) return "minimal_ui_disabled";
  return "orchestration_disabled";
}

export function maxWorkersPerSupervisor(): number {
  return readIntEnv(
    "ORCHESTRATION_MAX_WORKERS_PER_SUPERVISOR",
    DEFAULT_MAX_WORKERS_PER_SUPERVISOR,
    1,
    100,
  );
}
