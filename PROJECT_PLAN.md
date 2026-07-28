# AminFinance — Project Plan

A portfolio tracker for **stocks** and **Binance crypto**, with analytics, charts, news, 3D visuals, and AI-generated commentary.

**Client:** React 19 · Redux Toolkit (+ RTK Query) · Three.js (react-three-fiber) · Framer Motion · Vite · Tailwind CSS
**Server:** Node.js 22 · Fastify · TypeScript — a **thin proxy**: key custody, Binance account sync, shared cache. No database, no auth.

---

## 1. Why there's a server, and why it stays small

I tested every candidate API directly (CORS preflight + live responses) before writing this. Two findings made a browser-only build impossible; a third made the server clearly worth having.

### 1.1 Binance account data is CORS-blocked in the browser

| Endpoint class | Example | CORS | From browser |
|---|---|---|---|
| Public market data | `/api/v3/ticker/24hr`, `/api/v3/klines` | `Access-Control-Allow-Origin: *` | ✅ Works |
| Signed account data | `/api/v3/account` (your balances) | Preflight returns **no** `Access-Control-Allow-Origin` | ❌ Blocked |

Signed endpoints require the `X-MBX-APIKEY` header, which triggers a preflight Binance doesn't answer. No library or fetch option works around it. From Node there is no CORS at all, so the server calls it directly and your holdings sync automatically.

### 1.2 API keys must not live in frontend code

Anything in browser JavaScript is readable by anyone who opens DevTools, plus any browser extension or XSS on the page. A leaked Binance secret is a financial risk; a leaked Anthropic key is someone else's bill. All six keys now live in the server's `.env` and never cross the wire to the client.

This also means the Claude call uses the official `@anthropic-ai/sdk` normally — no `dangerouslyAllowBrowser`, no compromise.

### 1.3 The market is PSX, not the US — which changes the provider stack

The actual portfolio is **Pakistan Stock Exchange** equities (FATIMA, FFC, HUBC) plus Binance crypto. Every provider originally planned — Finnhub, Alpha Vantage, Twelve Data — is US-centric and **does not cover PSX**.

The replacement is PSX's own data service, `dps.psx.com.pk`, verified against live holdings:

| Endpoint | Returns | Verified against |
|---|---|---|
| `/timeseries/int/{SYM}` | Intraday ticks `[epoch, price, volume]` | Live price |
| `/timeseries/eod/{SYM}` | Daily `[epoch, close, volume, open]` — **1,240 rows ≈ 5 years** | Close + volume exact on all 3 symbols |
| `/company/{SYM}` | Open/High/Low/Volume/LDCP, 52-week range, P/E, Market Cap, Shares, Free Float, EPS, **Payouts** (dividends) | High/Low/LDCP exact |

Previous close comes from the prior EOD row (`LDCP`), which reproduces the broker's day-change figure exactly.

**This removes the project's tightest constraint.** Alpha Vantage's 25 req/day was the binding limit and the only planned source of dividend dates; PSX DPS supplies dividends (Payouts) and fundamentals with **no key and no documented quota**. Finnhub, Alpha Vantage, and Twelve Data drop to optional — needed only if US tickers are ever added.

| API | Free limit | Role now |
|---|---|---|
| **PSX DPS** | none documented | **Primary** — PSX quotes, history, fundamentals, dividends |
| **Binance** (public) | ~1200 wt/min | Crypto prices; one server WebSocket fanned out to all tabs |
| FX rate source | varies | USDT/USD → PKR conversion for the combined total |
| Finnhub / Alpha Vantage / Twelve Data | see §9 | Optional, US tickers only |

**The caveat:** DPS is the PSX website's own backend, not a documented public API. It can change without notice, and `/company/` requires HTML parsing. Mitigations in §8.

### 1.4 What the server deliberately does *not* do

No database, no accounts, no login. Your holdings and transactions stay in the browser (IndexedDB) exactly as originally planned. The server is stateless apart from its cache — if it restarts, nothing of yours is lost. It can be deleted and rebuilt from `.env` alone.

> **Security note:** this proxy holds real keys. It must **not** be exposed publicly without protection — an open endpoint means anyone can drain your Anthropic credits and read your Binance balances. See §4.4.

---

## 2. Feature scope

### 2.1 Portfolio
- Add / edit / delete holdings — stocks and crypto in one ledger
- Per-lot cost basis (multiple buys of the same symbol; weighted-average + FIFO views)
- **Binance auto-sync** — balances and trade history pulled via the server
- CSV import for brokers with no API
- Live current value, unrealized P/L (absolute + %), day change
- Realized P/L from closed positions
- Multi-currency display with live FX

### 2.2 Analytics
- Total value + all-time P/L with history sparkline
- Allocation by asset, by class (stock/crypto), by sector
- Best / worst performers
- Volatility, max drawdown, Sharpe ratio (annualized, configurable risk-free rate)
- Correlation matrix across holdings
- Dividend calendar — upcoming ex-div and payment dates, projected annual income, yield on cost

### 2.3 Charts
| Chart | Purpose | Library |
|---|---|---|
| Candlestick + volume | Per-asset price history, 1D→ALL | `lightweight-charts` |
| Portfolio value area | Net worth over time | Recharts |
| Allocation donut / treemap | Composition (2D ⇄ 3D toggle) | Recharts + Three.js |
| Correlation heatmap | Diversification | Custom SVG |
| Dividend calendar bars | Income timeline | Recharts |
| In-table sparklines | Per-holding trend | Recharts |

> Load the `dataviz` skill before the first chart component — it sets the palette, axis, tooltip, and light/dark rules so all six types read as one system.

### 2.4 AI insights
- Per-asset: verdict (`buy` / `hold` / `reduce` / `sell`), confidence, bull case, bear case, key risks, time horizon
- Portfolio-level: concentration risk, diversification gaps, rebalancing suggestions
- Grounded in real data — the server assembles current price, *your* cost basis, market cap, P/E, dividend yield, and recent headlines into the prompt, so output is about your actual position
- **Structured outputs** (JSON schema) → rendered as components, never parsed from prose
- Streamed to the client via SSE so long analyses appear progressively
- Every response carries a disclaimer plus the timestamp and data snapshot it was based on
- Cached server-side per symbol per day — AI calls cost real money

Model: `claude-opus-5`, adaptive thinking, `effort: "high"`.

### 2.5 News
- Per-holding headlines (Finnhub company news + Alpha Vantage sentiment), merged and deduped server-side
- Sentiment badge per article
- Filterable by holding, sorted by relevance

### 2.6 3D & motion
Three.js where it carries meaning, not as decoration:

| Element | What it is | Cost control |
|---|---|---|
| Dashboard hero | Particle field / globe; color and velocity driven by portfolio day-change | Lazy chunk, `Suspense`, off under `prefers-reduced-motion` |
| 3D allocation | Extruded donut / rotating treemap, toggled from the 2D view | Same chunk |
| Asset detail backdrop | Animated gradient mesh | Shader-only, no geometry |

All 3D lives in one lazy chunk; `<Canvas frameloop="demand">` so idle costs no GPU. Framer Motion handles route transitions, card entry, number roll-ups (`useSpring`), and skeleton→content morphs.

---

## 3. Repository layout

```
AminFinance/
├── client/                       # React app (Vite)
│   ├── src/
│   │   ├── app/                  # store.ts, typed hooks
│   │   ├── features/             # portfolio · quotes · analytics · dividends
│   │   │                         # news · ai · settings
│   │   ├── services/api.ts       # ONE RTK Query client → our server
│   │   ├── components/
│   │   │   ├── ui/               # buttons, cards, tables, modals
│   │   │   ├── charts/
│   │   │   └── three/            # lazy-loaded 3D scenes
│   │   ├── pages/                # Dashboard · Portfolio · Asset · Analytics
│   │   │                         # News · Settings
│   │   ├── lib/
│   │   │   ├── calc/             # P/L, cost basis, Sharpe, drawdown, correlation
│   │   │   ├── db/               # Dexie (IndexedDB) — holdings & transactions
│   │   │   └── format/
│   │   └── types/
│   └── vite.config.ts            # dev proxy → localhost:3001
│
├── server/                       # Node + Fastify
│   ├── src/
│   │   ├── index.ts              # bootstrap, plugins, graceful shutdown
│   │   ├── routes/               # quotes · candles · fundamentals · dividends
│   │   │                         # news · binance · ai · fx
│   │   ├── providers/            # one adapter per upstream API
│   │   │   ├── binance.ts        # public + HMAC-signed
│   │   │   ├── finnhub.ts
│   │   │   ├── alphaVantage.ts
│   │   │   ├── coingecko.ts
│   │   │   ├── twelveData.ts
│   │   │   └── claude.ts
│   │   ├── cache/                # TTL cache + disk snapshot
│   │   ├── lib/rateLimit.ts      # per-provider token buckets
│   │   ├── ws/                   # Binance stream → client fan-out
│   │   └── schemas/              # shared request/response types
│   └── .env                      # ALL keys — gitignored
│
├── shared/                       # types imported by both sides
└── package.json                  # npm workspaces
```

Single repo, npm workspaces, one `npm run dev` starting both. `shared/` holds the DTOs so a server response shape change is a client compile error, not a runtime surprise.

---

## 4. Server design

### 4.1 API surface

The client talks to exactly one origin and never knows which upstream served a request.

| Route | Purpose | Cache TTL |
|---|---|---|
| `GET /api/quotes?symbols=AAPL,BTCUSDT` | Unified quotes, stocks + crypto | 60s |
| `GET /api/candles/:symbol?interval=1d&range=1y` | OHLCV history | 5m |
| `GET /api/fundamentals/:symbol` | Market cap, P/E, sector, profile | 24h |
| `GET /api/dividends/:symbol` | Next ex-div + payment date, history | 24h |
| `GET /api/news?symbols=` | Merged, deduped, sentiment-tagged | 1h |
| `GET /api/fx?base=USD` | Exchange rates | 12h |
| `GET /api/binance/balances` | **Signed** — your holdings | 30s |
| `GET /api/binance/trades?symbol=` | **Signed** — trade history for cost basis | 5m |
| `POST /api/ai/analyze` | Per-asset insight (SSE stream) | 24h/symbol |
| `POST /api/ai/portfolio-review` | Portfolio-level review (SSE stream) | manual |
| `WS /ws/prices` | Live crypto ticks | — |

Routing symbol → provider lives server-side, so swapping Finnhub for another vendor never touches the client.

### 4.2 Caching

Two tiers:
- **Memory** (LRU + TTL) — everything, cleared on restart
- **Disk snapshot** (JSON file, written on change) — only the 24h tiers (fundamentals, dividends, AI insights)

The disk tier exists for one reason: a server restart must not burn Alpha Vantage's 25 daily calls. It is a cache file, not a database — deleting it costs a day of freshness and nothing else.

Every response carries `X-Cache: hit|miss` and `X-Data-Age`, which the UI surfaces as "as of HH:MM" so stale data is never mistaken for live.

### 4.3 Rate limiting

A token bucket per provider sits in each adapter. On exhaustion the request queues rather than fails; if the queue would exceed a deadline, the cached value is returned with `X-Stale: true` and the UI flags it. Alpha Vantage additionally checks the disk cache before spending a token.

```
request → cache hit? → serve
        → miss → bucket has token? → yes: fetch upstream → cache → serve
                                   → no:  queue, or serve stale + flag
```

### 4.4 Key custody and access control

All keys in `server/.env`, gitignored, never in a response body. `.env.example` documents the names with empty values.

Binance keys must be created **read-only** — "Enable Reading" only, no trading, no withdrawals — with IP whitelisting on. Even a full compromise of the server then exposes balances, not funds.

Because the proxy holds real credentials, it is protected by default:
- Binds to `127.0.0.1` in local dev
- Strict CORS allowlist (the client origin only)
- A shared-secret header required on every `/api/*` call
- Per-IP request limits on the AI routes specifically, since those cost money

If it's ever deployed to a public host, the shared secret becomes mandatory rather than default.

### 4.5 Binance signed requests

Query string + `timestamp` + `recvWindow`, HMAC-SHA256 signed with the secret, sent with `X-MBX-APIKEY`. The server keeps a clock-skew offset from `/api/v3/time` — the most common cause of `-1021 Timestamp for this request` is a drifting local clock, so we correct for it rather than hitting a confusing error.

---

## 5. Client state design

**IndexedDB (Dexie), persisted:** holdings, transactions, settings, watchlist.
**RTK Query, cached in memory:** everything from the server.
**Never stored:** derived metrics. P/L, allocation, and all analytics are `createSelector` memoized selectors over holdings + quotes. Storing computed P/L is how tracker apps end up displaying stale numbers.

```
holdings + live quotes ──> selectors ──> value, P/L, allocation, metrics
```

Redux holds UI state and a thin mirror of the Dexie data; the server round-trip is entirely RTK Query's concern.

### Refresh strategy

| Data | Refresh | Mechanism |
|---|---|---|
| Crypto prices | Real-time | Server WS fan-out |
| Stock quotes | 60s while visible | RTKQ `pollingInterval` |
| Binance balances | 30s | RTKQ polling |
| Fundamentals / dividends | 24h | Server cache |
| News | 1h | Server cache |
| AI insights | On demand, 24h cache | Manual trigger |

Polling pauses on tab blur (visibility API + `refetchOnFocus`) — a backgrounded tab shouldn't consume quota.

---

## 6. Build phases

Each phase ends with something runnable.

### Phase 1 — Foundation
Workspaces scaffold · Fastify server with health check, CORS, env loading · Vite client with dev proxy · Tailwind + design tokens (dark/light) · Redux store + Dexie · routing and app shell.
**Ships:** both processes running, client reaching server.

### Phase 2 — Server data layer
Provider adapters · unified `/api/quotes`, `/api/candles`, `/api/fundamentals`, `/api/dividends`, `/api/news`, `/api/fx` · TTL cache + disk snapshot · token-bucket rate limiting · shared DTOs in `shared/`.
**Ships:** every market-data endpoint working, verifiable with curl.

### Phase 3 — Portfolio core
Holdings CRUD · transaction ledger with cost basis · **Binance signed sync** (balances + trades) · CSV import · live P/L · holdings table with sparklines · WS price stream.
**Ships:** a working tracker. This is where it becomes genuinely useful.

### Phase 4 — Charts & analytics
`dataviz` skill → chart design system · candlestick + volume · portfolio history · allocation donut · analytics page (Sharpe, drawdown, correlation) · dividend calendar.
**Ships:** full analytics surface.

### Phase 5 — Intelligence
News feed with sentiment · Claude integration with structured outputs + SSE streaming · per-asset insight cards · portfolio review · caching and disclaimers.
**Ships:** AI suggestions with reasoning.

### Phase 6 — 3D & polish
react-three-fiber setup · hero scene · 3D allocation toggle · Framer Motion transitions and number animations · reduced-motion and mobile fallbacks · bundle analysis and Lighthouse pass.
**Ships:** finished product.

---

## 7. Decisions, recorded

| Decision | Rationale |
|---|---|
| Thin proxy, no database | Solves both blockers (§1.1, §1.2) with minimal surface; your data stays local and portable |
| Fastify over Express | Native TypeScript, schema validation built in, materially faster; Express's middleware ecosystem isn't needed here |
| npm workspaces over separate repos | Shared DTOs give compile-time safety across the boundary |
| Vite over Next.js | The server is a proxy, not a renderer; SSR would add complexity for no gain |
| RTK Query over raw fetch | Caching, dedup, polling, invalidation — all four are the hard part here |
| Derived state as selectors, never stored | Prevents stale P/L, the classic tracker bug |
| `lightweight-charts` for candles | Recharts handles OHLC poorly; TradingView's lib is 45kb and purpose-built |
| Dexie (IndexedDB) over localStorage | localStorage is 5MB, synchronous, and blocks the main thread |
| Three.js in its own lazy chunk | ~600kb — must stay off the critical path |
| Structured outputs over free-text AI | Renderable as components; no prose parsing |
| Read-only Binance keys, IP-whitelisted | Compromise exposes balances, never funds |

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Proxy exposed publicly with live keys | Localhost bind by default, CORS allowlist, shared-secret header, per-IP limits on AI routes |
| **PSX DPS changes shape or disappears** | It is an undocumented site backend, so treat it as fragile: parse defensively, validate every response against the DTO before caching, keep the last-good value on disk and serve it flagged `X-Stale` rather than showing nothing. HTML parsing (`/company/`) is isolated to one adapter with the selectors in one table. A contract test runs the three real symbols and fails loudly when the shape shifts. |
| **PSX DPS rate limits are undocumented** | No published quota does not mean no quota. Apply a conservative self-imposed bucket, cache aggressively, and identify with a real User-Agent — do not hammer it just because nothing says not to. |
| Alpha Vantage 25/day exhausted | Only applies if US tickers are added; PSX dividends come from DPS Payouts |
| Binance clock skew → `-1021` | Server tracks offset from `/api/v3/time` |
| Free API discontinued | One adapter per provider; swapping vendors touches one file |
| Server down = dead app | Client serves last-known data from IndexedDB with a clear offline banner |
| 3D hurts mobile | Feature detection + `prefers-reduced-motion` + a 2D fallback for every 3D view |
| AI output read as advice | Persistent disclaimer, visible data snapshot, confidence shown as a range |
| Bundle bloat | Route-level splitting + vendor chunking. **Shipped: 178kb gzip initial**, against a 160kb budget set at Phase 1 when the app did nothing. The overrun is the dashboard's dependencies — Dexie, the chart layer, and the portfolio engine are all needed for first paint, and React alone is 61kb of it. The remaining lever is lazy-loading the landing route, which trades an extra round trip for ~20kb; not worth it. What matters held: **three.js (228kb gzip) and lightweight-charts stay in lazy chunks** and never touch the critical path. |

---

## 9. Prerequisites before Phase 2

**Nothing is required to start.** PSX DPS and Binance public data need no keys, which covers every current holding.

Optional, free, no card:

1. **Binance** *(Phase 3, for account sync)* — API Management → new key → **Enable Reading only** → IP whitelist
2. **Anthropic** *(Phase 5)* — console.anthropic.com
3. **CoinGecko Demo** *(nice-to-have)* — coin logos and metadata
4. **Finnhub / Alpha Vantage / Twelve Data** — only if US tickers are added later

All go in `server/.env`. Nothing goes in the client.

---

## 10. Portfolio baseline

The book as of the 2026-07-25 snapshot, used to seed development and validate the cost-basis maths:

**PSX — PKR**

| Symbol | Qty | Avg cost | Invested | Current | P/L |
|---|---:|---:|---:|---:|---:|
| FATIMA | 303 | 151.26 | 45,831.78 | 45,568.17 | −263.61 |
| FFC | 240 | 563.13 | 135,151.20 | 128,044.80 | −7,106.40 |
| HUBC | 100 | 190.75 | 19,075.00 | 21,397.00 | +2,322.00 |
| | | | **200,057.98** | **195,009.97** | **−5,048.01 (−2.52%)** |

**Binance — USDT:** BTC 0.00306088 (196.39) · WBETH 0.04014739 (82.57) · XRP 10.42481218 (11.38) → **290.34 USDT ≈ PKR 80,691.65**

Combined ≈ **PKR 275,702**. All three PSX sub-totals reconcile exactly against the broker's figures, so these are correct seed values for testing.

**Data quirk to handle:** WBETH reports a floating P/L equal to its entire value (`+82.57 USDT`, percent shown as `—`), meaning Binance holds no cost basis for it — typical of assets acquired through Earn/staking conversion rather than a spot trade. The importer must treat a missing cost basis as *unknown*, not as zero, or the position will show a fabricated 100% gain. Same applies to any airdropped or converted asset.

---

## 11. Open questions

1. **Base currency** — PKR is the obvious default given the book is PSX-dominated; Binance values arrive in USDT and need conversion. Confirm, and decide whether the USDT→PKR rate should come from an FX API or Binance's own USDT/PKR-equivalent pricing.
2. **Deployment** — local only, or hosted? Hosting makes §4.4's shared secret mandatory rather than optional.

---

*Not financial advice. This tool tracks and analyzes; investment decisions are yours.*
