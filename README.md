# Seonfix Spider

A local website crawler for technical SEO audits, for macOS and Windows.
Crawls run entirely on your own computer - the core crawler needs no API
keys, no backend and no account. Built with Electron (plain JavaScript).

## What it does

- Crawl modes: Spider (crawl from a start URL), List (audit a list of URLs),
  Sitemap (audit the URLs in an XML sitemap).
- Concurrent crawler with configurable threads, crawl delay, max depth and
  max URLs (default 10,000 - there is no 500-URL free limit). Include /
  exclude regex rules, user-agent presets (Seonfix Spider, Chrome, Googlebot,
  Googlebot Smartphone, Bingbot, custom), custom headers and cookies,
  robots.txt respect / ignore, and a custom robots.txt override you can test
  before publishing.
- Redirects are followed with the full chain recorded; chains and loops are
  detected and reported.
- Per-URL data: status code and status, content type, response time and
  size, indexability and the reason for it, page title (length and
  approximate pixel width), meta description, meta keywords, H1 / H2,
  meta robots and X-Robots-Tag, canonical(s), hreflang, rel next / prev
  pagination, word count, text ratio, crawl depth, inlinks / outlinks
  (total, unique, external), images with alt text and file size, resources
  (CSS / JS), structured data types (JSON-LD and microdata), MD5 content
  hash for exact duplicates and simhash for near duplicates.
- Issues engine with 40+ rules: missing / duplicate / over-long / over-short
  titles, meta descriptions, H1 and H2; 4xx, 5xx, 3xx, redirect chains and
  loops; no response; blocked by robots.txt; noindex / nofollow;
  canonicalised, missing canonical, multiple canonicals, canonical pointing
  to a non-indexable URL; orphan pages; low word count; URL problems (long,
  uppercase, underscores, non-ASCII, parameters); missing image alt text and
  images over 100 KB; hreflang return-tag / language-code problems; HTTP
  pages, mixed content and missing security headers. Every issue has a
  severity (Error / Warning / Opportunity), a URL count and a percentage.
- Interface: tabbed data grids (Overview, Internal, External, Response
  Codes, Protocol, URL, Page Titles, Meta Description, Meta Keywords, H1,
  H2, Images, Canonicals, Pagination, Directives, hreflang, Structured Data,
  Sitemaps, Custom Extraction, Custom Search, Visualisation, Crawl Compare)
  with per-tab filters, text search and sortable columns; a right-hand
  Overview / Issues sidebar (click an issue to filter); a bottom pane with
  URL Details, Inlinks, Outlinks, Image Details, Resources and URL Info
  (response headers and redirect chain). Double-click a row to open the URL.
- Custom Extraction with CSS selectors and regular expressions, plus a
  basic XPath subset (for example //h1 or //meta[@name='description']).
  Full XPath expressions beyond that subset are not supported.
- Custom Search: contains / does-not-contain rules over page source.
- JavaScript rendering mode (Configuration - Rendering): pages are also
  loaded in a hidden Chromium window and the rendered title, H1 and link
  count are compared with the raw HTML; differences are flagged on the URL
  Details pane. Raw text mode is the default.
- Save Crawl / Open Crawl (JSON project file), recent crawl list, and Crawl
  Comparison between two saved crawls (new / removed / changed URLs and
  issue deltas).
- Exports: per-tab CSV, a bulk CSV bundle with one section per tab, a
  Redirect Chains report (CSV), and XML Sitemap + Image Sitemap generation
  from the crawl. The bulk export is CSV, not native XLSX.
- Site structure visualisation: radial crawl graph coloured by status code
  plus a directory tree breakdown.

## Run locally

    npm install
    npm start

## Tests

    npm test          # unit + fixture-server integration tests (node --test)
    npm run test:app  # Electron GUI smoke test (needs a display or Xvfb)
    npm run live      # real live crawl of https://example.com (max 10 URLs)

## Build installers

    npm run dist:mac   # macOS universal .dmg
    npm run dist:win   # Windows x64 NSIS .exe

Installers are unsigned: on macOS right-click the app and choose Open the
first time; on Windows choose "More info" then "Run anyway" in SmartScreen.

Releases are built by .github/workflows/release.yml when a GitHub Release is
published (or run manually with an existing release tag): it runs the unit
tests, builds on macOS and Windows, and uploads the .dmg / .exe to the
release. This project is private - do not publish it publicly.

## App icon

The icon is an original design drawn programmatically (a geometric emerald
spider on a dark charcoal rounded square, with a small web arc). Source:
build/logo.svg; regenerate all sizes (PNG, ICO, ICNS, iconset) with:

    npm run icons     # python3 + Pillow

## v1.0 scope - what is NOT implemented yet (roadmap)

These are shown in Settings as disabled placeholders only; nothing is faked
and no data leaves the computer:

- Google Analytics, Google Search Console and PageSpeed Insights
  integrations (planned for v1.1; they will need your own Google API key /
  OAuth client).
- AI integrations (OpenAI, Gemini, Anthropic, Ollama).
- Ahrefs / Moz / Majestic link metrics.
- Scheduled crawls and command-line automation.
- Spelling and grammar checking, and accessibility (AXE) auditing.
- Log file analysis mode.
- Native XLSX export (CSV only for now, see above).
- Full XPath support in Custom Extraction (basic subset only, see above).
