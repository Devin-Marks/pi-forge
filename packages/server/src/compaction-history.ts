/**
 * Per-compaction archive derivation.
 *
 * Pi's SessionManager persists every entry to JSONL — including
 * `CompactionEntry` records that mark where the SDK summarised and
 * dropped older messages from the in-memory context. The chat UI
 * reads `session.messages` (the post-compaction view); without
 * something like this module the user's pre-compaction history
 * appears to vanish.
 *
 * This module reads the full entries array, walks each compaction,
 * and produces a `CompactionEvent[]` shape the client renders as
 * inline "Compacted N messages → Y tokens" cards with the archived
 * messages one click away.
 *
 * Shape contract:
 * - `id`            — the CompactionEntry's id (stable across reloads)
 * - `timestamp`     — when the compaction happened (ISO 8601)
 * - `summary`       — the SDK-generated prose summary
 * - `tokensBefore`  — context size at the moment of compaction
 * - `insertBeforeIndex` — index in the post-compaction `session.messages`
 *                          array where the card should render. The card
 *                          appears IMMEDIATELY ABOVE the message at
 *                          this index — i.e. between messages[i-1] and
 *                          messages[i]. When 0, the card renders at the
 *                          very top of the chat (the entire pre-
 *                          compaction history was archived).
 * - `archivedMessages` — the AgentMessage[] that the SDK removed from
 *                        the context. Rendered through the existing
 *                        Message component when the user expands the
 *                        card. Slice is from "the compaction immediately
 *                        before this one (or session start)" up to but
 *                        not including the new compaction.
 */
import type { AgentSession, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface CompactionEvent {
  id: string;
  timestamp: string;
  summary: string;
  tokensBefore: number;
  insertBeforeIndex: number;
  archivedMessages: AgentMessage[];
}

interface CompactionEntryShape {
  type: "compaction";
  id: string;
  timestamp: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

interface MessageEntryShape {
  type: "message";
  id: string;
  timestamp: string;
  message: AgentMessage;
}

function isCompactionEntry(e: SessionEntry): e is SessionEntry & CompactionEntryShape {
  return e.type === "compaction";
}

function isMessageEntry(e: SessionEntry): e is SessionEntry & MessageEntryShape {
  return e.type === "message";
}

/**
 * Walk `session.sessionManager.getEntries()` once and produce one
 * CompactionEvent per CompactionEntry. The mapping back to a position
 * in `session.messages` is the tricky part: the post-compaction
 * messages array is rebuilt from the entries that come AT or AFTER
 * the latest compaction's `firstKeptEntryId`, with the compaction
 * summary itself synthesised in. We compute `insertBeforeIndex` by
 * counting how many "kept" message entries appear in `messages`
 * before the position where this compaction's first-kept entry lands.
 */
export function buildCompactionHistory(session: AgentSession): CompactionEvent[] {
  const entries = session.sessionManager.getEntries();
  const compactions: (SessionEntry & CompactionEntryShape)[] = [];
  for (const e of entries) if (isCompactionEntry(e)) compactions.push(e);
  if (compactions.length === 0) return [];

  // Walk entries in order; for each compaction event, capture the
  // message entries between the previous compaction (or session start)
  // and this one. Those are the "archived" messages — the ones that
  // were summarised and dropped.
  const events: CompactionEvent[] = [];
  let archiveBuffer: AgentMessage[] = [];
  for (const entry of entries) {
    if (isMessageEntry(entry)) {
      archiveBuffer.push(entry.message);
      continue;
    }
    if (isCompactionEntry(entry)) {
      events.push({
        id: entry.id,
        timestamp: entry.timestamp,
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        // Filled in below — depends on the index of `firstKeptEntryId`
        // within the *kept* portion of the messages stream.
        insertBeforeIndex: 0,
        archivedMessages: archiveBuffer,
      });
      // Reset for the next archive window. Anything between this
      // compaction and the next one (or end of session) belongs to
      // the next event's archive — but only if there IS a next
      // compaction. If not, those messages live in `session.messages`
      // and don't need archiving.
      archiveBuffer = [];
    }
  }

  // Compute insertBeforeIndex for each event. Given a compaction whose
  // firstKeptEntryId points at message-entry M, the number of message
  // entries BEFORE M (within the post-this-compaction kept portion of
  // the entries array) tells us where to splice the card.
  //
  // For the LAST compaction, the kept portion lines up with what
  // session.messages actually contains, so we can count message
  // entries from `firstKeptEntryId` forward up to the compaction's
  // own position. Earlier compactions' kept portions were re-archived
  // by later compactions — those events sit at the TOP of the
  // (current) display, so insertBeforeIndex = 0 for all but the last.
  // (Once a compaction's kept window has itself been archived, no
  // post-compaction message in `session.messages` corresponds to it,
  // so the only sensible position is "before everything else".)
  for (let i = 0; i < events.length - 1; i++) {
    const ev = events[i];
    if (ev !== undefined) ev.insertBeforeIndex = 0;
  }
  const last = events[events.length - 1];
  if (last !== undefined) {
    const lastCompaction = compactions[compactions.length - 1];
    if (lastCompaction !== undefined) {
      last.insertBeforeIndex = countMessagesBetween(
        entries,
        lastCompaction.firstKeptEntryId,
        lastCompaction.id,
      );
    }
  }

  return events;
}

/**
 * Count message-typed entries between two entry ids (exclusive of the
 * end id). Returns the position where the compaction card should
 * splice into `session.messages`. When `firstKeptEntryId` doesn't
 * resolve (legacy session, manual JSONL edit), returns 0 — the card
 * lands at the top of the chat, which is the safe fallback.
 */
function countMessagesBetween(
  entries: SessionEntry[],
  firstKeptEntryId: string,
  endEntryId: string,
): number {
  const startIdx = entries.findIndex((e) => e.id === firstKeptEntryId);
  if (startIdx === -1) return 0;
  let count = 0;
  for (let i = startIdx; i < entries.length; i++) {
    const e = entries[i];
    if (e === undefined) break;
    if (e.id === endEntryId) break;
    if (isMessageEntry(e)) count++;
  }
  return count;
}
