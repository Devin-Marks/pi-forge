/**
 * MCP tool result truncation unit test.
 *
 * Calls `capTextContent` and `mcpResultToAgentResult` directly with
 * synthetic input — no MCP server, no spawned process, no in-flight
 * server. Pure function tests, runs in well under a second.
 *
 * Coverage:
 *   - Under-cap text: pass-through, no marker injected.
 *   - Exact-cap text (length === cap): pass-through, no marker.
 *   - Over-cap single text block: leading warning + head + marker + tail;
 *     total length equals cap + warning/marker length; head/tail slice math
 *     is correct; warning contains the truncated-byte count and guidance.
 *   - Over-cap multiple text blocks: flattened into one block
 *     containing head + marker + tail (sourced from the
 *     newline-joined original).
 *   - Image blocks pass through untouched even when text triggers
 *     truncation; image position relative to remaining text block
 *     matches the original block order.
 *   - mcpResultToAgentResult composition: a giant `text` content
 *     entry coming from an MCP server gets truncated end-to-end.
 *   - The 60/40 head/tail ratio is honored.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

interface TextBlock {
  type: "text";
  text: string;
}
interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}
type ContentBlock = TextBlock | ImageBlock;

interface ToolBridgeModule {
  capTextContent: (blocks: ContentBlock[]) => ContentBlock[];
  mcpResultToAgentResult: (res: unknown) => {
    content: ContentBlock[];
    details: unknown;
  };
  MCP_TEXT_CAP_CHARS: number;
  MCP_TEXT_HEAD_RATIO: number;
  getMcpResultTruncationSettings: () => { enabled: boolean; maxChars: number };
  setMcpResultTruncationSettings: (settings: { enabled: boolean; maxChars: number }) => void;
  getMcpResultSpoolingSettings: () => {
    enabled: boolean;
    thresholdChars: number;
    directory: string;
    format: "json";
  };
  setMcpResultSpoolingSettings: (settings: {
    enabled: boolean;
    thresholdChars: number;
    directory: string;
    format: "json";
  }) => void;
  measureMcpResultTextChars: (res: unknown) => number;
  bridgeMcpTool: (opts: {
    serverName: string;
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
    getClient: () => unknown;
    spoolingContext?: { workspacePath: string };
  }) => {
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ) => Promise<{ content: ContentBlock[] }>;
  };
}

async function main(): Promise<void> {
  const mod = (await import(
    resolve(repoRoot, "packages/server/dist/mcp/tool-bridge.js")
  )) as unknown as ToolBridgeModule;
  const {
    capTextContent,
    mcpResultToAgentResult,
    MCP_TEXT_CAP_CHARS,
    MCP_TEXT_HEAD_RATIO,
    getMcpResultTruncationSettings,
    setMcpResultTruncationSettings,
    getMcpResultSpoolingSettings,
    setMcpResultSpoolingSettings,
    measureMcpResultTextChars,
    bridgeMcpTool,
  } = mod;

  const headLen = Math.floor(MCP_TEXT_CAP_CHARS * MCP_TEXT_HEAD_RATIO);
  const tailLen = MCP_TEXT_CAP_CHARS - headLen;

  console.log(`[test-mcp-truncation] cap=${MCP_TEXT_CAP_CHARS} head=${headLen} tail=${tailLen}`);

  // ---------- under-cap pass-through ----------
  {
    const blocks: ContentBlock[] = [{ type: "text", text: "hello world" }];
    const out = capTextContent(blocks);
    assert(
      "under-cap: returns same array reference (no allocation)",
      out === blocks,
      `got new array; len=${out.length}`,
    );
    assert("under-cap: text unchanged", out[0]?.type === "text" && out[0].text === "hello world");
  }

  // ---------- exact-cap pass-through ----------
  {
    const blocks: ContentBlock[] = [{ type: "text", text: "x".repeat(MCP_TEXT_CAP_CHARS) }];
    const out = capTextContent(blocks);
    assert("exact-cap: not truncated", out === blocks);
    assert(
      "exact-cap: length preserved",
      out[0]?.type === "text" && out[0].text.length === MCP_TEXT_CAP_CHARS,
    );
  }

  // ---------- over-cap single text block ----------
  {
    const oversize = MCP_TEXT_CAP_CHARS + 50_000;
    // Build a payload where head is all "A" and tail is all "Z" so we
    // can verify the slice ends are the originals, not a misaligned
    // window.
    const text = "A".repeat(headLen) + "M".repeat(50_000) + "Z".repeat(tailLen);
    assert("over-cap fixture: length math", text.length === oversize);
    const out = capTextContent([{ type: "text", text }]);
    assert("over-cap: returns 1 block", out.length === 1);
    assert("over-cap: still text type", out[0]?.type === "text");
    if (out[0]?.type === "text") {
      const t = out[0].text;
      assert(
        "over-cap: leading warning is first thing models see",
        t.startsWith("MCP_RESULT_TRUNCATED:"),
        `prefix=${t.slice(0, 80)}`,
      );
      assert(
        "over-cap: head preserved (all A's)",
        t.includes("\n\n" + "A".repeat(100)),
        `head sample not found; headLen=${headLen}`,
      );
      assert(
        "over-cap: tail preserved (all Z's)",
        t.endsWith("Z".repeat(tailLen)),
        `tail=...${t.slice(-16)} tailLen=${tailLen}`,
      );
      assert(
        "over-cap: middle 'M' run dropped",
        !t.includes("MMMM"),
        "marker fell INSIDE the original M run — slice math is off",
      );
      assert(
        "over-cap: warning contains machine-readable truncation marker",
        t.includes("MCP_RESULT_TRUNCATED"),
        `truncated text: ${t.slice(0, 200)}`,
      );
      assert(
        "over-cap: warning reports the omitted byte count",
        t.includes("50,000"),
        "expected 50,000 char count in marker",
      );
      assert("over-cap: warning says 'Next step'", t.includes("Next step:"));
      assert(
        "over-cap: warning says paginate/filter",
        t.includes("pagination") && t.includes("filter"),
      );
    }
  }

  // ---------- over-cap multiple text blocks ----------
  {
    const piece = "P".repeat(40_000);
    const blocks: ContentBlock[] = [
      { type: "text", text: piece },
      { type: "text", text: piece },
      { type: "text", text: piece },
      { type: "text", text: piece },
    ];
    const out = capTextContent(blocks);
    assert("multi-block: collapses to 1 text block", out.length === 1 && out[0]?.type === "text");
    if (out[0]?.type === "text") {
      const t = out[0].text;
      assert(
        "multi-block: total length is cap + warning/marker",
        t.length > MCP_TEXT_CAP_CHARS && t.length < MCP_TEXT_CAP_CHARS + 1000,
        `len=${t.length}, expected ~${MCP_TEXT_CAP_CHARS} + warning/marker`,
      );
      assert("multi-block: leading warning present", t.startsWith("MCP_RESULT_TRUNCATED:"));
      assert("multi-block: head still 'P's", t.includes("\n\n" + "P".repeat(100)));
      assert("multi-block: tail still 'P's", t.endsWith("P".repeat(100)));
    }
  }

  // ---------- image blocks pass through ----------
  {
    const imageA: ImageBlock = { type: "image", data: "iVBOR...A", mimeType: "image/png" };
    const imageB: ImageBlock = { type: "image", data: "iVBOR...B", mimeType: "image/png" };
    const blocks: ContentBlock[] = [
      imageA,
      { type: "text", text: "X".repeat(MCP_TEXT_CAP_CHARS + 1000) },
      imageB,
    ];
    const out = capTextContent(blocks);
    assert("images-with-truncation: image A position preserved (index 0)", out[0] === imageA);
    assert(
      "images-with-truncation: image B position preserved",
      out.some((b) => b === imageB),
    );
    const textBlocks = out.filter((b) => b.type === "text");
    assert("images-with-truncation: exactly one text block remains", textBlocks.length === 1);
    assert(
      "images-with-truncation: text block has truncation marker",
      textBlocks[0]?.type === "text" && textBlocks[0].text.includes("MCP_RESULT_TRUNCATED"),
    );
  }

  // ---------- under-cap with images ----------
  {
    const blocks: ContentBlock[] = [
      { type: "text", text: "small" },
      { type: "image", data: "abc", mimeType: "image/png" },
    ];
    const out = capTextContent(blocks);
    assert("under-cap with images: pass-through", out === blocks);
  }

  // ---------- end-to-end via mcpResultToAgentResult ----------
  {
    const oversize = MCP_TEXT_CAP_CHARS + 20_000;
    const mcpResult = {
      content: [{ type: "text", text: "Q".repeat(oversize) }],
      isError: false,
    };
    const out = mcpResultToAgentResult(mcpResult);
    assert("e2e: returns 1 content block", out.content.length === 1);
    if (out.content[0]?.type === "text") {
      const t = out.content[0].text;
      assert("e2e: under cap+marker overhead", t.length < MCP_TEXT_CAP_CHARS + 1000);
      assert("e2e: contains truncation marker", t.includes("MCP_RESULT_TRUNCATED"));
      assert("e2e: leading warning is first", t.startsWith("MCP_RESULT_TRUNCATED:"));
      assert("e2e: head is Q's", t.includes("\n\nQQQQQQ"));
      assert("e2e: tail is Q's", t.endsWith("QQQQQQ"));
    }
  }

  // ---------- isError preserved through truncation ----------
  {
    const oversize = MCP_TEXT_CAP_CHARS + 5_000;
    const mcpResult = {
      content: [{ type: "text", text: "boom! " + "B".repeat(oversize) }],
      isError: true,
    };
    const out = mcpResultToAgentResult(mcpResult);
    assert(
      "isError + oversize: truncation warning remains first and [error] is preserved in visible head",
      out.content[0]?.type === "text" &&
        out.content[0].text.startsWith("MCP_RESULT_TRUNCATED:") &&
        out.content[0].text.includes("[error]"),
    );
  }

  // ---------- settings: disable truncation ----------
  {
    setMcpResultTruncationSettings({ enabled: false, maxChars: MCP_TEXT_CAP_CHARS });
    const blocks: ContentBlock[] = [{ type: "text", text: "N".repeat(MCP_TEXT_CAP_CHARS + 1) }];
    const out = capTextContent(blocks);
    assert("settings disabled: pass-through", out === blocks);
  }

  // ---------- settings: custom cap ----------
  {
    const customCap = 120;
    setMcpResultTruncationSettings({ enabled: true, maxChars: customCap });
    const settings = getMcpResultTruncationSettings();
    assert(
      "settings custom cap: persisted in runtime",
      settings.enabled === true && settings.maxChars === customCap,
      JSON.stringify(settings),
    );
    const out = capTextContent([{ type: "text", text: "C".repeat(500) }]);
    assert("settings custom cap: truncates", out[0]?.type === "text");
    if (out[0]?.type === "text") {
      assert(
        "settings custom cap: under cap+marker overhead",
        out[0].text.length > customCap && out[0].text.length < customCap + 1000,
        `len=${out[0].text.length}`,
      );
    }
  }
  setMcpResultTruncationSettings({ enabled: true, maxChars: MCP_TEXT_CAP_CHARS });

  // ---------- spooling: disabled preserves truncation ----------
  {
    const workspace = await mkdtemp(join(tmpdir(), "pi-forge-mcp-spool-disabled-"));
    try {
      setMcpResultSpoolingSettings({
        enabled: false,
        thresholdChars: 100,
        directory: ".mcp-results",
        format: "json",
      });
      const tool = bridgeMcpTool({
        serverName: "srv",
        toolName: "disabled",
        description: "",
        inputSchema: { type: "object", properties: {} },
        getClient: () => ({
          callTool: async () => ({ content: [{ type: "text", text: "D".repeat(50_000) }] }),
        }),
        spoolingContext: { workspacePath: workspace },
      });
      const out = await tool.execute("call-disabled", {});
      const text = out.content[0]?.type === "text" ? out.content[0].text : "";
      assert(
        "spooling disabled: truncation still applies",
        text.startsWith("MCP_RESULT_TRUNCATED:") && !text.includes("MCP_RESULT_SPOOLED"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  // ---------- spooling: below threshold remains inline ----------
  {
    const workspace = await mkdtemp(join(tmpdir(), "pi-forge-mcp-spool-small-"));
    try {
      setMcpResultSpoolingSettings({
        enabled: true,
        thresholdChars: 100,
        directory: ".mcp-results",
        format: "json",
      });
      const tool = bridgeMcpTool({
        serverName: "srv",
        toolName: "small",
        description: "",
        inputSchema: { type: "object", properties: {} },
        getClient: () => ({
          callTool: async () => ({ content: [{ type: "text", text: "short result" }] }),
        }),
        spoolingContext: { workspacePath: workspace },
      });
      const out = await tool.execute("call-1", {});
      assert(
        "spooling below threshold: stays inline",
        out.content[0]?.type === "text" && out.content[0].text === "short result",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  // ---------- spooling: above threshold writes complete raw JSON ----------
  {
    const workspace = await mkdtemp(join(tmpdir(), "pi-forge-mcp-spool-large-"));
    try {
      const fullText = "L".repeat(240);
      setMcpResultSpoolingSettings({
        enabled: true,
        thresholdChars: 100,
        directory: ".mcp-results",
        format: "json",
      });
      const tool = bridgeMcpTool({
        serverName: "server/name",
        toolName: "tool name",
        description: "",
        inputSchema: { type: "object", properties: {} },
        getClient: () => ({
          callTool: async () => ({
            content: [
              { type: "text", text: fullText },
              { type: "image", data: "base64-image", mimeType: "image/png" },
            ],
            structuredContent: { count: 1 },
          }),
        }),
        spoolingContext: { workspacePath: workspace },
      });
      const out = await tool.execute("call-2", {});
      const summary = out.content[0]?.type === "text" ? out.content[0].text : "";
      const pathMatch = /^Path: (.+)$/m.exec(summary);
      assert(
        "spooling above threshold: summary returned",
        summary.startsWith("MCP_RESULT_SPOOLED:"),
      );
      assert("spooling above threshold: path included", pathMatch !== null, summary.slice(0, 300));
      assert("spooling above threshold: image data not inline", !summary.includes("base64-image"));
      if (pathMatch?.[1] !== undefined) {
        const stored = await readFile(join(workspace, pathMatch[1]), "utf8");
        assert("spooling above threshold: writes raw text", stored.includes(fullText));
        assert("spooling above threshold: preserves image JSON", stored.includes("base64-image"));
        assert(
          "spooling above threshold: path is in configured dir",
          pathMatch[1].startsWith(".mcp-results/"),
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  // ---------- spooling: invalid directory falls back to truncation ----------
  {
    const workspace = await mkdtemp(join(tmpdir(), "pi-forge-mcp-spool-invalid-"));
    try {
      setMcpResultSpoolingSettings({
        enabled: true,
        thresholdChars: 100,
        directory: "../escape",
        format: "json",
      });
      const tool = bridgeMcpTool({
        serverName: "srv",
        toolName: "escape",
        description: "",
        inputSchema: { type: "object", properties: {} },
        getClient: () => ({
          callTool: async () => ({ content: [{ type: "text", text: "E".repeat(50_000) }] }),
        }),
        spoolingContext: { workspacePath: workspace },
      });
      const out = await tool.execute("call-3", {});
      const text = out.content[0]?.type === "text" ? out.content[0].text : "";
      assert("spooling invalid dir: warning returned", text.startsWith("MCP_RESULT_SPOOL_FAILED:"));
      assert(
        "spooling invalid dir: truncation still applies",
        text.includes("MCP_RESULT_TRUNCATED"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  // ---------- spooling: isError bypasses spooling ----------
  {
    const workspace = await mkdtemp(join(tmpdir(), "pi-forge-mcp-spool-error-"));
    try {
      setMcpResultSpoolingSettings({
        enabled: true,
        thresholdChars: 100,
        directory: ".mcp-results",
        format: "json",
      });
      const tool = bridgeMcpTool({
        serverName: "srv",
        toolName: "error",
        description: "",
        inputSchema: { type: "object", properties: {} },
        getClient: () => ({
          callTool: async () => ({
            content: [{ type: "text", text: "boom " + "B".repeat(500) }],
            isError: true,
          }),
        }),
        spoolingContext: { workspacePath: workspace },
      });
      const out = await tool.execute("call-4", {});
      const text = out.content[0]?.type === "text" ? out.content[0].text : "";
      assert(
        "spooling isError: stays inline",
        text.includes("[error]") && !text.includes("MCP_RESULT_SPOOLED"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  // ---------- spooling settings + measurement ----------
  {
    const settings = getMcpResultSpoolingSettings();
    assert(
      "spooling settings: persisted in runtime",
      settings.enabled === true && settings.thresholdChars === 100 && settings.format === "json",
      JSON.stringify(settings),
    );
    assert(
      "measurement: sums text content",
      measureMcpResultTextChars({
        content: [
          { type: "text", text: "abc" },
          { type: "text", text: "defg" },
        ],
      }) === 7,
    );
    assert(
      "measurement: structured-only content is measured untruncated",
      measureMcpResultTextChars({ structuredContent: { data: "S".repeat(20_000) } }) > 20_000,
    );
  }
  setMcpResultSpoolingSettings({
    enabled: true,
    thresholdChars: MCP_TEXT_CAP_CHARS,
    directory: ".mcp-results",
    format: "json",
  });

  // ---------- 60/40 head/tail ratio honored ----------
  {
    assert(
      "ratio: head is 60% of cap",
      headLen === Math.floor(MCP_TEXT_CAP_CHARS * 0.6),
      `headLen=${headLen}`,
    );
    assert("ratio: head + tail = cap", headLen + tailLen === MCP_TEXT_CAP_CHARS);
  }

  console.log(
    failures === 0
      ? "\n[test-mcp-truncation] PASS"
      : `\n[test-mcp-truncation] FAIL — ${failures} assertion(s) failed`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[test-mcp-truncation] uncaught error:", err);
  process.exit(1);
});
