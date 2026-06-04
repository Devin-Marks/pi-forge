import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { ConversionError, convertAttachment, pickConverter } from "../attachment-converters.js";
import { config } from "../config.js";
import { formatErrorChain } from "../diagnostics.js";
import { expandFileReferences, languageHintForPath } from "../file-references.js";
import {
  ExternalSubagentActiveError,
  findSessionLocation,
  getSession,
  listSessionsForProject,
  maybeNameSessionFromFirstPrompt,
  rejectOrDisposeExternallyActiveSession,
  type LiveSession,
} from "../session-registry.js";
import { errorSchema } from "./_schemas.js";
import { getExternalSubagentStatusForSession } from "../subagents-external.js";

/**
 * Prompt route. Per CLAUDE.md "Pi SDK Key Facts": session.prompt() is async
 * but only resolves after the entire agent run finishes (including retries
 * and compaction). Routes MUST NOT await it — call without await and return
 * 202 immediately. Output streams over SSE.
 *
 * Phase 14: also accepts multipart/form-data with attachments. The route's
 * declared `body` schema covers ONLY the JSON path; the multipart path is
 * detected by content-type and parsed inline below (Fastify's schema
 * validation is skipped for multipart — there is no JSON body to validate).
 */

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES_PER_PROMPT = 4;
const MAX_TEXT_FILES_PER_PROMPT = 4;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * MIME types we'll trust as text without sniffing (the browser said
 * so explicitly). `text/*` covers the obvious cases; the
 * `application/*` allowlist below covers code/data formats whose
 * canonical MIME starts with `application/` even though the bytes
 * are UTF-8 text.
 */
const TEXT_APPLICATION_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
  "application/sql",
  "application/x-sh",
  "application/toml",
  "application/x-httpd-php",
]);

function looksLikeTextMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (TEXT_APPLICATION_MIME_TYPES.has(mime)) return true;
  // `+json` / `+xml` suffixes (RFC 6839): application/foo+json, etc.
  if (mime.endsWith("+json") || mime.endsWith("+xml") || mime.endsWith("+yaml")) return true;
  return false;
}

/**
 * Heuristic binary sniff: scan the first chunk of the buffer for NUL
 * bytes. UTF-8 text files essentially never contain `\x00`; binary
 * formats (PDFs, Office docs, Visio, images, executables) almost
 * always do, usually within the first few hundred bytes.
 *
 * 8 KB sample is enough to reliably catch every real-world binary
 * format we care about and cheap enough to run on every upload.
 */
function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.byteLength, 8 * 1024);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
interface ParsedImage {
  /** Base64-encoded image data (no data URL prefix). */
  base64: string;
  mimeType: string;
}

interface ParsedTextFile {
  filename: string;
  content: string;
}

interface ParsedMultipart {
  text: string;
  streamingBehavior?: "steer" | "followUp";
  images: ParsedImage[];
  textFiles: ParsedTextFile[];
}

/**
 * Read a multipart upload off the request, validating limits inline.
 * Returns either the parsed shape or the error code+message the caller
 * should send as 400.
 */
async function parseMultipart(
  req: FastifyRequest,
): Promise<ParsedMultipart | { error: string; message: string }> {
  let text: string | undefined;
  let streamingBehavior: "steer" | "followUp" | undefined;
  const images: ParsedImage[] = [];
  const textFiles: ParsedTextFile[] = [];

  // No-op drain helper. The previous implementation called
  // `req.raw.destroy()` to abort the upload on early-error paths and
  // free in-flight buffers. That's harmful on HTTP/1.1 keep-alive (the
  // dev server's default): browsers commonly reuse one TCP connection
  // for multiple requests including the long-lived SSE stream.
  // Destroying the raw socket killed the SSE alongside the POST,
  // producing a "Reconnecting" banner in chat right after submitting a
  // prompt with an attachment. Fastify will close the request normally
  // once we send the response; the worst-case bandwidth waste from
  // not pre-aborting is bounded by the multipart `bodyLimit`.
  const drain = (): void => {
    // intentionally no-op — see comment above
  };

  for await (const part of req.parts()) {
    if (part.type === "field") {
      if (part.fieldname === "text") {
        text = typeof part.value === "string" ? part.value : "";
      } else if (part.fieldname === "streamingBehavior") {
        if (part.value === "steer" || part.value === "followUp") {
          streamingBehavior = part.value;
        }
      }
      // Unknown fields are ignored (forwards-compatible).
      continue;
    }
    // File part. Reading the buffer counts against the multipart
    // size limit; @fastify/multipart's `truncated` flag flips when
    // the file exceeded `limits.fileSize`.
    const file = part;
    const buf = await file.toBuffer();
    if (file.file.truncated) {
      drain();
      return {
        error: "attachment_too_large",
        message: `Attachment "${file.filename}" exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MB per-file limit.`,
      };
    }
    const mime = (file.mimetype ?? "application/octet-stream").toLowerCase();
    if (IMAGE_MIME_TYPES.has(mime)) {
      if (images.length >= MAX_IMAGES_PER_PROMPT) {
        drain();
        return {
          error: "too_many_images",
          message: `Up to ${MAX_IMAGES_PER_PROMPT} images per prompt; got more.`,
        };
      }
      images.push({ base64: buf.toString("base64"), mimeType: mime });
      continue;
    }
    // Anything that isn't an image: decide between "text we can inline
    // as a fenced block" and "binary we can't do anything useful with."
    //
    // Two-step decision:
    //   1. If the browser declared a text-shaped MIME, trust it and
    //      treat as text.
    //   2. Otherwise (typically `application/octet-stream` for files
    //      with unknown extensions like `.tsx` from some browsers),
    //      sniff for NUL bytes. No NUL in the first 8 KB → text;
    //      NUL present → binary, reject with a clear error so the
    //      user knows their PDF/Visio/Word/etc. didn't go anywhere.
    //
    // Without this check, a binary upload was being best-effort UTF-8
    // decoded into garbled noise + U+FFFD replacement chars and
    // prepended to the prompt, which broke the session (model errors,
    // hallucinations, blown context budget).
    const filename = file.filename ?? "attachment";

    // Office-format conversion. PDF / DOCX / XLSX dispatch to a pure-JS
    // converter that yields plain text the model can read. Done before
    // the binary-reject branch so these formats land here even though
    // their bytes contain NUL.
    const converter = pickConverter(filename, mime);
    if (converter !== undefined) {
      if (textFiles.length >= MAX_TEXT_FILES_PER_PROMPT) {
        drain();
        return {
          error: "too_many_text_files",
          message: `Up to ${MAX_TEXT_FILES_PER_PROMPT} text attachments per prompt; got more.`,
        };
      }
      try {
        const content = await convertAttachment(converter, filename, buf);
        textFiles.push({ filename, content });
      } catch (err) {
        drain();
        const message =
          err instanceof ConversionError
            ? err.message
            : `Failed to convert "${filename}": ${(err as Error).message}`;
        return { error: "conversion_failed", message };
      }
      continue;
    }

    if (!looksLikeTextMime(mime) && looksBinary(buf)) {
      drain();
      return {
        error: "unsupported_attachment_type",
        message: `Attachment "${filename}" appears to be binary (${mime}). Only text files and images (PNG/JPEG/GIF/WebP) are supported — convert it first or attach a text/markdown export.`,
      };
    }
    if (textFiles.length >= MAX_TEXT_FILES_PER_PROMPT) {
      drain();
      return {
        error: "too_many_text_files",
        message: `Up to ${MAX_TEXT_FILES_PER_PROMPT} text attachments per prompt; got more.`,
      };
    }
    // Whole file goes into the prompt. The per-file size cap
    // (MAX_FILE_BYTES) is the only upper bound — it exists for
    // memory-pressure reasons during multipart parsing, not LLM
    // context. If the composed prompt exceeds the model's context
    // window, the provider returns a clean error and the user sees
    // it in their chat — no value in pre-truncating to a guess of
    // what "fits."
    textFiles.push({
      filename,
      content: buf.toString("utf8"),
    });
  }

  if (text === undefined || text.length === 0) {
    return { error: "missing_text", message: "Prompt text is required." };
  }
  const result: ParsedMultipart = { text, images, textFiles };
  if (streamingBehavior !== undefined) result.streamingBehavior = streamingBehavior;
  return result;
}

/**
 * Compose the final prompt text by prepending each text-file
 * attachment as a fenced code block. Mirrors what most agent UIs
 * produce when a file is dragged in: the LLM sees the filename as
 * the language hint and the content directly below.
 *
 * Fence-break safety: a file whose content contains ``` would
 * terminate a 3-backtick fence early and let its bytes leak out as
 * "user prompt", which a hostile shared file could exploit to inject
 * arbitrary instructions to the LLM. The CommonMark fenced-block
 * rule says the closing fence must be at least as long as the
 * opener, so we pick a fence one backtick longer than the longest
 * run inside the content. Filename is also sanitized — any
 * backtick/newline in it is collapsed so the opening fence line
 * itself can't be hijacked.
 */
function pickFence(content: string): string {
  // Longest run of consecutive backticks in `content` — we need to
  // open with one MORE than that.
  let max = 0;
  let cur = 0;
  for (const ch of content) {
    if (ch === "`") {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return "`".repeat(Math.max(3, max + 1));
}

function sanitizeFilename(name: string): string {
  // Strip backticks and newlines so neither breaks the opener line.
  // Leave the rest intact — the LLM uses this as a language hint /
  // identifier, so extension + path readability matter.
  return name.replace(/[`\r\n]/g, "_");
}

function composePromptText(parsed: ParsedMultipart): string {
  if (parsed.textFiles.length === 0) return parsed.text;
  // Match the format `expandFileReferences` uses for `@<path>` blocks
  // — `\`\`\`<lang> file: <name>\n...\n\`\`\`` — so the chat-bubble
  // renderer's `extractFileRefs` regex picks both up the same way and
  // both render as collapsible badges instead of raw fenced text.
  const blocks = parsed.textFiles.map((f) => {
    const fence = pickFence(f.content);
    const safeName = sanitizeFilename(f.filename);
    const lang = languageHintForPath(safeName);
    return `${fence}${lang} file: ${safeName}\n${f.content}\n${fence}`;
  });
  return blocks.join("\n\n") + "\n\n" + parsed.text;
}

/**
 * Pre-flight checks shared by the JSON + multipart paths. On a check
 * failure, sends the 4xx via `reply` AND returns undefined — caller
 * MUST `return reply;` immediately to avoid double-send. The reply
 * sends are awaited for clean ordering of any onSend hooks (security
 * headers etc.) before the route handler proceeds.
 */
async function preflight(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<LiveSession | undefined> {
  const sessionId = (req.params as { id: string }).id;
  const live = getSession(sessionId);
  if (live !== undefined) {
    try {
      await rejectOrDisposeExternallyActiveSession(sessionId, live.projectId, live.workspacePath);
    } catch (err) {
      if (err instanceof ExternalSubagentActiveError) {
        await reply.code(409).send({
          error: "external_subagent_active",
          message:
            "This pi-subagents child is still running externally and is read-only in pi-forge.",
        });
        return undefined;
      }
      throw err;
    }
  }
  if (live === undefined) {
    const loc = await findSessionLocation(sessionId);
    if (loc !== undefined) {
      const match = (await listSessionsForProject(loc.projectId, loc.workspacePath)).find(
        (s) => s.sessionId === sessionId,
      );
      const external = await getExternalSubagentStatusForSession({
        runId: match?.runId,
        path: match?.path,
      });
      if (external?.isExternalLive === true) {
        await reply.code(409).send({
          error: "external_subagent_active",
          message:
            "This pi-subagents child is still running externally and is read-only in pi-forge.",
        });
        return undefined;
      }
    }
    await reply
      .code(404)
      .send({ error: "session_not_found", message: "no live session with that id" });
    return undefined;
  }
  const model = live.session.model;
  if (model === undefined) {
    await reply.code(400).send({
      error: "no_model_configured",
      message: "no model is configured for this session",
    });
    return undefined;
  }
  if (!live.session.modelRegistry.hasConfiguredAuth(model)) {
    await reply.code(400).send({
      error: "no_api_key",
      message: `No API key configured for provider "${model.provider}". Add one via PUT /api/v1/config/auth/${model.provider}.`,
    });
    return undefined;
  }
  return live;
}

export const promptRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { id: string };
    Body: { text: string; streamingBehavior?: "steer" | "followUp" };
  }>(
    "/sessions/:id/prompt",
    {
      config: {
        // Cost cap: each prompt costs LLM tokens. The default of 60/min is
        // far above interactive use; a leaked-token loop hits the cap fast.
        // Tune via RATE_LIMIT_PROMPT_*.
        rateLimit: {
          max: config.rateLimits.promptMax,
          timeWindow: config.rateLimits.promptWindowMs,
        },
      },
      schema: {
        description:
          "Send a prompt to the session. Returns 202 immediately; the agent " +
          "response streams over GET /sessions/:id/stream.\n\n" +
          "Two body shapes:\n" +
          "  - application/json: { text, streamingBehavior? }\n" +
          "  - multipart/form-data: `text` field, optional `streamingBehavior` field, " +
          "    `attachments[]` files. Image attachments (PNG/JPEG/GIF/WEBP, max 4) " +
          "    pass into model context; non-image text files are prepended to the " +
          "    prompt as fenced code blocks. 20 MB per-file cap. Whole-file content " +
          "    is sent — if the assembled prompt exceeds the model's context window, " +
          "    the provider returns a clean error.",
        tags: ["sessions"],
        consumes: ["application/json", "multipart/form-data"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1 },
            streamingBehavior: { type: "string", enum: ["steer", "followUp"] },
          },
        },
        response: {
          202: {
            type: "object",
            required: ["accepted"],
            properties: { accepted: { type: "boolean", const: true } },
          },
          400: errorSchema,
          404: errorSchema,
        },
      },
      // The framework's body parser bypasses fastify schema validation
      // when the request is multipart, so this is purely informational
      // for OpenAPI consumers. Multipart parsing happens inside the
      // handler via `req.parts()`.
      attachValidation: true,
    },
    async (req, reply) => {
      const isMultipart = req.isMultipart();
      // Plain JSON path: validation already ran via schema.body.
      // Surface validation errors as 400 with the standard shape.
      if (!isMultipart && req.validationError !== undefined) {
        return reply.code(400).send({
          error: "invalid_body",
          message: req.validationError.message,
        });
      }

      const live = await preflight(req, reply);
      if (live === undefined) return reply;

      let promptText: string;
      let titleSourceText: string;
      let streamingBehavior: "steer" | "followUp" | undefined;
      let images: ParsedImage[] = [];

      if (isMultipart) {
        let parsed: ParsedMultipart | { error: string; message: string };
        try {
          parsed = await parseMultipart(req);
        } catch (err) {
          // @fastify/multipart throws typed errors when the multipart
          // limits we registered are exceeded (FilesLimitError,
          // FieldsLimitError, PartsLimitError, RequestFileTooLargeError
          // when throwFileSizeLimit:true). Map them to 400 with a
          // typed code instead of letting Fastify render generic
          // 500/413 responses.
          const errCode = (err as { code?: string }).code ?? "";
          if (errCode === "FST_FILES_LIMIT") {
            return reply.code(400).send({
              error: "too_many_files",
              message: "Too many attachments in one request.",
            });
          }
          if (errCode === "FST_REQ_FILE_TOO_LARGE") {
            return reply.code(400).send({
              error: "attachment_too_large",
              message: `Attachment exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MB per-file limit.`,
            });
          }
          if (errCode === "FST_FIELDS_LIMIT" || errCode === "FST_PARTS_LIMIT") {
            return reply.code(400).send({
              error: "too_many_parts",
              message: "Too many fields or parts in the multipart request.",
            });
          }
          throw err;
        }
        if ("error" in parsed) {
          return reply.code(400).send(parsed);
        }
        titleSourceText = parsed.text;
        promptText = composePromptText(parsed);
        streamingBehavior = parsed.streamingBehavior;
        images = parsed.images;
      } else {
        titleSourceText = req.body.text;
        promptText = req.body.text;
        streamingBehavior = req.body.streamingBehavior;
      }

      // Expand `@<path>` file references inline (the chat input's
      // `@`-autocomplete inserts these markers; server-side
      // expansion keeps the LLM context as the source of truth and
      // matches how attachments work). A path that doesn't resolve
      // to a real file inside the workspace passes through untouched
      // — see file-references.ts for the rules.
      promptText = await expandFileReferences(promptText, live.workspacePath);

      // Name a brand-new, still-generic session from the user's first
      // prompt before the agent run starts. This is deterministic (no
      // extra LLM call), best-effort, and uses the user's typed text
      // rather than expanded @file blocks / attachment bodies so large
      // context blobs do not dominate the tab title.
      maybeNameSessionFromFirstPrompt(live, titleSourceText);

      // No app-level composed-prompt cap: per-file size limits
      // already prevent runaway memory pressure during multipart
      // parsing, and if the assembled prompt genuinely exceeds the
      // model's context window the provider returns a clean error
      // that surfaces to the client over SSE — no value in pre-
      // rejecting based on a guess of what "fits."
      const promptBytes = Buffer.byteLength(promptText, "utf8");

      const opts: Parameters<typeof live.session.prompt>[1] = {};
      if (streamingBehavior !== undefined) opts.streamingBehavior = streamingBehavior;
      if (images.length > 0) {
        // The SDK's ImageContent.data is RAW base64 (no `data:` prefix);
        // each provider builds its own data URL via
        // `data:${mimeType};base64,${data}` when needed. Don't pre-
        // build the URL or providers double-prefix and break.
        opts.images = images.map((img) => ({
          type: "image" as const,
          data: img.base64,
          mimeType: img.mimeType,
        }));
      }

      // Fire-and-forget. Pre-flight already covered the common synchronous
      // failure modes; remaining rejections are LLM/network errors that
      // surface to the client as agent_end with errorMessage over SSE.
      //
      // The SDK's normal flow emits `agent_end` itself when a turn
      // completes (success or SDK-tracked error). But certain failure
      // modes — e.g. provider rejected the request synchronously,
      // network down, malformed prompt — reject session.prompt() WITHOUT
      // ever firing agent_start / agent_end. Connected SSE clients then
      // sit on a "thinking…" spinner forever and the chat input stays
      // disabled. To recover, we synthesize a terminal `agent_end`
      // (with errorMessage) into the live session's fan-out so the
      // browser releases the spinner and surfaces the error in chat.
      const synthesizeFailureEvent = (err: unknown): void => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        for (const client of live.clients) {
          try {
            client.send({
              type: "agent_end",
              sessionId: req.params.id,
              errorMessage,
            });
          } catch {
            // a single client send-failure shouldn't stop fan-out
          }
        }
      };

      // Operator-visible breadcrumb. Without this, a hung prompt
      // (where the SDK is silently retrying or the LLM provider is
      // not responding) is invisible to operators reading
      // `docker logs`. Pino redacts the prompt body itself; the byte
      // count is the safe diagnostic to emit.
      const activeModel = live.session.model;
      const isCodexPrompt = activeModel?.provider === "openai-codex";
      process.stderr.write(
        `${JSON.stringify({
          level: "info",
          time: new Date().toISOString(),
          msg: "session.prompt invoked",
          sessionId: req.params.id,
          promptBytes,
          imageCount: images.length,
          streamingBehavior,
          provider: isCodexPrompt ? activeModel?.provider : undefined,
          modelId: isCodexPrompt ? activeModel?.id : undefined,
        })}\n`,
      );

      try {
        live.session.prompt(promptText, opts).catch((err: unknown) => {
          const f = formatErrorChain(err);
          process.stderr.write(
            `${JSON.stringify({
              level: "warn",
              time: new Date().toISOString(),
              msg: "session.prompt rejected",
              sessionId: req.params.id,
              provider: isCodexPrompt ? activeModel?.provider : undefined,
              modelId: isCodexPrompt ? activeModel?.id : undefined,
              error: f.message,
              chain: f.chain,
              stack: f.stack,
            })}\n`,
          );
          synthesizeFailureEvent(err);
        });
      } catch (err) {
        fastify.log.warn(
          { err: err instanceof Error ? err.message : String(err), sessionId: req.params.id },
          "session.prompt threw synchronously",
        );
        synthesizeFailureEvent(err);
      }
      return reply.code(202).send({ accepted: true });
    },
  );
};
