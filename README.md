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
  *Meta Keywords is not supported: there is no tab, filter or column, and
  since v2.1 the crawler no longer collects the tag at all.*
  **Clicking any main tab** switches the right sidebar to Overview,
  scrolls to that tab's section, highlights its "All" row and draws the
  section chart (v2.1).
- **Toolbar:** filter dropdown (shows the active filter name), an
  "Internal & External / Internal / External" dropdown on the Response
  Codes tab, grid/tree
  view toggle (tree groups rows by directory), Export, centred Search, and
  a columns show/hide popup.
- **Grid:** numbered rows (1, 2, 3, …), Screaming-Frog-style column sets per
  tab, "No data" placeholder, rows stream in live during a crawl, and a
  "Selected Cells: N  Filter Total: N" line under the grid.
- **Bottom pane (v2.1):** URL Details, Inlinks, Outlinks (both with Alt
  Text, Target, Rel, Link Position and link-type / position filters), Image
  Details (preview, zoom, alt, real vs attribute dimensions), Resources,
  SERP Snippet (with length / pixel truncation), Rendered Page, Chrome
  Console Log, View Source (when Store HTML is on), HTTP Headers, Cookies
  (parsed attributes), Duplicate Details (exact + near duplicates with
  similarity %), Structured Data Details, Spelling & Grammar, Accessibility.
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
    Total) with type and priority icons. Clicking an issue filters the grid
    to the affected URLs and shows **Issue Details** with a **Description**
    and **How To Fix** for every one of the 84 issues; Copy copies both.
  - *Site Structure:* directory aggregation table + Crawl Depth stacked bar
    chart (Blocked by robots.txt / No Response / 2xx / 3xx / 4xx / 5xx)
    with View and Max Level controls.
  - *Segments:* populated by segments defined in Configuration (name + URL
    pattern); otherwise shows the empty-state text.
  - *Response Times:* average + per-second bucket table and chart.
  - *API:* PageSpeed Insights - with an API key saved in Configuration it
    fetches live performance score / LCP / CLS / TBT for crawled HTML URLs.
  - *Spelling:* spelling/grammar summary from the built-in spell check.
- **Footer:** "Spider Mode: Idle/Active" (left), "Average: N URL/s.
  Current: N URL/s." (centre) and "Completed N of M (100%) 0 Remaining"
  (right).

## Crawl engine

- **Modes (Mode menu, radio):** Spider, List, SERP and Compare.
  *SERP mode* crawls nothing: paste or upload URL, Title, Description rows
  (CSV or tab-separated) and the Page Titles / Meta Description tabs,
  filters, issues and SERP Snippet pane show lengths, pixel widths and
  truncation. *Compare mode* compares the current crawl with a previous
  saved crawl filter by filter (Current, Previous, Change, Added, New,
  Removed, Missing; click a number to list the URLs) plus changed fields.
- **Configuration menu** lists every section directly (Spider > Crawl /
  Extraction / Limits / Rendering / Advanced / Preferences, Content >
  Content Area / Duplicates / Spelling & Grammar, robots.txt, URL Rewriting,
  CDNs, Include, Exclude, Speed, User-Agent, HTTP Header, Custom, API
  Access, Authentication, Segments, Crawl Analysis, Profiles).
- **Spider > Crawl options (v2.1, Screaming Frog defaults):** separate
  Images / CSS / JavaScript resource switches, Follow Internal and External
  "nofollow" (off by default, so nofollow links are recorded but not
  crawled), Crawl Canonicals (on), Pagination, Hreflang and AMP (off),
  Iframes and Meta Refresh (on). Store HTML (Extraction) enables View
  Source.
- **Content Area (v2.1):** CSS selectors to include / exclude (default
  excludes nav and footer) before word count, readability, spelling,
  grammar and duplicate checks.
- **Custom Link Positions (v2.1):** every link is tagged Navigation,
  Header, Footer, Sidebar or Content from its ancestor elements; custom
  "Name | text" rules run first.
- **Forms Based authentication (v2.1):** opens the login page, fills the
  form that has a password field (keeping hidden CSRF fields), submits it
  and reuses the session cookies for the whole crawl. The password is stored
  encrypted with the OS keychain (safeStorage).
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
- **Filter registry:** 237 named filters (single source of truth) drive the
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
  Content filters and the Spelling tab.
- **Grammar (v2.1):** built-in conservative rules (repeated words, a/an,
  "could of", lowercase sentence starts, missing space after punctuation).
  Not a full grammar engine like LanguageTool.
- **Accessibility (v2.1):** static WCAG checks per HTML page (page
  language, document title, image alt, link / button names, form labels,
  duplicate IDs, empty headings, iframe titles, zoom disabled, positive
  tabindex, skipped heading levels) with an Accessibility tab, Overview
  section, issues and an Accessibility Violations report. No colour
  contrast or rendered checks.
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
  Cookies (from Set-Cookie headers collected during the crawl),
  Accessibility Violations.
- **Sitemaps** menu: XML + Image sitemap generation with
  priority/changefreq/lastmod options. **Visualisations** window: Crawl
  Tree (radial), Directory Tree, Force Directed. **Crawl Analysis >
  Analyse** recomputes Link Score, orphans and near-duplicate groups.

## Run locally

    npm install
    npm start

## Tests

    npm test          # unit + fixture-server integration tests (38 tests)
    npm run test:app  # Electron GUI smoke test (81 checks; needs a display)
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
- A full grammar engine (only the built-in rules above) and colour-contrast
  accessibility checks.
- Web Form login for JavaScript-only login forms or multi-step / 2FA logins.
- The "Broken Bookmarks" URL filter (fragment targets cannot be verified
  from crawl data alone; it currently matches nothing).
- "URL: Internal Search" / hash-style checks are basic pattern checks.
- Native XLSX export (CSV only).
- Full XPath support in Custom Extraction (basic subset only).
