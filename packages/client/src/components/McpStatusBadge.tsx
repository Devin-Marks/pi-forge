import { useMcpStore } from "../store/mcp-store";
import { useUiStore } from "../store/ui-store";

/**
 * Compact MCP connection-status indicator for the App header. Reads
 * `settings` from `mcp-store` (single 30s ticker shared with the
 * Settings tab — see store doc-comment). Renders nothing when MCP is
 * enabled but no servers are configured, so deployments that don't
 * use MCP get a clean header.
 *
 * Click opens Settings → MCP via the same ui-store request the
 * `/mcp` slash command uses, so the badge doubles as a one-click
 * jump to the configuration surface.
 *
 * Color rules:
 *   - emerald: every configured server is connected
 *   - amber:   some connected, some not
 *   - red:     none connected (and at least one configured)
 *   - neutral: master kill-switch off
 */
export function McpStatusBadge() {
  const data = useMcpStore((s) => s.settings);
  const openSettings = useUiStore((s) => s.openSettings);
  if (data === undefined) return null;
  if (data.total === 0 && data.enabled) return null;

  const { enabled, connected, total } = data;
  const dotClass = !enabled
    ? "bg-neutral-600"
    : connected === total
      ? "bg-emerald-500"
      : connected === 0
        ? "bg-red-500"
        : "bg-amber-400";

  const label = !enabled ? "MCP off" : `MCP ${connected}/${total}`;
  const title = !enabled
    ? "MCP tools disabled. Click to open Settings → MCP."
    : `${connected} of ${total} MCP server(s) connected. Click to open Settings → MCP.`;

  return (
    <button
      type="button"
      onClick={() => openSettings("mcp")}
      className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
      title={title}
    >
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      {label}
    </button>
  );
}
