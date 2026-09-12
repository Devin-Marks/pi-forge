import { context, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { isTelemetryContentCaptureEnabled } from "./telemetry-settings.js";

const TRACER_NAME = "pi-forge.sessions";
const MAX_CAPTURE_CHARS = 1_000_000;

let provider: NodeTracerProvider | undefined;
let initialized = false;

function parseHeaders(value: string | undefined): Record<string, string> {
  if (value === undefined) return {};
  const headers: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    const rawValue = entry.slice(separator + 1).trim();
    if (key.length === 0) continue;
    try {
      headers[decodeURIComponent(key)] = decodeURIComponent(rawValue);
    } catch {
      headers[key] = rawValue;
    }
  }
  return headers;
}

export function telemetryTraceEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed}/v1/traces`;
}

export function telemetryExporterOptions(
  endpoint: string,
): NonNullable<ConstructorParameters<typeof OTLPTraceExporter>[0]> {
  return {
    url: telemetryTraceEndpoint(endpoint),
    headers: parseHeaders(config.telemetry.otlpHeaders),
    ...(config.telemetry.otlpTlsRejectUnauthorized
      ? {}
      : { httpAgentOptions: { rejectUnauthorized: false } }),
  };
}

type TelemetryDebugLog = (message: string) => void;

function diagnosticEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(telemetryTraceEndpoint(endpoint));
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "(invalid endpoint)";
  }
}

function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return `${error.name}${code === undefined ? "" : ` [${code}]`}: ${error.message}`;
}

export function telemetryDebugExporter(
  delegate: SpanExporter,
  endpoint: string,
  tlsRejectUnauthorized: boolean,
  log: TelemetryDebugLog = (message) => console.log(message),
): SpanExporter {
  const safeEndpoint = diagnosticEndpoint(endpoint);
  const write = (message: string): void => {
    try {
      log(`[telemetry:debug] ${message}`);
    } catch {
      // Diagnostic output must never interrupt trace export.
    }
  };

  write(
    `OTLP exporter configured endpoint=${safeEndpoint} tlsRejectUnauthorized=${String(tlsRejectUnauthorized)}`,
  );

  return {
    export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
      const startedAt = Date.now();
      write(`export started spans=${spans.length}`);
      try {
        delegate.export(spans, (result) => {
          const elapsedMs = Date.now() - startedAt;
          if (Number(result.code) === 0) {
            write(`export succeeded spans=${spans.length} durationMs=${elapsedMs}`);
          } else {
            write(
              `export failed spans=${spans.length} durationMs=${elapsedMs} error=${errorSummary(result.error)}`,
            );
          }
          resultCallback(result);
        });
      } catch (error) {
        write(`export threw spans=${spans.length} error=${errorSummary(error)}`);
        throw error;
      }
    },
    async forceFlush(): Promise<void> {
      write("force flush started");
      try {
        await delegate.forceFlush?.();
        write("force flush completed");
      } catch (error) {
        write(`force flush failed error=${errorSummary(error)}`);
        throw error;
      }
    },
    async shutdown(): Promise<void> {
      write("exporter shutdown started");
      try {
        await delegate.shutdown();
        write("exporter shutdown completed");
      } catch (error) {
        write(`exporter shutdown failed error=${errorSummary(error)}`);
        throw error;
      }
    },
  };
}

export function initializeTelemetry(exporterOverride?: SpanExporter): void {
  if (initialized) return;
  initialized = true;
  const endpoint = config.telemetry.otlpEndpoint;
  if (endpoint === undefined && exporterOverride === undefined) {
    if (config.telemetry.debug) {
      console.log("[telemetry:debug] telemetry disabled: OTEL_EXPORTER_OTLP_ENDPOINT is unset");
    }
    return;
  }

  let exporter = exporterOverride;
  if (exporter === undefined) {
    const otlpExporter = new OTLPTraceExporter(telemetryExporterOptions(endpoint!));
    exporter = config.telemetry.debug
      ? telemetryDebugExporter(otlpExporter, endpoint!, config.telemetry.otlpTlsRejectUnauthorized)
      : otlpExporter;
  }
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.telemetry.serviceName,
      [ATTR_SERVICE_VERSION]: config.telemetry.serviceVersion,
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();
}

export async function shutdownTelemetry(): Promise<void> {
  const activeProvider = provider;
  provider = undefined;
  initialized = false;
  if (activeProvider === undefined) return;
  try {
    await activeProvider.shutdown();
  } catch (err) {
    // Observability must never make shutdown fail. Exporter diagnostics do
    // not include configured headers, so this cannot leak OTLP credentials.
    console.warn(
      "[telemetry] shutdown failed",
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
  } finally {
    // The API otherwise retains a proxy to the shut-down provider and rejects
    // registration when a Fastify server is rebuilt in the same process.
    trace.disable();
    context.disable();
  }
}

export async function flushTelemetry(): Promise<void> {
  try {
    await provider?.forceFlush();
  } catch (err) {
    console.warn(
      "[telemetry] flush failed",
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
  }
}

export function formatTelemetrySessionId(username: string, sessionId: string): string {
  const safeUsername = username.trim().replace(/[^A-Za-z0-9._@-]/g, "_") || "unknown";
  return `${safeUsername.slice(0, 160)}:${sessionId}`;
}

function stringify(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? nested.toString() : nested,
    );
  } catch {
    serialized = JSON.stringify(String(value));
  }
  return serialized.length <= MAX_CAPTURE_CHARS
    ? serialized
    : `${serialized.slice(0, MAX_CAPTURE_CHARS)}…`;
}

function messageKey(message: unknown): string {
  const candidate = message as { role?: unknown; timestamp?: unknown };
  return `${String(candidate.role ?? "unknown")}:${String(candidate.timestamp ?? "unknown")}`;
}

function messageRole(message: unknown): string {
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : "unknown";
}

function messageContent(message: unknown): unknown {
  const candidate = message as { content?: unknown };
  return candidate.content;
}

function spanContext(parent: Span | undefined): Context | undefined {
  return parent === undefined ? undefined : trace.setSpan(context.active(), parent);
}

function baseAttributes(opts: SessionTelemetryOptions): Record<string, string> {
  const telemetrySessionId = formatTelemetrySessionId(opts.username, opts.sessionId);
  const telemetryUsername = opts.username.slice(0, 200);
  return {
    "langfuse.session.id": telemetrySessionId,
    "langfuse.user.id": telemetryUsername,
    "session.id": telemetrySessionId,
    "user.id": telemetryUsername,
    "pi.session.id": opts.sessionId,
    "pi.project.id": opts.projectId,
    "langfuse.trace.metadata.pi_session_id": opts.sessionId,
    "langfuse.trace.metadata.project_id": opts.projectId,
  };
}

export interface SessionTelemetryOptions {
  sessionId: string;
  projectId: string;
  username: string;
  mcpToolNames: ReadonlySet<string>;
  model: () => { provider?: string; id?: string } | undefined;
}

export interface SessionTelemetry {
  handle(event: AgentSessionEvent): void;
  dispose(): void;
}

export function createSessionTelemetry(opts: SessionTelemetryOptions): SessionTelemetry {
  const tracer = trace.getTracer(TRACER_NAME, config.telemetry.serviceVersion);
  const common = baseAttributes(opts);
  const messageSpans = new Map<string, Span>();
  const toolSpans = new Map<string, Span>();
  let turnSpan: Span | undefined;
  let latestUserContent: unknown;

  const endOutstanding = (status?: { code: SpanStatusCode; message?: string }): void => {
    for (const span of [...messageSpans.values(), ...toolSpans.values()]) {
      if (status !== undefined) span.setStatus(status);
      span.end();
    }
    messageSpans.clear();
    toolSpans.clear();
  };

  return {
    handle(event) {
      if (event.type === "agent_start") {
        endOutstanding({ code: SpanStatusCode.ERROR, message: "superseded by a new agent turn" });
        turnSpan?.end();
        const model = opts.model();
        latestUserContent = undefined;
        turnSpan = tracer.startSpan("pi.session.turn", {
          attributes: {
            ...common,
            "langfuse.observation.type": "agent",
            "langfuse.trace.name": "pi session turn",
            "gen_ai.operation.name": "invoke_agent",
            ...(model?.provider === undefined ? {} : { "gen_ai.provider.name": model.provider }),
            ...(model?.id === undefined ? {} : { "gen_ai.request.model": model.id }),
          },
        });
        return;
      }

      if (event.type === "message_start") {
        const role = messageRole(event.message);
        const content = messageContent(event.message);
        if (role === "user") latestUserContent = content;
        const model = opts.model();
        const observationInput = role === "assistant" ? latestUserContent : content;
        const span = tracer.startSpan(
          `pi.message.${role}`,
          {
            attributes: {
              ...common,
              "langfuse.observation.type": role === "assistant" ? "generation" : "event",
              "gen_ai.operation.name": role === "assistant" ? "chat" : "message",
              "gen_ai.message.role": role,
              ...(role !== "assistant" || model?.provider === undefined
                ? {}
                : { "gen_ai.provider.name": model.provider }),
              ...(role !== "assistant" || model?.id === undefined
                ? {}
                : {
                    "gen_ai.request.model": model.id,
                    "langfuse.observation.model": model.id,
                  }),
              ...(isTelemetryContentCaptureEnabled() && observationInput !== undefined
                ? { "langfuse.observation.input": stringify(observationInput) }
                : {}),
            },
          },
          spanContext(turnSpan),
        );
        messageSpans.set(messageKey(event.message), span);
        if (isTelemetryContentCaptureEnabled() && role === "user") {
          turnSpan?.setAttribute(
            "langfuse.observation.input",
            stringify(messageContent(event.message)),
          );
        }
        return;
      }

      if (event.type === "message_end") {
        const role = messageRole(event.message);
        const span = messageSpans.get(messageKey(event.message));
        if (span === undefined) return;
        if (isTelemetryContentCaptureEnabled()) {
          span.setAttribute(
            "langfuse.observation.output",
            stringify(messageContent(event.message)),
          );
          if (role === "assistant") {
            turnSpan?.setAttribute(
              "langfuse.observation.output",
              stringify(messageContent(event.message)),
            );
          }
        }
        const assistant = event.message as {
          role?: string;
          provider?: string;
          model?: string;
          usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            reasoning?: number;
            totalTokens?: number;
            cost?: {
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              total?: number;
            };
          };
          stopReason?: string;
          errorMessage?: string;
        };
        if (assistant.role === "assistant") {
          const activeModel = opts.model();
          const provider = assistant.provider ?? activeModel?.provider;
          const modelId = assistant.model ?? activeModel?.id;
          if (provider !== undefined) span.setAttribute("gen_ai.provider.name", provider);
          if (modelId !== undefined) {
            span.setAttribute("gen_ai.request.model", modelId);
            span.setAttribute("langfuse.observation.model", modelId);
          }
          if (assistant.usage !== undefined) {
            span.setAttribute(
              "langfuse.observation.usage_details",
              stringify({
                input: assistant.usage.input,
                output: assistant.usage.output,
                total: assistant.usage.totalTokens,
                cacheRead: assistant.usage.cacheRead,
                cacheWrite: assistant.usage.cacheWrite,
                reasoning: assistant.usage.reasoning,
              }),
            );
          }
          if (assistant.usage?.cost !== undefined) {
            span.setAttribute("langfuse.observation.cost_details", stringify(assistant.usage.cost));
          }
          if (typeof assistant.usage?.input === "number") {
            span.setAttribute("gen_ai.usage.input_tokens", assistant.usage.input);
          }
          if (typeof assistant.usage?.output === "number") {
            span.setAttribute("gen_ai.usage.output_tokens", assistant.usage.output);
          }
          if (assistant.stopReason !== undefined) {
            span.setAttribute("gen_ai.response.finish_reasons", [assistant.stopReason]);
          }
          if (assistant.errorMessage !== undefined) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: assistant.errorMessage });
            span.recordException(new Error(assistant.errorMessage));
            turnSpan?.setStatus({ code: SpanStatusCode.ERROR, message: assistant.errorMessage });
          }
        }
        span.end();
        messageSpans.delete(messageKey(event.message));
        return;
      }

      if (event.type === "tool_execution_start") {
        const isMcp = opts.mcpToolNames.has(event.toolName);
        const span = tracer.startSpan(
          `pi.tool.${event.toolName}`,
          {
            attributes: {
              ...common,
              "langfuse.observation.type": "tool",
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.name": event.toolName,
              "pi.tool.type": isMcp ? "mcp" : "builtin",
              ...(isTelemetryContentCaptureEnabled()
                ? { "langfuse.observation.input": stringify(event.args) }
                : {}),
            },
          },
          spanContext(turnSpan),
        );
        toolSpans.set(event.toolCallId, span);
        return;
      }

      if (event.type === "tool_execution_end") {
        const span = toolSpans.get(event.toolCallId);
        if (span === undefined) return;
        if (isTelemetryContentCaptureEnabled()) {
          span.setAttribute("langfuse.observation.output", stringify(event.result));
        }
        if (event.isError) span.setStatus({ code: SpanStatusCode.ERROR, message: "tool failed" });
        else span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        toolSpans.delete(event.toolCallId);
        return;
      }

      if (event.type === "agent_end") {
        endOutstanding({ code: SpanStatusCode.ERROR, message: "agent turn ended early" });
        turnSpan?.end();
        turnSpan = undefined;
      }
    },
    dispose() {
      endOutstanding({ code: SpanStatusCode.ERROR, message: "session disposed" });
      turnSpan?.end();
      turnSpan = undefined;
    },
  };
}

export function recordSessionLifecycle(
  action: "created" | "resumed" | "forked" | "disposed",
  opts: Omit<SessionTelemetryOptions, "mcpToolNames" | "model">,
): void {
  const span = trace
    .getTracer(TRACER_NAME, config.telemetry.serviceVersion)
    .startSpan(`pi.session.${action}`, {
      attributes: {
        ...baseAttributes({ ...opts, mcpToolNames: new Set(), model: () => undefined }),
        "langfuse.observation.type": "event",
        "pi.session.lifecycle": action,
      },
    });
  span.end();
}
