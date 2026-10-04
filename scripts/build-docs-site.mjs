#!/usr/bin/env node
/**
 * Builds a self-contained HTML documentation site from the repo markdown.
 * Output: docs/site/index.html
 *
 * Usage: node scripts/build-docs-site.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "docs", "site");

const PAGES = [
  {
    id: "home",
    title: "Home",
    file: "README.md",
    blurb: "What this is and how to run it",
  },
  {
    id: "architecture",
    title: "Architecture",
    file: "docs/ARCHITECTURE.md",
    blurb: "System design and module map",
  },
  {
    id: "development",
    title: "Development",
    file: "docs/DEVELOPMENT.md",
    blurb: "Local loop, tests, where to change code",
  },
  {
    id: "api",
    title: "API",
    file: "docs/API.md",
    blurb: "Portal and worker HTTP surfaces",
  },
  {
    id: "deployment",
    title: "Deployment",
    file: "docs/DEPLOYMENT.md",
    blurb: "TLS, firewall, production ops",
  },
  {
    id: "setup-ghcr-alma",
    title: "Setup: GHCR + Alma",
    file: "docs/SETUP_GHCR_ALMA.md",
    blurb: "Step-by-step publish and Alma Linux install",
  },
  {
    id: "podman",
    title: "Podman + GHCR",
    file: "docs/PODMAN.md",
    blurb: "Publish image and remote auto-pull",
  },
  {
    id: "workers",
    title: "Workers",
    file: "docs/WORKERS.md",
    blurb: "Multi-host browser placement",
  },
  {
    id: "identity",
    title: "Identity",
    file: "docs/USER_IDENTITY.md",
    blurb: "subjectId, profiles, SAML",
  },
  {
    id: "security",
    title: "Security",
    file: "docs/SECURITY.md",
    blurb: "Threat model and hardening",
  },
  {
    id: "plan",
    title: "Plan",
    file: "docs/PLAN.md",
    blurb: "What is built and what is next",
  },
  {
    id: "contributing",
    title: "Contributing",
    file: "CONTRIBUTING.md",
    blurb: "How to propose changes",
  },
  {
    id: "orchestrator",
    title: "Orchestrator",
    file: "orchestrator/README.md",
    blurb: "Backend package guide",
  },
  {
    id: "web",
    title: "Web UI",
    file: "web/README.md",
    blurb: "Frontend and viewer",
  },
];

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMarkdown(text) {
  let out = escapeHtml(text);
  // links — rewrite repo-relative .md links to in-site hashes
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const page = PAGES.find(
      (p) =>
        href === p.file ||
        href === `./${p.file}` ||
        href === `../${p.file}` ||
        href.endsWith(`/${path.basename(p.file)}`) ||
        href === path.basename(p.file),
    );
    if (page) {
      return `<a href="#${page.id}" data-nav="${page.id}">${label}</a>`;
    }
    if (href.startsWith("#")) {
      return `<a href="${href}">${label}</a>`;
    }
    const safe = escapeHtml(href);
    const external = /^https?:\/\//i.test(href);
    return `<a href="${safe}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
  });
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  return out;
}

function renderTable(rows) {
  if (rows.length === 0) return "";
  const head = rows[0];
  const body = rows.slice(1);
  const th = head.map((c) => `<th>${inlineMarkdown(c.trim())}</th>`).join("");
  const tr = body
    .map((row) => `<tr>${row.map((c) => `<td>${inlineMarkdown(c.trim())}</td>`).join("")}</tr>`)
    .join("\n");
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

function parseTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isTableSeparator(line) {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(line.trim());
}

function markdownToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeLines = [];
  let listType = null;
  let listItems = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (text) html.push(`<p>${inlineMarkdown(text)}</p>`);
  };

  const flushList = () => {
    if (!listType) return;
    const tag = listType;
    const items = listItems.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("\n");
    html.push(`<${tag}>${items}</${tag}>`);
    listType = null;
    listItems = [];
  };

  const flushCode = () => {
    const code = escapeHtml(codeLines.join("\n"));
    const lang = codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : "";
    const cls = codeLang === "mermaid" ? ' class="code-block mermaid-source"' : ' class="code-block"';
    html.push(`<pre${cls}${lang}><code>${code}</code></pre>`);
    if (codeLang === "mermaid") {
      html.push(
        `<p class="callout">Mermaid diagram source — render in GitHub/compatible viewers, or follow the ASCII diagrams nearby.</p>`,
      );
    }
    inCode = false;
    codeLang = "";
    codeLines = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (inCode) {
        flushCode();
      } else {
        inCode = true;
        codeLang = line.slice(3).trim();
      }
      i += 1;
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      i += 1;
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      i += 1;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      html.push("<hr />");
      i += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
      html.push(`<h${level} id="${id}">${inlineMarkdown(text)}</h${level}>`);
      i += 1;
      continue;
    }

    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      flushList();
      const rows = [parseTableRow(line)];
      i += 2; // skip separator
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      html.push(renderTable(rows));
      continue;
    }

    const ul = /^[-*]\s+(.+)$/.exec(line);
    if (ul) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(ul[1]);
      i += 1;
      continue;
    }

    const ol = /^\d+\.\s+(.+)$/.exec(line);
    if (ol) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(ol[1]);
      i += 1;
      continue;
    }

    if (line.startsWith("> ")) {
      flushParagraph();
      flushList();
      const quote = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quote.push(lines[i].slice(2));
        i += 1;
      }
      html.push(`<blockquote>${inlineMarkdown(quote.join(" "))}</blockquote>`);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
    i += 1;
  }

  flushParagraph();
  flushList();
  if (inCode) flushCode();
  return html.join("\n");
}

function loadCss() {
  return readFileSync(path.join(root, "docs", "site", "styles.css"), "utf8");
}

function build() {
  mkdirSync(outDir, { recursive: true });
  const css = loadCss();

  const pages = PAGES.map((page) => {
    const abs = path.join(root, page.file);
    const md = readFileSync(abs, "utf8");
    return {
      ...page,
      html: markdownToHtml(md),
      source: page.file,
    };
  });

  const nav = pages
    .map(
      (p, idx) => `
      <button type="button" class="nav-item${idx === 0 ? " is-active" : ""}" data-nav="${p.id}" aria-current="${idx === 0 ? "page" : "false"}">
        <span class="nav-item-title">${escapeHtml(p.title)}</span>
        <span class="nav-item-blurb">${escapeHtml(p.blurb)}</span>
      </button>`,
    )
    .join("\n");

  const articles = pages
    .map(
      (p, idx) => `
      <article class="doc-page${idx === 0 ? " is-active" : ""}" id="page-${p.id}" data-page="${p.id}" ${idx === 0 ? "" : "hidden"}>
        <header class="doc-page-header">
          <p class="doc-kicker">${escapeHtml(p.source)}</p>
          <h1 class="doc-page-title">${escapeHtml(p.title)}</h1>
          <p class="doc-page-blurb">${escapeHtml(p.blurb)}</p>
        </header>
        <div class="doc-body">
          ${p.html}
        </div>
      </article>`,
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Browser Isolation — Documentation</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
  <style>
${css}
  </style>
</head>
<body>
  <div class="atmosphere" aria-hidden="true"></div>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <p class="brand-mark">Browser Isolation</p>
        <p class="brand-sub">Documentation</p>
      </div>
      <label class="search">
        <span class="visually-hidden">Filter pages</span>
        <input type="search" id="doc-search" placeholder="Filter pages…" autocomplete="off" />
      </label>
      <nav class="nav" id="doc-nav" aria-label="Documentation">
        ${nav}
      </nav>
      <footer class="sidebar-foot">
        <p>Self-contained HTML · regenerated from markdown</p>
        <p><code>npm run docs</code></p>
      </footer>
    </aside>
    <main class="main">
      <div class="main-top">
        <button type="button" class="menu-btn" id="menu-btn" aria-label="Open navigation">Menu</button>
        <p class="reading-hint">Remote browser isolation · operator &amp; developer guide</p>
      </div>
      <div class="content" id="doc-content">
        ${articles}
      </div>
    </main>
  </div>
  <script>
    (function () {
      const nav = document.getElementById("doc-nav");
      const search = document.getElementById("doc-search");
      const menuBtn = document.getElementById("menu-btn");
      const shell = document.querySelector(".shell");
      const pages = [...document.querySelectorAll(".doc-page")];
      const items = [...document.querySelectorAll(".nav-item")];

      function showPage(id, pushHash) {
        const target = pages.find((p) => p.dataset.page === id) || pages[0];
        const nextId = target.dataset.page;
        for (const page of pages) {
          const active = page === target;
          page.classList.toggle("is-active", active);
          page.hidden = !active;
        }
        for (const item of items) {
          const active = item.dataset.nav === nextId;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-current", active ? "page" : "false");
        }
        if (pushHash !== false) {
          history.replaceState(null, "", "#" + nextId);
        }
        document.getElementById("doc-content").scrollTop = 0;
        shell.classList.remove("nav-open");
      }

      nav.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-nav]");
        if (!btn) return;
        showPage(btn.dataset.nav);
      });

      document.getElementById("doc-content").addEventListener("click", (event) => {
        const link = event.target.closest("a[data-nav]");
        if (!link) return;
        event.preventDefault();
        showPage(link.dataset.nav);
      });

      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        for (const item of items) {
          const hay = (item.textContent || "").toLowerCase();
          item.hidden = q.length > 0 && !hay.includes(q);
        }
      });

      menuBtn.addEventListener("click", () => {
        shell.classList.toggle("nav-open");
      });

      const initial = (location.hash || "#home").slice(1);
      showPage(initial, false);
      window.addEventListener("hashchange", () => {
        showPage((location.hash || "#home").slice(1), false);
      });
    })();
  </script>
</body>
</html>
`;

  const outFile = path.join(outDir, "index.html");
  writeFileSync(outFile, html, "utf8");
  console.log(`Wrote ${path.relative(root, outFile)} (${pages.length} pages)`);
}

build();
