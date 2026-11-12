# Seonfix Spider

A local website crawler for technical SEO audits, for macOS and Windows,
modelled on the Screaming Frog SEO Spider workflow (v2.0 rebuilds the
interface to match the reference layout: same tab order, same right-hand
Overview tree, same bottom pane). Crawls run entirely on your own computer -
the core crawler needs no API keys, no backend and no account. Built with
Electron (plain JavaScript).

**Theme: dark.** The interface keeps a dark charcoal theme with the Seonfix
brand green (#00C852) as the accent colour.

## Layout (v2)

- **Header:** logo + wordmark, URL bar with a history dropdown (recent URLs
  + "<Clear All>"), a scope dropdown (**Subdomain** / **Subfolder** /
  **All Subdomains** / **Exact URL**), Start/Pause + Clear buttons, and a
  green "Crawl NN%" progress bar.
- **Main tabs (default order):** Internal, External, Security, Response
  Codes, URL, Page Titles, Meta Description, H1, H2, Content, Images,
  Canonicals, Pagination, Directives, Hreflang, JavaScript, Links, AMP,
  Structured Data, Sitemaps, PageSpeed, Custom Search, Custom Extraction,
  Analytics, Search Console, Accessibility, Spelling, plus a Compare view.
  The "…" button opens **Configure Tabs** (show/hide tabs, Reset Tabs;
  persisted). Tabs scroll horizontally when they overflow.
  *Note: the Meta Keywords tab from v1 was removed in v2 at the user's
  request; the raw `metaKeywords` field is still stored in crawl records.*
- **Toolbar:** filter dropdown (shows the active filter name), grid/tree
  view toggle (tree groups rows by directory), Export, centred Search, and
  a columns show/hide popup.
- **Grid:** numbered rows (1, 2, 3, …), Screaming-Frog-style column sets per
  tab, "No data" placeholder, rows stream in live during a crawl, and a
  "Selected Cells: N  Filter Total: N" line under the grid.
- **Bottom pane:** URL Details / Inlinks / Outlinks / Images (with preview
  pane + Zoom) / Resources / HTTP Headers / Rendered Text / SERP Snippet
  (Google-style snippet preview).
- **Right sidebar tabs:** Overview, Issues, Site Structure, Segments,
  Response Times, API, Spelling.
  - *Overview:* Summary rows (Total URLs Encountered, blocked by robots.txt,
    URLs Crawled, Internal / External, Indexable / Non-Indexable) and a
    collapsible tree with a filter section for every category: Crawl Data
    Internal/External, Security, Response Codes (incl. the Internal
    subtree), URL, Page Titles, Meta Description, H1, H2, Content, Images,
    Canonicals, Pagination, Directives, Hreflang, JavaScript, Links.
    Clicking a row highlights it green, filters the grid, and draws the
    chart below (SVG donut for Crawl Data / Response Codes, SVG bar chart
    for other sections).
  - *Issues:* chips [Issues][Warnings][Opportunities][Total] that filter
    the table (Issue Name | Issue Type | Issue Priority | URLs | % of
    Total), a details pane with a real description per issue, and
    double-click to filter the grid to the affected URLs.
  - *Site Structure:* directory aggregation table + Crawl Depth stacked bar
    chart (Blocked by robots.txt / No Response / 2xx / 3xx / 4xx / 5xx)
    with View and Max Level controls.
  - *Segments:* populated by segments defined in Configuration (name + URL
    pattern); otherwise shows the empty-state text.
  - *Response Times:* average + per-second bucket table and chart.
  - *API:* PageSpeed Insights - with an API key saved in Configuration it
    fetches live performance score / LCP / CLS / TBT for crawled HTML URLs.
  - *Spelling:* spelling/grammar summary from the built-in spell check.
- **Footer:** "Spider Mode: Idle/Active" (left) and
  "N of M (NN%) R Remaining" (right).

## Crawl engine

- **Modes (Mode menu, radio):** Spider, List, SERP (URLs crawled without
  following; use the SERP Snippet bottom pane), Compare.
- **Scope** controls what counts as internal: Subdomain = the start URL's
  own host (www-insensitive, port-aware); Subfolder = the start path
  subtree; All Subdomains = any subdomain of the registrable domain;
  Exact URL = only that URL. CDN host patterns (Configuration > CDNs) also
  count as internal.
- Concurrent crawler with configurable threads, delay, max depth and max
  URLs (default 10,000 - no 500-URL free limit). Resources (CSS/JS/images)
  are crawled as their own rows. **External URLs are fetched once each**
  for status code / content type / response time and are never followed.
  Include / exclude regex, URL rewrite rules, user-agent presets (Seonfix
  Spider, Chrome, Googlebot, Googlebot Smartphone, Bingbot, custom),
  custom headers, cookies, Basic auth, robots.txt respect + custom
  robots.txt override, sitemap discovery (robots.txt + /sitemap.xml +
  /sitemap_index.xml, one index level) with in-sitemap / orphan /
  non-indexable classification.
- Redirects followed with full chains; chains and loops detected.
- **Filter registry:** 208 named filters (single source of truth) drive the
  sidebar counts, grid filtering and exports, so they always agree.
- **Issues catalogue:** every issue carries an SF-style type
  (Issue / Warning / Opportunity) and priority (High / Medium / Low).
- **Link Score:** internal PageRank-style iteration over the crawl graph,
  normalised 0-100.
- **Content analysis:** word/sentence counts, Flesch reading ease +
  readability band, exact + near duplicates (configurable threshold),
  low content, soft-404 heuristic, lorem ipsum detection.
- **Security checks:** HSTS / CSP / X-Content-Type-Options / X-Frame-Options
  / Referrer-Policy presence, mixed content, insecure forms, unsafe
  cross-origin links, protocol-relative resources, bad content type.
- **Spelling:** bundled ~16,700-word English list (generated by
  `npm run wordlist` from local text corpora + a curated core, with a
  common-misspellings denylist); unknown-token counts per page feed the
  Content filters and the Spelling tab. **Grammar is not checked** (counts
  stay 0 - a language-tool integration would be required; nothing is faked).
- **JavaScript rendering mode** (Configuration > Spider > Rendering):
  rendered-vs-raw differences for title, canonical, meta description and
  H1 feed the JavaScript tab; blocked resources are recorded. Text-only
  (raw) is the default.
- **Structured data:** per-URL types and item counts (JSON-LD + microdata)
  with simple required-property warnings for common types (Article,
  Product, FAQPage…). **AMP:** rel=amphtml discovery + basic flags.
- Save / Open crawl (JSON, format version 2; v1 files are auto-upgraded on
  open), Open Recent, profiles (load/save/default, JSON in userData),
  Crawl Compare (two saved crawls), and **Scheduling** (File > Scheduling:
  start URL, time, daily/weekly, export folder; due schedules run a crawl
  and auto-export Internal + Issues CSVs - *only while Seonfix Spider is
  open*, as the dialog states).
- **Bulk Export** menu exports a real CSV per dataset (Queued URLs, Links,
  Web, Path Type, per-section datasets, Custom Search/Extraction, URL
  Inspection, Issues). **Reports** menu generates real files: Crawl
  Overview (HTML), Redirect Chains, Redirects, Orphan Pages, SERP Summary,
  Canonical Errors, Insecure Content, Structured Data, HTTP Headers,
  Cookies (from Set-Cookie headers collected during the crawl).
- **Sitemaps** menu: XML + Image sitemap generation with
  priority/changefreq/lastmod options. **Visualisations** window: Crawl
  Tree (radial), Directory Tree, Force Directed. **Crawl Analysis >
  Analyse** recomputes Link Score, orphans and near-duplicate groups.

## Run locally

    npm install
    npm start

## Tests

    npm test          # unit + fixture-server integration tests (30 tests)
    npm run test:app  # Electron GUI smoke test (59 checks; needs Xvfb/display)
    npm run live      # live crawl of https://mdimrankhan.com capped at 200 URLs

## Build installers

    npm run dist:mac   # macOS universal .dmg
    npm run dist:win   # Windows x64 NSIS .exe

Installers are unsigned: on macOS right-click the app and choose Open the
first time; on Windows choose "More info" then "Run anyway" in SmartScreen.

Releases are built by .github/workflows/release.yml when a GitHub Release is
published (or run manually with an existing release tag). This project is
private - do not publish it publicly.

## App icon

Original design drawn programmatically (a geometric emerald spider on a
dark charcoal rounded square, with a small web arc). Source: build/logo.svg;
regenerate all sizes (PNG, ICO, ICNS, iconset) with `npm run icons`
(python3 + Pillow).

## Honest deferrals - NOT implemented (nothing is faked)

- Google Analytics and Google Search Console data pulls (the tabs and
  config fields exist; pulling data needs Google OAuth, not yet connected).
- Full AMP validation (only discovery + basic flags).
- AI provider integrations (OpenAI, Gemini, Anthropic, Ollama) and backlink
  APIs (Ahrefs / Moz / Majestic) - config fields are stored-only.
- Log file analysis mode.
- Real grammar checking (see Spelling above; grammar counts stay 0).
- Web Form authentication (fields stored; automated form login not
  implemented - use Basic auth or cookies).
- The "Broken Bookmarks" URL filter (fragment targets cannot be verified
  from crawl data alone; it currently matches nothing).
- "URL: Internal Search" / hash-style checks are basic pattern checks.
- Native XLSX export (CSV only).
- Full XPath support in Custom Extraction (basic subset only).
