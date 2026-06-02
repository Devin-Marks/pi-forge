/**
 * Shared response schemas used across multiple route files. Extracting these
 * keeps the wire shape consistent — e.g. /sessions, /sessions/:id, and /fork
 * all return the same liveSummary fields rather than each route declaring its
 * own subset.
 */

/**
 * Standard error envelope for 4xx/5xx responses. `error` is required so
 * generated SDK clients can rely on its presence (no extra null-check).
 * `message` is optional context for callers that want a human-readable hint.
 */
export const errorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string" },
    message: { type: "string" },
  },
} as const;

/**
 * Live session summary — the shape returned by routes that produce a single
 * session metadata object (POST /sessions, GET /sessions/:id, POST /fork).
 * `name` is optional because not every session has a user-defined display
 * name; consumers should treat its absence as "no name set."
 */
export const liveSummarySchema = {
  type: "object",
  required: [
    "sessionId",
    "projectId",
    "workspacePath",
    "createdAt",
    "lastActivityAt",
    "isLive",
    "messageCount",
    "isStreaming",
  ],
  properties: {
    sessionId: { type: "string" },
    projectId: { type: "string" },
    workspacePath: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    lastActivityAt: { type: "string", format: "date-time" },
    isLive: { type: "boolean" },
    name: { type: "string" },
    messageCount: { type: "integer", minimum: 0 },
    isStreaming: { type: "boolean" },
    // Pi's ModelThinkingLevel union: "off" | "minimal" | "low" | "medium" |
    // "high" | "xhigh". Only present for live sessions — disk-only entries
    // omit it because the SDK only surfaces the active state on a loaded
    // AgentSession (the JSONL contains the transitions but reconstructing
    // the current value requires the replay logic, which is what
    // session-manager does on resume).
    thinkingLevel: { type: "string" },
    // Live AgentSession's active model identity (`session.model.provider`
    // and `session.model.id`). The client uses this to resolve the
    // "what model is this session actually using" question for UI
    // surfaces like the inline thinking-level picker — without it, the
    // client could only guess from per-session localStorage override OR
    // settings.json default, both of which can be empty/stale when the
    // SDK is running on its compile-time fallback model. Omitted for
    // disk-only entries (no live session, no active model).
    modelProvider: { type: "string" },
    modelId: { type: "string" },
    isExternalLive: { type: "boolean" },
    externalState: { type: "string", enum: ["queued", "running", "complete", "failed", "paused"] },
  },
} as const;

/**
 * Build a wire-shaped LiveSession summary, omitting `name` when unset so the
 * serializer doesn't emit an explicit undefined.
 *
 * `isLive` defaults to `true` because most callers (POST /sessions, /fork,
 * /sessions/:id when in-memory) are returning a live session. Disk-only
 * callers should pass `isLive: false` explicitly.
 */
export function liveSummaryBody(args: {
  sessionId: string;
  projectId: string;
  workspacePath: string;
  createdAt: Date;
  lastActivityAt: Date;
  name: string | undefined;
  messageCount: number;
  isStreaming: boolean;
  isLive?: boolean;
  thinkingLevel?: string;
  // `string | undefined` (not just `?: string`) so callers can pass
  // `session.model?.provider` directly without an upstream guard —
  // exactOptionalPropertyTypes rejects an explicit `undefined` against a
  // bare optional field. Body skips the emit when undefined either way.
  modelProvider?: string | undefined;
  modelId?: string | undefined;
  isExternalLive?: boolean;
  externalState?: "queued" | "running" | "complete" | "failed" | "paused";
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    sessionId: args.sessionId,
    projectId: args.projectId,
    workspacePath: args.workspacePath,
    createdAt: args.createdAt.toISOString(),
    lastActivityAt: args.lastActivityAt.toISOString(),
    isLive: args.isLive ?? true,
    messageCount: args.messageCount,
    isStreaming: args.isStreaming,
  };
  if (args.name !== undefined) out.name = args.name;
  if (args.thinkingLevel !== undefined) out.thinkingLevel = args.thinkingLevel;
  if (args.modelProvider !== undefined) out.modelProvider = args.modelProvider;
  if (args.modelId !== undefined) out.modelId = args.modelId;
  if (args.isExternalLive !== undefined) out.isExternalLive = args.isExternalLive;
  if (args.externalState !== undefined) out.externalState = args.externalState;
  return out;
}
