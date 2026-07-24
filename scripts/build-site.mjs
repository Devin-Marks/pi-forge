#!/usr/bin/env node
//
// Build the GitHub Pages site under docs/site/ from the project's
// markdown sources.
//
// Why a build step at all (vs hand-writing the HTML, like multiplex):
//   - The .md files in docs/ are the canonical source — they live next
//     to the code, get updated in normal PRs, and are read by humans
//     in the GitHub repo browser. Keeping a parallel HTML copy in
//     sync by hand would silently rot.
//   - GitHub Pages can run Jekyll, but Jekyll's frontmatter + layouts
//     model fights this repo's "docs are real markdown that github
//     renders sensibly" posture. A one-shot build that emits plain
//     HTML keeps both surfaces honest.
//
// What it does:
//   - Walks `SOURCES` (each entry maps a .md → an output html), runs
//     `marked` over the markdown body, drops the result inside the
//     CHROME template (sidebar + header), and writes to
//     `docs/site/docs/<slug>.html`.
//   - Writes index.html separately from the LANDING template — the
//     landing page is hand-curated marketing copy, not a converted
//     doc.
//
// Run: `npm run build:site` (or `node scripts/build-site.mjs` once
// `marked` is installed). The output goes into docs/site/, which the
// `Deploy to GitHub Pages` workflow uploads as the Pages artifact.
//
// Dependencies: just `marked`. Installed as a devDep so the
// production install doesn't pull it.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const siteRoot = join(repoRoot, "docs", "site");
const docsOut = join(siteRoot, "docs");

mkdirSync(docsOut, { recursive: true });

// Sidebar entries — drives the docs nav order. Order = visual order
// in the sidebar.
const SOURCES = [
  {
    src: "docs/architecture.md",
    out: "architecture.html",
    title: "Architecture",
    subtitle: "How requests flow from the browser through the server to the pi SDK.",
  },
  {
    src: "docs/configuration.md",
    out: "configuration.html",
    title: "Configuration",
    subtitle: "CLI flags, env vars, Pi SDK config files, per-project overrides.",
  },
  {
    src: "docs/containers.md",
    out: "containers.html",
    title: "Containers",
    subtitle: "What's inside the Docker image, how it's structured, and why.",
  },
  {
    src: "docs/agent-tool-sandbox.md",
    out: "agent-tool-sandbox.html",
    title: "Agent Tool Sandbox",
    subtitle: "Optional UID/GID split, path policy, mount permissions, and verification.",
  },
  {
    src: "docs/deployment.md",
    out: "deployment.html",
    title: "Deployment",
    subtitle: "Production deploys — TLS, reverse proxies, auth, backups.",
  },
  {
    src: "docs/mobile.md",
    out: "mobile.html",
    title: "Mobile",
    subtitle: "Mobile-tuned chat surface and PWA install on iOS / Android.",
  },
  {
    src: "docs/api-examples.md",
    out: "api.html",
    title: "API Examples",
    subtitle: "End-to-end scripting recipes against the REST + SSE surface.",
  },
  {
    src: "docs/mcp.md",
    out: "mcp.html",
    title: "MCP Servers",
    subtitle: "Remote and stdio Model Context Protocol servers, with per-project trust.",
  },
  {
    src: "docs/webhooks.md",
    out: "webhooks.html",
    title: "Webhooks",
    subtitle:
      "HTTPS POST deliveries on agent and session events. HMAC signing, retry, delivery history.",
  },
  {
    src: "docs/orchestration.md",
    out: "orchestration.html",
    title: "Session Orchestration",
    subtitle:
      "Supervisor sessions that spawn, observe, and coordinate worker sessions in the same project.",
  },
  {
    src: "docs/processes.md",
    out: "processes.html",
    title: "Background Processes",
    subtitle: "The process tool — long-running processes the agent manages across turns.",
  },
  {
    src: "docs/todo.md",
    out: "todo.html",
    title: "Todo Tool",
    subtitle: "Browser-native todo tool — session-scoped task list with live UI panel.",
  },
  {
    src: "docs/ask-user-question.md",
    out: "ask-user-question.html",
    title: "Ask User Question",
    subtitle: "Browser-native ask_user_question tool — structured questionnaires from the agent.",
  },
  {
    src: "docs/quick-actions.md",
    out: "quick-actions.html",
    title: "Quick Actions",
    subtitle: "Operator-defined chat-toolbar chips for shell commands and prompt templates.",
  },
  {
    src: "docs/sse-events.md",
    out: "sse-events.html",
    title: "SSE Events",
    subtitle: "The agent event stream — every event type, payload, and UI affordance.",
  },
];

// Marked instance with GFM enabled (tables, strikethrough, autolinks
// — same dialect ChatMarkdown uses in the app for consistency).
const marked = new Marked({ gfm: true, breaks: false });

// Add target=_blank to external links via a renderer override —
// internal anchors (#section) and relative links shouldn't get it.
// Keep repository Markdown links intact while emitting the Pages URL for
// the extension-notification reference in the generated configuration page.
const SITE_HREFS = new Map([
  ["./sse-events.md#extension-ui-notifications", "./sse-events.html#extension-ui-notifications"],
]);
const SITE_HEADING_IDS = new Map([["Extension UI notifications", "extension-ui-notifications"]]);

const renderer = {
  heading(token) {
    const id = SITE_HEADING_IDS.get(token.text);
    const idAttr = id ? ` id="${id}"` : "";
    return `<h${token.depth}${idAttr}>${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
  },
  link(token) {
    const href = SITE_HREFS.get(token.href) ?? token.href;
    const text = this.parser.parseInline(token.tokens);
    const isExternal = /^https?:/i.test(href);
    const attrs = isExternal ? ` target="_blank" rel="noopener noreferrer"` : "";
    const titleAttr = token.title ? ` title="${escapeAttr(token.title)}"` : "";
    return `<a href="${escapeAttr(href)}"${attrs}${titleAttr}>${text}</a>`;
  },
};
marked.use({ renderer });

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// Inline SVG logo — mirrors the project's `<π>` icon (docs/images/icon.png).
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <rect x="1" y="1" width="30" height="30" rx="7" fill="#0d0d10"/>
  <path d="M9 11 L6 16 L9 21" stroke="#10b981" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M23 11 L26 16 L23 21" stroke="#10b981" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M12 13 H20 M14 13 V21 M18 13 V21" stroke="#e6e7eb" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

// Sidebar HTML, with the active-page link highlighted.
function sidebar(activeOut) {
  const links = SOURCES.map((s) => {
    const cls = s.out === activeOut ? ' class="active"' : "";
    return `        <a href="${s.out}"${cls}>${s.title}</a>`;
  }).join("\n");
  return `      <div class="sidebar-section">
        <h4>Documentation</h4>
${links}
      </div>`;
}

const HEADER_NAV = `      <nav class="nav-links" id="navLinks">
        <a href="../index.html#features">Features</a>
        <a href="../index.html#quickstart">Quick Start</a>
        <a href="architecture.html">Docs</a>
        <a href="https://github.com/Devin-Marks/pi-forge" class="nav-cta">GitHub</a>
      </nav>`;

const HEADER_NAV_LANDING = `      <nav class="nav-links" id="navLinks">
        <a href="#features">Features</a>
        <a href="#quickstart">Quick Start</a>
        <a href="docs/architecture.html">Docs</a>
        <a href="https://github.com/Devin-Marks/pi-forge" class="nav-cta">GitHub</a>
      </nav>`;

function chromeDocs({ title, subtitle, body, activeOut }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — pi-forge</title>
  <meta name="description" content="${escapeAttr(subtitle)}">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='1' y='1' width='30' height='30' rx='7' fill='%230d0d10'/><path d='M12 13 H20 M14 13 V21 M18 13 V21' stroke='%23e6e7eb' stroke-width='1.6' stroke-linecap='round' fill='none'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../style.css">
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a href="../index.html" class="logo">
        ${LOGO_SVG}
        pi-forge
      </a>
${HEADER_NAV}
      <button class="mobile-toggle" id="mobileToggle" aria-label="Toggle menu">&#9776;</button>
    </div>
  </header>

  <div class="docs-layout">
    <aside class="docs-sidebar" id="docsSidebar">
${sidebar(activeOut)}
      <div class="sidebar-section">
        <h4>Project</h4>
        <a href="https://github.com/Devin-Marks/pi-forge">GitHub</a>
        <a href="https://github.com/Devin-Marks/pi-forge/blob/main/CHANGELOG.md">Changelog</a>
        <a href="https://github.com/Devin-Marks/pi-forge/blob/main/SECURITY.md">Security</a>
      </div>
    </aside>

    <main class="docs-main">
      <h1>${title}</h1>
      <p class="docs-subtitle">${subtitle}</p>
${body}
    </main>
  </div>

  <button class="sidebar-toggle" id="sidebarToggle" aria-label="Toggle sidebar">&#9776;</button>

  <script>
    document.getElementById('mobileToggle').addEventListener('click', () => {
      document.getElementById('navLinks').classList.toggle('open');
    });
    document.getElementById('sidebarToggle').addEventListener('click', () => {
      document.getElementById('docsSidebar').classList.toggle('open');
    });
  </script>
</body>
</html>
`;
}

// Strip the first H1 from a converted doc — `docs/*.md` files start
// with their title, but the chrome template already prints the title.
// Without this we get a duplicate heading on every doc page.
function stripLeadingH1(html) {
  return html.replace(/^\s*<h1[^>]*>[^<]*<\/h1>\s*/i, "");
}

let count = 0;
for (const { src, out, title, subtitle } of SOURCES) {
  const md = readFileSync(join(repoRoot, src), "utf8");
  const body = stripLeadingH1(marked.parse(md));
  const html = chromeDocs({ title, subtitle, body, activeOut: out });
  writeFileSync(join(docsOut, out), html);
  count += 1;
}

// ---- index.html (landing) ----
const LANDING = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>pi-forge — Browser UI for the pi coding agent</title>
  <meta name="description" content="A self-hosted browser UI for the pi coding agent. Chat with the agent against your code, browse files, run a terminal, review diffs — all from one tab.">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='1' y='1' width='30' height='30' rx='7' fill='%230d0d10'/><path d='M12 13 H20 M14 13 V21 M18 13 V21' stroke='%23e6e7eb' stroke-width='1.6' stroke-linecap='round' fill='none'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a href="index.html" class="logo">
        ${LOGO_SVG}
        pi-forge
      </a>
${HEADER_NAV_LANDING}
      <button class="mobile-toggle" id="mobileToggle" aria-label="Toggle menu">&#9776;</button>
    </div>
  </header>

  <section class="hero">
    <div class="hero-badge">
      <span>Open Source</span> &middot; Self-Hosted &middot; Single-Tenant
    </div>
    <h1>
      The pi coding agent,<br>
      <span class="gradient-text">in your browser</span>
    </h1>
    <p>
      A self-hosted browser UI for the
      <a href="https://github.com/badlogic/pi-mono" target="_blank" rel="noopener noreferrer">pi coding agent</a>.
      Chat with the agent against your code, browse files, run a terminal,
      review diffs — all from one tab. Your container, your provider keys,
      your data.
    </p>
    <div class="hero-buttons">
      <a href="#quickstart" class="btn-primary">Get Started &darr;</a>
      <a href="https://github.com/Devin-Marks/pi-forge" class="btn-secondary" target="_blank" rel="noopener noreferrer">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        View on GitHub
      </a>
    </div>
  </section>

  <div class="demo-section">
    <div class="demo-window">
      <div class="demo-titlebar">
        <div class="demo-dot red"></div>
        <div class="demo-dot yellow"></div>
        <div class="demo-dot green"></div>
      </div>
      <div class="demo-content">
        <div class="carousel" id="carousel">
          <div class="carousel-viewport">
            <div class="carousel-track" id="carouselTrack">
              <img class="carousel-slide active" src="images/img0.png" alt="pi-forge overview" loading="eager"/>
              <img class="carousel-slide" src="images/img1.png" alt="Screenshot" loading="lazy"/>
              <img class="carousel-slide" src="images/img2.png" alt="Screenshot" loading="lazy"/>
              <img class="carousel-slide" src="images/img3.png" alt="Screenshot" loading="lazy"/>
              <img class="carousel-slide" src="images/img4.png" alt="Screenshot" loading="lazy"/>
              <img class="carousel-slide" src="images/img5.png" alt="Screenshot" loading="lazy"/>
              <img class="carousel-slide" src="images/img6.png" alt="Screenshot" loading="lazy"/>
              <img class="carousel-slide" src="images/img7.png" alt="Screenshot" loading="lazy"/>
              <img class="carousel-slide" src="images/img8.png" alt="Screenshot" loading="lazy"/>
            </div>
          </div>
          <button class="carousel-btn carousel-prev" id="carouselPrev" aria-label="Previous screenshot">&#10094;</button>
          <button class="carousel-btn carousel-next" id="carouselNext" aria-label="Next screenshot">&#10095;</button>
          <div class="carousel-dots" id="carouselDots"></div>
        </div>
      </div>
    </div>
  </div>

  <section class="section" id="features">
    <div class="section-label">Features</div>
    <h2>Everything you need to drive the agent from a browser</h2>
    <p>Pi-forge wraps the pi SDK with the affordances most coding workflows want — and keeps every surface scriptable behind the same REST + SSE API the UI calls.</p>

    <div class="feature-grid">
      <div class="feature-card">
        <div class="feature-icon">&#128279;</div>
        <h3>MCP + per-tool controls</h3>
        <p>Remote (HTTP / SSE) and stdio MCP servers with per-project trust gates. Every tool — pi's built-ins plus each MCP server's — toggleable individually with per-project overrides.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128104;&#8205;&#128104;&#8205;&#128103;</div>
        <h3>Session orchestration</h3>
        <p>Default-available supervisor mode lets one session spawn, observe, and coordinate worker sessions in the same project. Worker events stream into the supervisor's inbox.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128737;&#65039;</div>
        <h3>Optional tool sandbox</h3>
        <p>Opt-in hardening mode runs agent/user shell surfaces as a restricted UID/GID, scopes model file tools, and keeps server-side config and forge data out of that identity.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128268;</div>
        <h3>Webhooks</h3>
        <p>HTTPS POST deliveries on agent and session events. Global or per-project scope, HMAC-SHA256 signing, retry with exponential backoff, delivery history.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#9881;&#65039;</div>
        <h3>Background-process tool</h3>
        <p>The <code>process</code> tool lets the agent spawn long-running processes — dev servers, watchers, builds — with log capture, regex watches, and exit alerts.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#9889;</div>
        <h3>Quick actions</h3>
        <p>Operator-defined chips in the chat toolbar that either run a shell command in the active project or insert a templated prompt into the composer.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128172;</div>
        <h3>Streaming chat</h3>
        <p>Token-by-token rendering over SSE. Tool calls and their results materialize in the transcript as they happen — no waiting until the end of a turn.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#127807;</div>
        <h3>Branchable session tree</h3>
        <p>Fork at any prior turn, navigate the resulting tree, bookmark abandoned branches, summarize-on-navigate to keep context bounded.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128221;</div>
        <h3>Per-turn diff panel</h3>
        <p>Every file the agent touched in the last turn, aggregated into one reviewable changeset. Inline edit results and project-wide diffs share one renderer.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128193;</div>
        <h3>File browser + editor</h3>
        <p>Tree view, tabbed CodeMirror with syntax highlighting and autosave, ripgrep-backed workspace search, path-traversal protection on every operation.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128187;</div>
        <h3>Integrated terminal</h3>
        <p>node-pty over WebSocket, persistent across page refresh and project switch. Per-tab scrollback, multi-tab, env-allowlist for the spawned shell.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#127760;</div>
        <h3>Git panel</h3>
        <p>Status, unified or split diff, stage / unstage per file, commit, push, fetch, pull, branch checkout / create / delete, log with ref decorations.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128202;</div>
        <h3>Context inspector</h3>
        <p>Token + cost breakdown per turn, lifetime spend, raw message inspector with syntax highlighting, search across long conversations.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#129302;</div>
        <h3>Pi-subagents integration</h3>
        <p>Built-in surfacing of the community <a href="https://github.com/nicobailon/pi-subagents">pi-subagents</a> plugin (install separately) — rich tool card for parent calls, child sessions in the project sidebar.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128295;</div>
        <h3>OpenAPI spec</h3>
        <p>Every route auto-documented at /api/docs (Swagger UI) and /api/docs/json. The same routes the React UI calls — no shadow surface.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">&#128241;</div>
        <h3>Mobile + installable PWA</h3>
        <p>Mobile-tuned chat surface — slide-in project drawer, sticky composer above the keyboard, gallery / camera attach. "Add to Home Screen" on iOS and Android; runs fullscreen with safe-area-aware chrome.</p>
      </div>
    </div>
  </section>

  <section class="section" id="quickstart">
    <div class="section-label">Quick Start</div>
    <h2>Up and running in minutes</h2>
    <p>Two install paths. Both end at <code>http://localhost:3000</code> with a provider key prompt.</p>

    <div class="quickstart-steps">
      <div class="qs-step">
        <div class="qs-number">A</div>
        <div class="qs-content">
          <h3>npm — no Docker, runs from your shell</h3>
          <pre><span class="code-cmd">npx</span> pi-forge
<span class="code-comment"># or install globally:</span>
<span class="code-cmd">npm</span> install -g pi-forge &amp;&amp; pi-forge
<span class="code-comment"># pass --port, --workspace-path, --api-key @file etc. — see \`pi-forge --help\`</span></pre>
        </div>
      </div>

      <div class="qs-step">
        <div class="qs-number">B</div>
        <div class="qs-content">
          <h3>Docker — recommended for ongoing use</h3>
          <pre><span class="code-cmd">git</span> clone https://github.com/Devin-Marks/pi-forge.git
<span class="code-cmd">cd</span> pi-forge
<span class="code-cmd">cp</span> docker/.env.example docker/.env
<span class="code-comment"># edit docker/.env to set UI_PASSWORD or API_KEY</span>
<span class="code-cmd">cd</span> docker &amp;&amp; docker compose up -d --build</pre>
        </div>
      </div>

      <div class="qs-step">
        <div class="qs-number">C</div>
        <div class="qs-content">
          <h3>Add your provider key</h3>
          <p>Open <code>http://&lt;host&gt;:3000</code>, go to <strong>Settings &rarr; Providers</strong>, and paste an Anthropic / OpenAI / etc. API key. Or set keys directly in <code>~/.pi/agent/auth.json</code>.</p>
        </div>
      </div>

      <div class="qs-step">
        <div class="qs-number">D</div>
        <div class="qs-content">
          <h3>Add a project and start chatting</h3>
          <p>Click <strong>+ Project</strong>, point at any folder under <code>WORKSPACE_PATH</code>. The folder becomes the agent's working tree; chat opens in the same view.</p>
        </div>
      </div>
    </div>

    <div style="margin-top: 32px;">
      <p style="color: var(--text-secondary); font-size: 14px;">
        Kubernetes, OpenShift, reverse-proxy + TLS, mobile install: see
        <a href="docs/deployment.html">Deployment</a>,
        <a href="docs/configuration.html">Configuration</a>, and
        <a href="docs/mobile.html">Mobile</a>.
      </p>
    </div>
  </section>

  <section class="section" id="api">
    <div class="section-label">Programmatic API</div>
    <h2>Same routes the UI calls</h2>
    <p>Every browser interaction is a documented REST or SSE call. Scripts, CI pipelines, and the React UI all hit the same endpoints — no shadow surface, no separate "API mode."</p>

    <pre><span class="code-comment"># Authenticate with the API_KEY you set in env</span>
<span class="code-cmd">BASE</span>=http://localhost:3000
<span class="code-cmd">KEY</span>=your-api-key

<span class="code-comment"># Create a session under a project</span>
<span class="code-cmd">SESSION</span>=$(curl -s -X POST $BASE/api/v1/sessions \\
  -H <span class="code-string">"Authorization: Bearer $KEY"</span> \\
  -H <span class="code-string">"Content-Type: application/json"</span> \\
  -d <span class="code-string">'{"projectId":"&lt;projectId&gt;"}'</span> | jq -r .sessionId)

<span class="code-comment"># Send a prompt (fire-and-forget; response streams over SSE)</span>
curl -s -X POST $BASE/api/v1/sessions/$SESSION/prompt \\
  -H <span class="code-string">"Authorization: Bearer $KEY"</span> \\
  -H <span class="code-string">"Content-Type: application/json"</span> \\
  -d <span class="code-string">'{"text":"Write a test for the auth module"}'</span>

<span class="code-comment"># Stream the response</span>
curl -N -H <span class="code-string">"Authorization: Bearer $KEY"</span> \\
  $BASE/api/v1/sessions/$SESSION/stream</pre>

    <p style="margin-top: 16px; color: var(--text-secondary); font-size: 14px;">
      Full recipes (multipart attachments, branch / fork, abort, model switch, MCP wiring): see
      <a href="docs/api.html">API Examples</a>.
      Live OpenAPI spec at <code>/api/docs</code> on a running deploy.
    </p>
  </section>

  <section class="section" id="why">
    <div class="section-label">Why pi-forge</div>
    <h2>Self-hosted, single-tenant, scriptable</h2>

    <div class="comparison-grid">
      <div class="comparison-col">
        <h3 class="comparison-header comparison-before">What it isn't</h3>
        <ul class="comparison-list">
          <li>A SaaS product — no cloud, no analytics, no telemetry</li>
          <li>A reimplementation of pi's agent loop (it embeds the SDK)</li>
          <li>A multi-tenant platform — one container, one user, one workspace</li>
          <li>A code editor replacement — point it at your existing repos</li>
          <li>Certified for safety-critical or regulated-data workloads</li>
        </ul>
      </div>
      <div class="comparison-col">
        <h3 class="comparison-header comparison-after">What it is</h3>
        <ul class="comparison-list">
          <li>An HTTP / SSE bridge over the pi SDK with a React chat UI on top</li>
          <li>Container-native: Docker Compose, Kubernetes, OpenShift manifests included</li>
          <li>Provider-agnostic: built-in providers plus any OpenAI-compatible endpoint</li>
          <li>API-first: every UI action is a documented REST call</li>
          <li>Open under MIT, no warranty, no support obligation</li>
        </ul>
      </div>
    </div>
  </section>

  <section class="section" style="text-align: center;">
    <h2>Ready to dig in?</h2>
    <p style="margin-left: auto; margin-right: auto;">The architecture, configuration, and API references all live in the docs. The full source is on GitHub.</p>
    <div class="hero-buttons" style="margin-top: 32px;">
      <a href="docs/architecture.html" class="btn-primary">Read the Docs &rarr;</a>
      <a href="https://github.com/Devin-Marks/pi-forge" class="btn-secondary" target="_blank" rel="noopener noreferrer">
        View Source
      </a>
    </div>
  </section>

  <footer class="site-footer">
    <div class="footer-inner">
      <p>pi-forge &mdash; MIT licensed, no warranty.</p>
      <div class="footer-links">
        <a href="docs/architecture.html">Docs</a>
        <a href="https://github.com/Devin-Marks/pi-forge">GitHub</a>
        <a href="https://github.com/Devin-Marks/pi-forge/issues">Issues</a>
        <a href="https://github.com/Devin-Marks/pi-forge/blob/main/CHANGELOG.md">Changelog</a>
      </div>
    </div>
  </footer>

  <script>
    document.getElementById('mobileToggle').addEventListener('click', () => {
      document.getElementById('navLinks').classList.toggle('open');
    });

    // Hero carousel — minimal vanilla impl. Slides are <img> elements
    // sharing one .carousel-track; the active one gets .active. User-
    // controlled only; no auto-advance (auto-rotating carousels yank
    // attention away from whatever the visitor is reading).
    (function () {
      const slides = Array.from(document.querySelectorAll('.carousel-slide'));
      if (slides.length === 0) return;
      const dotsRoot = document.getElementById('carouselDots');
      let current = 0;

      const dots = slides.map((_, i) => {
        const d = document.createElement('button');
        d.className = 'carousel-dot' + (i === 0 ? ' active' : '');
        d.setAttribute('aria-label', 'Go to screenshot ' + (i + 1));
        d.addEventListener('click', () => go(i));
        dotsRoot.appendChild(d);
        return d;
      });

      function go(next) {
        slides[current].classList.remove('active');
        dots[current].classList.remove('active');
        current = (next + slides.length) % slides.length;
        slides[current].classList.add('active');
        dots[current].classList.add('active');
      }

      document.getElementById('carouselPrev').addEventListener('click', () => go(current - 1));
      document.getElementById('carouselNext').addEventListener('click', () => go(current + 1));
    })();
  </script>
</body>
</html>
`;
writeFileSync(join(siteRoot, "index.html"), LANDING);

// Copy docs/images/* → docs/site/images/* so the Pages deployment
// can serve them under the site root. The Pages workflow uploads
// only docs/site/, so the canonical `docs/images/` (used by README
// for the GitHub repo render) isn't reachable from the deployed
// site; we mirror the bytes in instead. Source of truth stays
// `docs/images/`. Build-time copy keeps the two in lockstep
// without requiring a second commit step.
const imagesSrc = join(repoRoot, "docs", "images");
const imagesOut = join(siteRoot, "images");
mkdirSync(imagesOut, { recursive: true });
let copied = 0;
for (const name of readdirSync(imagesSrc)) {
  copyFileSync(join(imagesSrc, name), join(imagesOut, name));
  copied += 1;
}

console.log(
  `[build-site] wrote ${count} doc page(s) + index.html + ${copied} image(s) under ${siteRoot}`,
);
