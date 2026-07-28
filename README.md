# AminFinance

Portfolio tracking and analytics for stocks and Binance crypto — live P/L, charts, dividend calendar, news, and AI-generated commentary.

See [PROJECT_PLAN.md](./PROJECT_PLAN.md) for the full architecture and roadmap.

**Status: all six phases complete.** Live PSX + Binance data, cost-basis P/L, charts, analytics, AI insights, and 3D visuals.

---

## Quick start

```bash
npm install
cp server/.env.example server/.env      # add your API keys here
npm run dev
```

- Client → http://localhost:5173
- Server → http://127.0.0.1:3001/health

### Load your portfolio

Go to **Portfolio → Import CSV → Choose CSV file** and pick [`my-portfolio.csv`](./my-portfolio.csv) from the repo root. It is pre-filled with the PSX and Binance positions from the broker screenshots.

Your data lives in **your browser's IndexedDB**, so it is per-browser and per-profile — importing in Chrome does not populate Firefox, and a different Chrome profile starts empty. **Export** writes the same format back out, which doubles as a backup.

The importer is idempotent: re-importing the same file adds nothing.

### Positions with no cost basis

Some assets arrive without a purchase price — Binance Earn and staking conversions, airdrops, transfers in. Binance reports these with a floating P/L equal to the entire position value, because it holds no cost for them.

Such a position is imported with `price` set to **0, meaning "unknown", not "free"**. The app then:

- shows the position and its real market value, and counts it in **Total value**
- displays **"—"** for average cost and P/L, with a `cost unknown` badge
- **excludes** it from portfolio-level Invested and Unrealised P/L

Booking it at zero cost would report the whole position as profit and inflate your returns. Edit the transaction with what you actually paid and P/L starts working.

The server boots with **no keys at all**. Every provider degrades independently, so you can add one key at a time and watch the Dashboard checklist light up.

If `npm install` warns about blocked install scripts, run `npm approve-scripts esbuild` — Vite needs esbuild's platform binary.

> **Editing `server/.env` requires a manual restart.** `tsx watch` only reloads on changes to files in the module graph, and `.env` is read by dotenv at runtime rather than imported. Stop and re-run `npm run dev` after changing a key, or the server keeps serving the old config with no indication anything changed.

---

## Layout

```
client/    React 19 + Vite + Redux Toolkit + Tailwind v4
server/    Node + Fastify — key custody, Binance sync, shared cache
shared/    DTOs imported by both sides
```

The three are npm workspaces. `shared/` ships TypeScript source rather than a build, so changing a DTO surfaces as a compile error on both sides immediately.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Both processes, colour-tagged |
| `npm run dev:server` / `npm run dev:client` | One at a time |
| `npm run typecheck` | All three workspaces |
| `npm run build` | Production build |

---

## Why there's a server

A browser-only build is impossible here, for two reasons that no library works around:

1. **Binance's signed endpoints are CORS-blocked.** `/api/v3/account` — your balances — requires the `X-MBX-APIKEY` header, which triggers a preflight Binance does not answer. Public market data (prices, candles) works fine from the browser; account data does not. From Node there is no CORS at all.
2. **API keys cannot live in frontend code.** Anything in browser JavaScript is readable via DevTools or any extension on the page.

A third reason makes it clearly worth having: Alpha Vantage's free tier is **25 requests/day**, and it's the only free source of next-dividend dates. A shared server cache turns that from a hard ceiling into a soft one — one fetch per symbol per day covers every session and device instead of every browser paying separately.

The server holds no portfolio data. Your transactions live in IndexedDB in the browser; delete the server and rebuild it from `.env` alone.

---

## Security

**The server holds live credentials.** Defaults are set up so that a mistake fails closed:

- Binds to `127.0.0.1`. Setting `HOST` to anything else **without** `AUTH_SECRET` makes the server refuse to start.
- With `AUTH_SECRET` set, every `/api/*` request needs the `x-aminfinance-key` header (timing-safe comparison). `/health` is exempt and exposes booleans only.
- Strict CORS allowlist.

**Create the Binance key read-only** — "Enable Reading" only, no trading, no withdrawals, with an IP whitelist. A full compromise of the server then exposes your balances but never your funds.

Nothing prefixed `VITE_` is secret; those values are inlined into the bundle. Upstream keys belong in `server/.env` only.

### Known advisory

`react-router` carries one unpatched high-severity advisory: *RSC Mode CSRF Bypass*. No fixed version exists — it affects every release from 7.12.0 up. It is **not reachable here**: this is a plain SPA using `BrowserRouter`, with no RSC mode, framework mode, or server actions. Pinning below the range was tried and rejected — 7.11.x is exposed to considerably more, and more relevant, issues (open redirect via `<Link>`/`useNavigate`, XSS via open redirects, DoS via route matching), all of which 7.18.1 fixes. Revisit when a patched release ships.

---

## What's built

| Area | Detail |
|---|---|
| **Market data** | PSX quotes, ~5y daily OHLCV, fundamentals (market cap, P/E, 52w), company announcements. Binance spot quotes, klines, and a shared WebSocket price stream fanned out to every tab. |
| **Portfolio** | FIFO cost basis with fee handling, per-lot tracking, realised/unrealised P/L, multi-currency totals via live FX. Manual entry, CSV import/export, and idempotent Binance trade import. |
| **Charts** | Candlestick + volume, portfolio area chart with cost baseline, allocation donut, correlation heatmap, in-table sparklines — all on a colorblind-validated palette. |
| **Analytics** | Annualised volatility, Sharpe, max drawdown, correlation matrix, best/worst, asset-class split. |
| **AI** | Per-asset verdict with bull/bear/risks and a note on *your* cost basis; whole-portfolio review with concentration flags and rebalancing. Structured output, 24h cached. |
| **3D** | Particle hero driven by the day's move — lazy-loaded, `frameloop="demand"`, disabled under reduced-motion with a CSS fallback. |

### Verified against real data

Every PSX figure reconciles against the JS InvestPro broker app: FFC market value **PKR 128,044.80** and P/L **−7,106.40**, HUBC **+2,322.00** — identical. Correlation is coherent too: PSX names cluster (FFC↔HUBC 0.86), crypto clusters (BTC↔XRP 0.85), and the two blocks are independent (≈−0.1).

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Workspace, server skeleton, client shell, theming | Done |
| 2 | Provider adapters, market-data routes, cache, rate limiting | Done |
| 3 | Portfolio CRUD, cost basis, Binance sync, live P/L | Done |
| 4 | Charts and analytics | Done |
| 5 | News and AI insights | Done |
| 6 | 3D visuals and polish | Done |

### Known gaps

- **Dividends return empty.** PSX renders its payouts section client-side, so there is no server-rendered dividend history to parse. The route and UI degrade cleanly rather than fabricating dates. Revisit if PSX exposes a JSON payouts endpoint.
- **Crypto news** has no free provider configured; the News page says so instead of showing an empty feed.
- **PSX daily high/low** is the open–close range, not intraday extremes — the EOD feed carries no true high/low. The chart caption states this.
- **Portfolio value history** is reconstructed from current holdings against past prices, so it shows how *today's* book would have moved, not realised performance. Labelled as such.

---

*Not financial advice. This tool tracks and analyzes; investment decisions are yours.*
