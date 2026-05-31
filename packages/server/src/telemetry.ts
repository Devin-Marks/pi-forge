import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { context, metrics, SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVICE_NAME,
} from "@opentelemetry/semantic-conventions";
import { config } from "./config.js";

const tracer = trace.getTracer("pi-forge.server");
const meter = metrics.getMeter("pi-forge.server");

const httpRequestDuration = meter.createHistogram("pi_forge.http.server.duration", {
  description: "Duration of pi-forge HTTP requests",
  unit: "ms",
});
const httpRequestCount = meter.createCounter("pi_forge.http.server.requests", {
  description: "Count of pi-forge HTTP requests",
});
const sessionEventCount = meter.createCounter("pi_forge.session.events", {
  description: "Count of safe pi-forge session lifecycle events",
});

let sdk: NodeSDK | undefined;
let started = false;

interface TelemetryRequestState {
  span: Span;
  startedAt: bigint;
}

declare module "fastify" {
  interface FastifyRequest {
    telemetry?: TelemetryRequestState;
  }
}

function exporterUrl(signal: "traces" | "metrics"): string | undefined {
  if (signal === "traces" && config.telemetry.otlpTracesEndpoint !== undefined) {
    return config.telemetry.otlpTracesEndpoint;
  }
  if (signal === "metrics" && config.telemetry.otlpMetricsEndpoint !== undefined) {
    return config.telemetry.otlpMetricsEndpoint;
  }
  if (config.telemetry.otlpEndpoint === undefined) return undefined;
  const base = config.telemetry.otlpEndpoint.replace(/\/+$/, "");
  return `${base}/v1/${signal}`;
}

function exporterHeaders(): Record<string, string> | undefined {
  const raw = config.telemetry.otlpHeaders;
  if (raw === undefined) return undefined;
  const headers: Record<string, string> = {};
  for (const part of raw.split(/[,\n]/)) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key.length > 0) headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function isTelemetryEnabled(): boolean {
  return (
    config.telemetry.enabled && (config.telemetry.tracesEnabled || config.telemetry.metricsEnabled)
  );
}

function exporterConfig(signal: "traces" | "metrics"): {
  url?: string;
  headers?: Record<string, string>;
} {
  const url = exporterUrl(signal);
  const headers = exporterHeaders();
  return {
    ...(url !== undefined ? { url } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
}

export function startTelemetry(): void {
  if (started || !isTelemetryEnabled()) return;
  const metricReaders = config.telemetry.metricsEnabled
    ? [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(exporterConfig("metrics")),
          exportIntervalMillis: 30_000,
        }),
      ]
    : [];

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.telemetry.serviceName,
    }),
    ...(config.telemetry.tracesEnabled
      ? { traceExporter: new OTLPTraceExporter(exporterConfig("traces")) }
      : {}),
    ...(metricReaders.length > 0 ? { metricReaders } : {}),
    instrumentations: [],
  });
  sdk.start();
  started = true;
}

export async function shutdownTelemetry(): Promise<void> {
  if (!started || sdk === undefined) return;
  const current = sdk;
  sdk = undefined;
  started = false;
  await current.shutdown();
}

function routeFor(req: FastifyRequest): string {
  const routePath = req.routeOptions?.url;
  if (typeof routePath === "string" && routePath.length > 0) return routePath;
  return "unmatched";
}

function httpAttributes(
  req: FastifyRequest,
  reply?: FastifyReply,
): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    [ATTR_HTTP_REQUEST_METHOD]: req.method,
    [ATTR_HTTP_ROUTE]: routeFor(req),
  };
  if (reply !== undefined) attrs[ATTR_HTTP_RESPONSE_STATUS_CODE] = reply.statusCode;
  return attrs;
}

export function installTelemetryHooks(fastify: FastifyInstance): void {
  if (!isTelemetryEnabled()) return;

  fastify.addHook("onRequest", async (req) => {
    const span = tracer.startSpan(`HTTP ${req.method}`, {
      kind: SpanKind.SERVER,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: req.method,
      },
    });
    req.telemetry = { span, startedAt: process.hrtime.bigint() };
  });

  fastify.addHook("onError", async (req, _reply, err) => {
    const state = req.telemetry;
    if (state === undefined) return;
    state.span.recordException(err);
    state.span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    state.span.setAttribute(ATTR_ERROR_TYPE, err.name || "Error");
  });

  fastify.addHook("onResponse", async (req, reply) => {
    const state = req.telemetry;
    if (state === undefined) return;
    const attrs = httpAttributes(req, reply);
    const statusCode = reply.statusCode;
    if (statusCode >= 500) {
      state.span.setStatus({ code: SpanStatusCode.ERROR });
    }
    state.span.setAttributes(attrs);
    state.span.updateName(`${req.method} ${attrs[ATTR_HTTP_ROUTE]}`);
    state.span.end();

    const durationMs = Number(process.hrtime.bigint() - state.startedAt) / 1_000_000;
    httpRequestCount.add(1, attrs);
    httpRequestDuration.record(durationMs, attrs);
  });
}

export function recordSessionEvent(
  event: "created" | "resumed" | "disposed" | "agent_start" | "agent_end" | "error",
  attrs: { projectId?: string; sessionId?: string; errorType?: string } = {},
): void {
  if (!isTelemetryEnabled()) return;
  const safeAttrs: Record<string, string> = { event };
  if (attrs.projectId !== undefined) safeAttrs.project_id = attrs.projectId;
  // Deliberately omit sessionId from metrics: it is useful on spans,
  // but too high-cardinality for counters in long-lived deployments.
  void attrs.sessionId;
  if (attrs.errorType !== undefined) safeAttrs.error_type = attrs.errorType;
  sessionEventCount.add(1, safeAttrs);
}

export async function withSessionSpan<T>(
  name: string,
  attrs: { projectId?: string; sessionId?: string; operation: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (!isTelemetryEnabled() || !config.telemetry.tracesEnabled) return fn();
  const span = tracer.startSpan(name, {
    attributes: {
      "pi_forge.session.operation": attrs.operation,
      ...(attrs.projectId !== undefined ? { "pi_forge.project.id": attrs.projectId } : {}),
      ...(attrs.sessionId !== undefined ? { "pi_forge.session.id": attrs.sessionId } : {}),
    },
  });
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.setAttribute(ATTR_ERROR_TYPE, error.name || "Error");
      recordSessionEvent("error", {
        ...(attrs.projectId !== undefined ? { projectId: attrs.projectId } : {}),
        ...(attrs.sessionId !== undefined ? { sessionId: attrs.sessionId } : {}),
        errorType: error.name || "Error",
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
