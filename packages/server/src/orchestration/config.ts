/**
 * Runtime config for the orchestration feature.
 *
 * Enabled by default with an instance-level disable switch + tunable
 * limits. MINIMAL_UI is a HARD gate (checked separately in routes +
 * tool registration): a deployment running under MINIMAL_UI never
 * surfaces orchestration. Same posture as the webhooks mutation gate,
 * applied to BOTH routes AND the agent-facing tool surface.
 */
import { config } from "../config.js";

/**
 * True when orchestration tools may surface AND the REST routes may
 * accept mutations. Combines the instance-level feature config with
 * the MINIMAL_UI hard gate — under MINIMAL_UI, orchestration is OFF
 * regardless of the disable switch.
 */
export function isOrchestrationEnabled(): boolean {
  if (config.minimalUi) return false;
  return config.orchestrationEnabled;
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
  return config.orchestrationMaxWorkersPerSupervisor;
}
