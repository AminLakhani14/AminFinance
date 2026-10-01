/**
 * Live crypto price stream.
 *
 * One upstream Binance WebSocket is shared by every connected browser tab.
 * Without this, five open tabs would open five sockets to Binance and burn
 * five times the connection budget for identical data.
 *
 * PSX has no public streaming endpoint, so stocks stay on the polled REST
 * route; only crypto is pushed.
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type {
  PriceStreamClientMessage,
  PriceTickMessage,
  PriceStatusMessage,
} from '@aminfinance/shared';

/**
 * Binance's market-data-only stream host. Same `/stream?streams=` interface as
 * stream.binance.com, but it serves hosted servers that the main host refuses
 * (see the host note in `providers/binance.ts`).
 */
const BINANCE_WS = 'wss://data-stream.binance.vision/stream';

/** Client sockets and the symbols each one wants. */
const clients = new Map<WebSocket, Set<string>>();

let upstream: globalThis.WebSocket | null = null;
let subscribedSymbols = new Set<string>();
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

/** Union of every client's interest — what we actually subscribe to upstream. */
function desiredSymbols(): Set<string> {
  const all = new Set<string>();
  for (const symbols of clients.values()) {
    for (const s of symbols) all.add(s);
  }
  return all;
}

/**
 * Whether the upstream socket is genuinely open.
 *
 * Not `upstream?.readyState === upstream?.OPEN`: when `upstream` is null both
 * sides are `undefined` and that comparison is true, so a dead stream reports
 * as connected. That made the reconnect check below treat "no socket, same
 * symbols" as "already connected correctly" and return without reconnecting —
 * the stream never came back after a drop.
 */
function isUpstreamOpen(): boolean {
  return upstream !== null && upstream.readyState === upstream.OPEN;
}

function broadcast(message: PriceTickMessage | PriceStatusMessage): void {
  const payload = JSON.stringify(message);
  for (const [socket, symbols] of clients) {
    if (socket.readyState !== socket.OPEN) continue;
    // Only forward a tick to clients that asked for that symbol.
    if (message.type === 'tick' && !symbols.has(message.symbol)) continue;
    try {
      socket.send(payload);
    } catch {
      // A failed send means the socket is going away; cleanup handles it.
    }
  }
}

function streamNames(symbols: Set<string>): string[] {
  return [...symbols].map((s) => `${s.toLowerCase()}@ticker`);
}

function connectUpstream(log: FastifyInstance['log']): void {
  const wanted = desiredSymbols();

  if (wanted.size === 0) {
    if (upstream) {
      upstream.close();
      upstream = null;
      subscribedSymbols = new Set();
    }
    return;
  }

  // Already connected with the right subscription set — nothing to do.
  const same =
    isUpstreamOpen() &&
    wanted.size === subscribedSymbols.size &&
    [...wanted].every((s) => subscribedSymbols.has(s));
  if (same) return;

  if (upstream) {
    upstream.close();
    upstream = null;
  }

  const url = `${BINANCE_WS}?streams=${streamNames(wanted).join('/')}`;
  const socket = new globalThis.WebSocket(url);
  upstream = socket;
  subscribedSymbols = wanted;

  socket.addEventListener('open', () => {
    reconnectAttempts = 0;
    log.info({ symbols: [...wanted] }, 'Binance price stream connected');
    broadcast({ type: 'status', connected: true });
  });

  socket.addEventListener('message', (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as {
        data?: { s?: string; c?: string; P?: string; E?: number };
      };
      const d = frame.data;
      if (!d?.s || !d.c) return;
      broadcast({
        type: 'tick',
        symbol: d.s,
        price: Number(d.c),
        changePercent: Number(d.P ?? 0),
        timestamp: d.E ?? Date.now(),
      });
    } catch {
      // Malformed frame — skip it rather than tear down the stream.
    }
  });

  socket.addEventListener('close', () => {
    if (upstream !== socket) return; // superseded by a newer connection
    upstream = null;
    broadcast({ type: 'status', connected: false, message: 'Reconnecting…' });
    scheduleReconnect(log);
  });

  socket.addEventListener('error', () => {
    // 'close' always follows; reconnect is handled there.
    log.warn('Binance price stream error');
  });
}

/** Exponential backoff, capped — a flapping upstream must not become a hot loop. */
function scheduleReconnect(log: FastifyInstance['log']): void {
  if (reconnectTimer || clients.size === 0) return;
  const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempts);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectUpstream(log);
  }, delay);
  reconnectTimer.unref?.();
}

export async function priceStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws/prices', { websocket: true }, (socket) => {
    clients.set(socket, new Set());

    const status: PriceStatusMessage = {
      type: 'status',
      connected: isUpstreamOpen(),
    };
    socket.send(JSON.stringify(status));

    socket.on('message', (raw: Buffer) => {
      let message: PriceStreamClientMessage;
      try {
        message = JSON.parse(raw.toString()) as PriceStreamClientMessage;
      } catch {
        return;
      }

      if (message.type === 'subscribe') {
        const symbols = new Set(
          (message.symbols ?? [])
            .filter((s) => typeof s === 'string')
            .map((s) => s.toUpperCase())
            .slice(0, 50),
        );
        clients.set(socket, symbols);
        connectUpstream(app.log);
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      // Drop or narrow the upstream subscription when interest changes.
      connectUpstream(app.log);
    });

    socket.on('error', () => {
      clients.delete(socket);
    });
  });

  app.addHook('onClose', async () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    upstream?.close();
    upstream = null;
  });
}
