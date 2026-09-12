/** OpenTelemetry session/message/tool instrumentation and identity tests. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemorySpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const temp = await mkdtemp(join(tmpdir(), "pi-forge-telemetry-"));
process.env.FORGE_DATA_DIR = temp;
process.env.WORKSPACE_PATH = temp;
process.env.PI_CONFIG_DIR = join(temp, "pi-config");
process.env.OTEL_CAPTURE_CONTENT = "true";
process.env.OTEL_EXPORTER_OTLP_TLS_REJECT_UNAUTHORIZED = "false";

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

try {
  const telemetry = (await import(
    resolve("packages/server/dist/telemetry.js")
  )) as typeof import("../packages/server/src/telemetry.js");
  const identities = (await import(
    resolve("packages/server/dist/session-identity.js")
  )) as typeof import("../packages/server/src/session-identity.js");
  const telemetrySettings = (await import(
    resolve("packages/server/dist/telemetry-settings.js")
  )) as typeof import("../packages/server/src/telemetry-settings.js");
  const exporter = new InMemorySpanExporter();
  telemetry.initializeTelemetry(exporter);

  assert(
    "OTLP base endpoint gets traces suffix",
    telemetry.telemetryTraceEndpoint("https://cloud.langfuse.com/api/public/otel/") ===
      "https://cloud.langfuse.com/api/public/otel/v1/traces",
  );
  const exporterOptions = telemetry.telemetryExporterOptions("https://otel.example.com");
  const agentOptions = exporterOptions.httpAgentOptions as
    | { rejectUnauthorized?: boolean }
    | undefined;
  assert(
    "OTLP TLS verification can be disabled without changing process-wide TLS",
    typeof agentOptions === "object" && agentOptions.rejectUnauthorized === false,
  );

  const debugLines: string[] = [];
  const failingExporter: SpanExporter = {
    export(_spans, resultCallback): void {
      const error = Object.assign(new Error("self-signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      });
      resultCallback({ code: 1, error });
    },
    shutdown(): Promise<void> {
      return Promise.resolve();
    },
  };
  const debugExporter = telemetry.telemetryDebugExporter(
    failingExporter,
    "https://user:password@otel.example.com/v1/traces?token=secret",
    false,
    (line) => debugLines.push(line),
  );
  debugExporter.export(
    [{ name: "private prompt", attributes: { secret: "private span content" } } as never],
    () => undefined,
  );
  assert(
    "OTEL debug output reports sanitized exporter failures",
    debugLines.some(
      (line) =>
        line.includes("endpoint=https://otel.example.com/v1/traces") &&
        line.includes("tlsRejectUnauthorized=false"),
    ) &&
      debugLines.some(
        (line) =>
          line.includes("export failed spans=1") &&
          line.includes("DEPTH_ZERO_SELF_SIGNED_CERT") &&
          line.includes("self-signed certificate"),
      ),
  );
  assert(
    "OTEL debug output excludes endpoint credentials and span contents",
    debugLines.every(
      (line) =>
        !line.includes("password") &&
        !line.includes("token=secret") &&
        !line.includes("private prompt") &&
        !line.includes("private span content"),
    ),
  );

  assert(
    "username is included in telemetry session id",
    telemetry.formatTelemetrySessionId("alice@example.com", "session-123") ===
      "alice@example.com:session-123",
  );

  const tracker = telemetry.createSessionTelemetry({
    sessionId: "session-123",
    projectId: "project-456",
    username: "alice@example.com",
    mcpToolNames: new Set(["search__web"]),
    model: () => ({ provider: "anthropic", id: "claude-test" }),
  });
  const emit = (event: unknown): void => tracker.handle(event as AgentSessionEvent);
  emit({ type: "agent_start" });
  emit({
    type: "message_start",
    message: { role: "user", content: "private prompt", timestamp: 1 },
  });
  emit({
    type: "message_end",
    message: { role: "user", content: "private prompt", timestamp: 1 },
  });
  emit({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "search__web",
    args: { query: "secret query" },
  });
  emit({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "search__web",
    result: { content: "answer" },
    isError: false,
  });
  emit({
    type: "message_start",
    message: { role: "assistant", content: [], timestamp: 2 },
  });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "private response" }],
      timestamp: 2,
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 4,
        output: 2,
        cacheRead: 1,
        cacheWrite: 3,
        totalTokens: 10,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.003, total: 0.034 },
      },
      stopReason: "stop",
    },
  });
  emit({ type: "agent_end", messages: [] });
  await telemetry.flushTelemetry();

  const spans = exporter.getFinishedSpans();
  const turn = spans.find((span) => span.name === "pi.session.turn");
  const tool = spans.find((span) => span.name === "pi.tool.search__web");
  const userMessage = spans.find((span) => span.name === "pi.message.user");
  const assistantMessage = spans.find((span) => span.name === "pi.message.assistant");
  assert("turn span exported", turn !== undefined);
  assert("user message span exported", userMessage !== undefined);
  assert("assistant message span exported", assistantMessage !== undefined);
  assert("MCP tool span exported", tool !== undefined);
  assert(
    "all spans include username-bearing Langfuse session id",
    spans.every(
      (span) => span.attributes["langfuse.session.id"] === "alice@example.com:session-123",
    ),
  );
  assert("MCP tool is classified", tool?.attributes["pi.tool.type"] === "mcp");
  assert(
    "generation includes model, usage, and cost attribution",
    assistantMessage?.attributes["langfuse.observation.model"] === "claude-test" &&
      String(assistantMessage?.attributes["langfuse.observation.usage_details"]).includes(
        '"cacheRead":1',
      ) &&
      String(assistantMessage?.attributes["langfuse.observation.cost_details"]).includes(
        '"total":0.034',
      ),
  );
  assert(
    "content capture includes user data when explicitly enabled",
    userMessage?.attributes["langfuse.observation.input"] === '"private prompt"' &&
      assistantMessage?.attributes["langfuse.observation.input"] === '"private prompt"' &&
      String(tool?.attributes["langfuse.observation.input"]).includes("secret query") &&
      String(assistantMessage?.attributes["langfuse.observation.output"]).includes(
        "private response",
      ),
  );
  assert(
    "message and tool spans are children of the turn trace",
    turn !== undefined &&
      tool?.spanContext().traceId === turn.spanContext().traceId &&
      userMessage?.spanContext().traceId === turn.spanContext().traceId,
  );

  await telemetrySettings.writeTelemetrySettings({ captureContent: false });
  assert(
    "runtime telemetry setting can disable content capture",
    telemetrySettings.isTelemetryContentCaptureEnabled() === false,
  );
  const redactedTracker = telemetry.createSessionTelemetry({
    sessionId: "session-redacted",
    projectId: "project-456",
    username: "alice@example.com",
    mcpToolNames: new Set(),
    model: () => ({ provider: "anthropic", id: "claude-test" }),
  });
  const emitRedacted = (event: unknown): void => redactedTracker.handle(event as AgentSessionEvent);
  emitRedacted({ type: "agent_start" });
  emitRedacted({
    type: "message_start",
    message: { role: "user", content: "do not capture", timestamp: 3 },
  });
  emitRedacted({
    type: "message_end",
    message: { role: "user", content: "do not capture", timestamp: 3 },
  });
  emitRedacted({ type: "agent_end", messages: [] });
  await telemetry.flushTelemetry();
  const redactedUser = exporter
    .getFinishedSpans()
    .filter(
      (span) => span.attributes["langfuse.session.id"] === "alice@example.com:session-redacted",
    )
    .find((span) => span.name === "pi.message.user");
  assert(
    "content capture excludes user data when disabled at runtime",
    redactedUser !== undefined &&
      redactedUser.attributes["langfuse.observation.input"] === undefined,
  );

  await identities.rememberSessionUsername("session-123", "alice@example.com");
  assert(
    "session username survives identity lookup",
    (await identities.usernameForSession("session-123")) === "alice@example.com",
  );
  const persisted = JSON.parse(
    await readFile(resolve(temp, "session-users.json"), "utf8"),
  ) as Record<string, string>;
  assert("session username is persisted", persisted["session-123"] === "alice@example.com");

  const appSource = await readFile(resolve("packages/client/src/App.tsx"), "utf8");
  assert(
    "app banner warns when telemetry content capture is on",
    appSource.includes("OTEL content capture on"),
  );
  const chatInputSource = await readFile(
    resolve("packages/client/src/components/ChatInput.tsx"),
    "utf8",
  );
  assert(
    "chat input requires telemetry capture acknowledgement",
    chatInputSource.includes("I acknowledge that this message") &&
      chatInputSource.includes("Confirm telemetry content capture before sending"),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} telemetry assertion(s) failed`);
  process.exit(1);
}
console.log("\nTelemetry tests passed");
