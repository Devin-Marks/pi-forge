import { useState } from "react";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import type { CompactionEvent } from "../store/session-store";

/**
 * Inline marker card rendered between chat messages at every point
 * where pi compacted the context. Collapsed default — shows a single
 * line with the SDK's first-line summary, the pre-compaction token
 * count, and a timestamp. Click to expand the archived messages,
 * which render through the host component's Message renderer (passed
 * as `renderArchived` so this file doesn't have to import the chat
 * renderer and create a cycle).
 *
 * Visual posture: distinct from a normal message bubble — narrower,
 * dashed border, neutral-amber accent — so it's obviously a meta
 * event, not part of the conversation.
 */
export function CompactionCard({
  event,
  renderArchived,
}: {
  event: CompactionEvent;
  /** Renders the archived messages slice with the chat's normal
   *  Message component. Passed in to avoid a circular import. */
  renderArchived: () => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const summaryFirstLine = event.summary.split("\n")[0]?.trim() ?? "";
  const truncated =
    summaryFirstLine.length > 160 ? summaryFirstLine.slice(0, 157) + "…" : summaryFirstLine;
  const when = new Date(event.timestamp);
  const timeLabel = `${when.toLocaleDateString()} ${when.toLocaleTimeString()}`;
  const archivedCount = event.archivedMessages.length;
  return (
    <div className="my-2 rounded-md border border-dashed border-amber-700/50 bg-amber-900/10 light:border-amber-300 light:bg-amber-50">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-amber-200/90 hover:bg-amber-900/20 light:text-amber-800 light:hover:bg-amber-100"
        title={
          open
            ? "Hide archived messages"
            : `Expand ${archivedCount} archived message${archivedCount === 1 ? "" : "s"}`
        }
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Layers size={12} className="text-amber-400 light:text-amber-700" />
        <span className="flex-1 truncate">{truncated.length > 0 ? truncated : "Compaction"}</span>
        <span className="shrink-0 font-mono text-[10px] text-amber-300/70 light:text-amber-700/80">
          {archivedCount} msg · {event.tokensBefore.toLocaleString()} tok · {timeLabel}
        </span>
      </button>
      {open && (
        <div className="border-t border-dashed border-amber-700/50 px-3 py-3 light:border-amber-300">
          {/* Full summary above the archived stream so the user can read
              the SDK-generated prose before drilling into the raw
              messages it summarised. */}
          {event.summary.length > 0 && (
            <div className="mb-3 whitespace-pre-wrap rounded bg-amber-900/15 px-2 py-1 text-[11px] italic text-amber-100/80 light:bg-amber-100 light:text-amber-800">
              {event.summary}
            </div>
          )}
          <div className="space-y-3 opacity-80">{renderArchived()}</div>
        </div>
      )}
    </div>
  );
}
