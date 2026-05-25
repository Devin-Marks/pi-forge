/**
 * Settings → Webhooks tab.
 *
 * Lists configured webhooks, lets the user create / edit / delete
 * them, and surfaces recent delivery history per webhook for
 * debugging. The tab is rendered under the Settings modal — see
 * SettingsPanel.tsx for the tab strip wiring. Hidden entirely when
 * `MINIMAL_UI=1` (matches the server-side 403 on
 * POST/PATCH/DELETE/test).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2, Send, ChevronDown, ChevronRight } from "lucide-react";
import {
  api,
  ApiError,
  WEBHOOK_EVENTS,
  type WebhookConfigWire,
  type WebhookCreateBody,
  type WebhookDelivery,
  type WebhookEvent,
  type WebhookScope,
} from "../lib/api-client";
import { useProjectStore } from "../store/project-store";

/** Human-readable label for an event. The bare event name is also
 *  shown in monospace next to it so consumers searching for the
 *  exact string can find it. */
const EVENT_LABELS: Record<WebhookEvent, string> = {
  agent_end: "Agent turn finished",
  ask_user_question: "Agent asked a question (waiting on user)",
  process_alert: "Background process exited",
  auto_retry_end: "Auto-retry exhausted (provider failure)",
  compaction_end: "Context compaction completed",
  session_created: "Session created",
  session_deleted: "Session deleted",
};

interface DraftWebhook {
  id?: string;
  name: string;
  url: string;
  events: Set<WebhookEvent>;
  scope: WebhookScope;
  /** Empty string means "leave existing secret unchanged" on edit;
   *  on create, empty means "no secret." */
  secret: string;
  /** Header text in editable form: "X-Foo: bar\nX-Baz: qux".
   *  Parsed on save. */
  headersText: string;
  insecureTls: boolean;
  enabled: boolean;
}

function emptyDraft(): DraftWebhook {
  return {
    name: "",
    url: "",
    events: new Set(),
    scope: { kind: "global" },
    secret: "",
    headersText: "",
    insecureTls: false,
    enabled: true,
  };
}

function configToDraft(w: WebhookConfigWire): DraftWebhook {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    events: new Set(w.events),
    scope: w.scope,
    secret: "",
    headersText:
      w.headers === undefined
        ? ""
        : Object.entries(w.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n"),
    insecureTls: w.insecureTls === true,
    enabled: w.enabled,
  };
}

/**
 * Parse "Name: value" lines into a headers object. Blank lines and
 * lines without a colon are skipped silently — the input is a
 * free-form textarea, not a strict format. Whitespace around the
 * colon is trimmed. Returns `undefined` for the empty case so the
 * draft can omit the field entirely.
 */
function parseHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name.length === 0) continue;
    out[name] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function WebhooksTab({ onError }: { onError: (msg: string | undefined) => void }) {
  const projects = useProjectStore((s) => s.projects);
  const [webhooks, setWebhooks] = useState<WebhookConfigWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftWebhook | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>();
  const [expandedDeliveriesId, setExpandedDeliveriesId] = useState<string | undefined>();

  const reload = useCallback(async (): Promise<void> => {
    onError(undefined);
    setLoading(true);
    try {
      const { webhooks: list } = await api.listWebhooks();
      setWebhooks(list);
    } catch (err) {
      onError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onSave = async (): Promise<void> => {
    if (draft === undefined) return;
    const events = Array.from(draft.events);
    if (draft.name.trim().length === 0) {
      onError("name_required");
      return;
    }
    if (draft.url.trim().length === 0) {
      onError("url_required");
      return;
    }
    if (events.length === 0) {
      onError("no_events");
      return;
    }
    setSubmitting(true);
    onError(undefined);
    try {
      const body: WebhookCreateBody = {
        name: draft.name.trim(),
        url: draft.url.trim(),
        events,
        scope: draft.scope,
        enabled: draft.enabled,
      };
      if (draft.secret.length > 0) body.secret = draft.secret;
      const parsedHeaders = parseHeaders(draft.headersText);
      if (parsedHeaders !== undefined) body.headers = parsedHeaders;
      if (draft.insecureTls) body.insecureTls = true;
      if (draft.id === undefined) {
        await api.createWebhook(body);
      } else {
        // For edits: only include `secret` if the user actually
        // typed something. Empty stays "no change." Headers +
        // insecureTls always sent (the textarea is the source of
        // truth — clearing it should clear the headers on the
        // server too).
        const patch: Partial<WebhookCreateBody> = {
          name: body.name,
          url: body.url,
          events: body.events,
          scope: body.scope,
          enabled: draft.enabled,
          headers: parsedHeaders ?? {},
          insecureTls: draft.insecureTls,
        };
        if (draft.secret.length > 0) patch.secret = draft.secret;
        await api.updateWebhook(draft.id, patch);
      }
      setDraft(undefined);
      await reload();
    } catch (err) {
      onError(
        err instanceof ApiError ? `${err.code}: ${err.message ?? ""}` : (err as Error).message,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (id: string): Promise<void> => {
    onError(undefined);
    try {
      await api.deleteWebhook(id);
      setPendingDeleteId(undefined);
      await reload();
    } catch (err) {
      onError(err instanceof ApiError ? err.code : (err as Error).message);
    }
  };

  const onTest = async (id: string): Promise<void> => {
    onError(undefined);
    try {
      await api.testWebhook(id);
      // Auto-expand the delivery history so the user can see the
      // test result land. The list re-renders below from the same
      // expandedDeliveriesId state.
      setExpandedDeliveriesId(id);
    } catch (err) {
      onError(err instanceof ApiError ? err.code : (err as Error).message);
    }
  };

  if (loading) {
    return <p className="px-4 py-6 text-sm text-neutral-400">Loading…</p>;
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <header className="flex items-center justify-between">
        <p className="text-sm text-neutral-400">
          Webhooks fire HTTP POSTs to URLs you configure when agent or session events happen. Useful
          for Slack notifications, CI integrations, audit logs, etc. Stored at{" "}
          <code className="font-mono text-xs">$FORGE_DATA_DIR/webhooks.json</code>.
        </p>
        {draft === undefined && (
          <button
            type="button"
            onClick={() => setDraft(emptyDraft())}
            className="shrink-0 rounded bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900"
          >
            + New webhook
          </button>
        )}
      </header>

      {draft !== undefined && (
        <DraftForm
          draft={draft}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          submitting={submitting}
          onChange={setDraft}
          onCancel={() => setDraft(undefined)}
          onSave={() => void onSave()}
        />
      )}

      {webhooks.length === 0 ? (
        <p className="rounded border border-dashed border-neutral-700 px-4 py-6 text-center text-sm italic text-neutral-500">
          No webhooks configured.
        </p>
      ) : (
        <ul className="space-y-2">
          {webhooks.map((w) => (
            <WebhookRow
              key={w.id}
              webhook={w}
              projects={projects.map((p) => ({ id: p.id, name: p.name }))}
              isPendingDelete={pendingDeleteId === w.id}
              isExpanded={expandedDeliveriesId === w.id}
              onArmDelete={() => setPendingDeleteId(w.id)}
              onCancelDelete={() => setPendingDeleteId(undefined)}
              onConfirmDelete={() => void onDelete(w.id)}
              onEdit={() => setDraft(configToDraft(w))}
              onTest={() => void onTest(w.id)}
              onToggleDeliveries={() =>
                setExpandedDeliveriesId((cur) => (cur === w.id ? undefined : w.id))
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function DraftForm({
  draft,
  projects,
  submitting,
  onChange,
  onCancel,
  onSave,
}: {
  draft: DraftWebhook;
  projects: { id: string; name: string }[];
  submitting: boolean;
  onChange: (next: DraftWebhook) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const isEdit = draft.id !== undefined;
  const update = (patch: Partial<DraftWebhook>): void => onChange({ ...draft, ...patch });
  const toggleEvent = (event: WebhookEvent): void => {
    const next = new Set(draft.events);
    if (next.has(event)) next.delete(event);
    else next.add(event);
    update({ events: next });
  };
  return (
    <div className="space-y-3 rounded-md border border-neutral-700 bg-neutral-950 p-3">
      <header className="text-xs uppercase tracking-wider text-neutral-400">
        {isEdit ? "Edit webhook" : "New webhook"}
      </header>

      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-xs text-neutral-300">Name</span>
          <input
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="my-slack-channel"
            disabled={submitting}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm outline-none focus:border-neutral-500"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-neutral-300">URL (HTTPS only)</span>
          <input
            value={draft.url}
            onChange={(e) => update({ url: e.target.value })}
            placeholder="https://hooks.slack.com/..."
            disabled={submitting}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs outline-none focus:border-neutral-500"
          />
        </label>
      </div>

      <fieldset className="space-y-1">
        <legend className="text-xs text-neutral-300">Events</legend>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {WEBHOOK_EVENTS.map((event) => (
            <label
              key={event}
              className="flex items-start gap-2 rounded border border-neutral-800 px-2 py-1.5 hover:border-neutral-600"
            >
              <input
                type="checkbox"
                checked={draft.events.has(event)}
                onChange={() => toggleEvent(event)}
                disabled={submitting}
                className="mt-0.5"
              />
              <span className="flex flex-col text-[11px]">
                <span className="text-neutral-200">{EVENT_LABELS[event]}</span>
                <code className="font-mono text-[10px] text-neutral-500">{event}</code>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="text-xs text-neutral-300">Scope</legend>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={draft.scope.kind === "global"}
              onChange={() => update({ scope: { kind: "global" } })}
              disabled={submitting}
            />
            <span>Global (every project)</span>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={draft.scope.kind === "project"}
              onChange={() =>
                update({
                  scope: { kind: "project", projectId: projects[0]?.id ?? "" },
                })
              }
              disabled={submitting || projects.length === 0}
            />
            <span>Specific project:</span>
            <select
              value={draft.scope.kind === "project" ? draft.scope.projectId : ""}
              onChange={(e) => update({ scope: { kind: "project", projectId: e.target.value } })}
              disabled={submitting || draft.scope.kind !== "project"}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>

      <label className="block space-y-1">
        <span className="text-xs text-neutral-300">
          HMAC secret (optional){" "}
          {isEdit && (
            <span className="text-neutral-500">— leave blank to keep the existing secret</span>
          )}
        </span>
        <input
          type="password"
          value={draft.secret}
          onChange={(e) => update({ secret: e.target.value })}
          placeholder={isEdit ? "(unchanged)" : "shared secret for X-Pi-Forge-Signature"}
          disabled={submitting}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs outline-none focus:border-neutral-500"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-neutral-300">
          Custom headers (optional, one per line, <code>Name: value</code>)
        </span>
        <textarea
          rows={3}
          value={draft.headersText}
          onChange={(e) => update({ headersText: e.target.value })}
          placeholder="Authorization: Bearer xxx&#10;X-Custom: value"
          disabled={submitting}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs outline-none focus:border-neutral-500"
        />
        {isEdit && (
          <span className="block text-[11px] text-neutral-500">
            Stored values are masked as <code className="font-mono">***REDACTED***</code> for
            safety. Leave any line with the sentinel intact to keep the original value; replace it
            to update; delete the line to remove the header.
          </span>
        )}
      </label>

      <label className="flex items-start gap-2 rounded border border-amber-900/40 bg-amber-950/30 px-2 py-1.5 text-xs light:border-amber-300 light:bg-amber-50">
        <input
          type="checkbox"
          checked={draft.insecureTls}
          onChange={(e) => update({ insecureTls: e.target.checked })}
          disabled={submitting}
          className="mt-0.5"
        />
        <span>
          <span className="text-amber-200 light:text-amber-800">
            Allow self-signed / invalid TLS certificate
          </span>
          <br />
          <span className="text-[11px] text-amber-300/70 light:text-amber-700/80">
            ⚠ Disables MITM protection. Use only for internal hosts with known self-signed certs.
            Every fire logs to stderr so the relaxed security is visible in operator logs.
          </span>
        </span>
      </label>

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
          disabled={submitting}
        />
        <span>Enabled (disable to pause without losing config)</span>
      </label>

      <footer className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={submitting}
          className="rounded bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50"
        >
          {submitting ? "Saving…" : isEdit ? "Save changes" : "Create webhook"}
        </button>
      </footer>
    </div>
  );
}

function WebhookRow({
  webhook,
  projects,
  isPendingDelete,
  isExpanded,
  onArmDelete,
  onCancelDelete,
  onConfirmDelete,
  onEdit,
  onTest,
  onToggleDeliveries,
}: {
  webhook: WebhookConfigWire;
  projects: { id: string; name: string }[];
  isPendingDelete: boolean;
  isExpanded: boolean;
  onArmDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onEdit: () => void;
  onTest: () => void;
  onToggleDeliveries: () => void;
}) {
  const scopeLabel =
    webhook.scope.kind === "global"
      ? "Global"
      : `Project: ${projects.find((p) => p.id === webhook.scope.kind && p.id === (webhook.scope as { projectId: string }).projectId)?.name ?? (webhook.scope as { projectId: string }).projectId}`;
  return (
    <li
      className={`rounded-md border ${
        webhook.enabled ? "border-neutral-800" : "border-neutral-800/60 opacity-60"
      } bg-neutral-900`}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggleDeliveries}
          className="mt-0.5 text-neutral-500 hover:text-neutral-300"
          aria-label={isExpanded ? "Hide deliveries" : "Show recent deliveries"}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-neutral-100">{webhook.name}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                webhook.enabled
                  ? "bg-emerald-900/40 text-emerald-300"
                  : "bg-neutral-800 text-neutral-400"
              }`}
            >
              {webhook.enabled ? "enabled" : "disabled"}
            </span>
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-300">
              {scopeLabel}
            </span>
            {webhook.hasSecret && (
              <span className="rounded bg-sky-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-sky-300">
                signed
              </span>
            )}
            {webhook.insecureTls === true && (
              <span
                className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300"
                title="TLS cert validation disabled for this webhook"
              >
                insecure TLS
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-500">
            {webhook.url}
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-neutral-500">
            {webhook.events.join(" · ")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onTest}
            className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
            title="Fire a synthetic webhook.test event at this webhook"
          >
            <Send size={12} className="mr-1 inline" />
            Test
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
          >
            Edit
          </button>
          {isPendingDelete ? (
            <>
              <button
                type="button"
                onClick={onConfirmDelete}
                className="rounded bg-red-700 px-2 py-1 text-[11px] font-medium text-red-50"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={onCancelDelete}
                className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onArmDelete}
              className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-red-300 hover:bg-red-900/40"
              title="Delete this webhook"
              aria-label="Delete this webhook"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
      {isExpanded && <Deliveries webhookId={webhook.id} />}
    </li>
  );
}

function Deliveries({ webhookId }: { webhookId: string }) {
  const [items, setItems] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | undefined>();

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(undefined);
    try {
      const { deliveries } = await api.listWebhookDeliveries(webhookId);
      setItems(deliveries);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [webhookId]);

  useEffect(() => {
    void reload();
    // Light auto-poll while expanded so a freshly fired test event
    // shows up without a manual refresh. Cap interval at 3s — the
    // list is small and the endpoint is cheap.
    const id = window.setInterval(() => void reload(), 3000);
    return () => window.clearInterval(id);
  }, [reload]);

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Recent deliveries {items.length > 0 && `(${items.length})`}
        </span>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-800"
        >
          Refresh
        </button>
      </div>
      {loading && <p className="text-xs text-neutral-500">Loading…</p>}
      {err !== undefined && <p className="text-xs text-red-400">{err}</p>}
      {!loading && err === undefined && items.length === 0 && (
        <p className="text-xs italic text-neutral-500">No deliveries yet.</p>
      )}
      {items.length > 0 && (
        <ul className="space-y-1">
          {items.map((d) => (
            <li
              key={d.id}
              className="grid grid-cols-12 items-baseline gap-2 rounded bg-neutral-900 px-2 py-1 font-mono text-[10px]"
            >
              <span
                className={`col-span-2 ${
                  d.status === "delivered"
                    ? "text-emerald-400"
                    : d.status === "failed"
                      ? "text-red-400"
                      : "text-amber-400"
                }`}
              >
                {d.status}
                {d.statusCode !== undefined ? ` ${d.statusCode}` : ""}
              </span>
              <span className="col-span-2 text-neutral-400">{d.event}</span>
              <span className="col-span-1 text-neutral-500">a{d.attempt}</span>
              <span className="col-span-2 text-neutral-500">{d.durationMs}ms</span>
              <span className="col-span-5 truncate text-neutral-500" title={d.errorPreview ?? ""}>
                {d.errorPreview ?? new Date(d.requestedAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Suppress an unused-import warning if `useMemo` ever drops out. */
void useMemo;
