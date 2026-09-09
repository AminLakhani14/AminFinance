/**
 * Client half of the live crypto price stream.
 *
 * A single module-level socket shared by every component, mirroring the
 * server's own one-socket-per-process design: a hook that opened its own
 * connection would put one socket per mounted row on the wire for identical
 * data.
 *
 * State lives outside React and is read through `useSyncExternalStore`, not
 * Redux. Ticks arrive several times a second per symbol; routing them through
 * the store would re-render every connected component on every tick, when the
 * only thing that changed is one number in one row. Subscribers here are keyed
 * by symbol, so a BTC tick wakes the BTC cell and nothing else.
 *
 * PSX has no streaming endpoint, so stocks keep using the polled REST route.
 * Only Binance pairs ever appear here.
 */
import type {
  PriceTickMessage,
  PriceStreamServerMessage,
  PriceSubscribeMessage,
} from '@aminfinance/shared';

export interface LiveTick {
  symbol: string;
  price: number;
  changePercent: number;
  timestamp: number;
  /** Direction versus the previous tick — drives the flash, not the colour. */
  direction: 'up' | 'down' | 'flat';
}

const ticks = new Map<string, LiveTick>();
const symbolListeners = new Map<string, Set<() => void>>();
const statusListeners = new Set<() => void>();

/** Symbols wanted, and how many components want each. */
const interest = new Map<string, number>();

let socket: WebSocket | null = null;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Coalesces a burst of mounts into one subscribe frame. */
let resyncTimer: ReturnType<typeof setTimeout> | null = null;

function streamUrl(): string {
  const base = import.meta.env.VITE_API_URL;
  if (base) {
    return `${String(base).replace(/^http/, 'ws').replace(/\/$/, '')}/ws/prices`;
  }
  // Same origin in dev: Vite proxies /ws through to Fastify with ws: true.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/prices`;
}

function notifySymbol(symbol: string): void {
  for (const listener of symbolListeners.get(symbol) ?? []) listener();
}

function notifyStatus(): void {
  for (const listener of statusListeners) listener();
}

function setConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  notifyStatus();
}

function wantedSymbols(): string[] {
  return [...interest.keys()];
}

/** Push the current interest set to the server. No-op while disconnected. */
function sendSubscription(): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const message: PriceSubscribeMessage = { type: 'subscribe', symbols: wantedSymbols() };
  socket.send(JSON.stringify(message));
}

function scheduleResync(): void {
  if (resyncTimer) return;
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    sendSubscription();
  }, 50);
}

function handleMessage(raw: string): void {
  let message: PriceStreamServerMessage;
  try {
    message = JSON.parse(raw) as PriceStreamServerMessage;
  } catch {
    return;
  }

  if (message.type === 'status') {
    setConnected(message.connected);
    return;
  }

  const tick = message as PriceTickMessage;
  if (typeof tick.symbol !== 'string' || !Number.isFinite(tick.price)) return;

  const previous = ticks.get(tick.symbol);
  const direction =
    previous === undefined || previous.price === tick.price
      ? 'flat'
      : tick.price > previous.price
        ? 'up'
        : 'down';

  ticks.set(tick.symbol, {
    symbol: tick.symbol,
    price: tick.price,
    changePercent: tick.changePercent,
    timestamp: tick.timestamp,
    direction,
  });
  notifySymbol(tick.symbol);
}

function connect(): void {
  if (socket || interest.size === 0) return;

  const ws = new WebSocket(streamUrl());
  socket = ws;

  ws.addEventListener('open', () => {
    reconnectAttempts = 0;
    sendSubscription();
  });

  ws.addEventListener('message', (event) => handleMessage(String(event.data)));

  ws.addEventListener('close', () => {
    if (socket !== ws) return; // superseded
    socket = null;
    setConnected(false);
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // 'close' always follows; reconnect is handled there.
  });
}

/** Exponential backoff capped at 30s, matching the server's own policy. */
function scheduleReconnect(): void {
  if (reconnectTimer || interest.size === 0) return;
  const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempts);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function disconnectIfIdle(): void {
  if (interest.size > 0 || !socket) return;
  socket.close();
  socket = null;
  setConnected(false);
}

/**
 * Register interest in a set of symbols. Returns an unsubscribe function.
 *
 * Reference-counted: two tables showing BTCUSDT keep one upstream
 * subscription, and it is only dropped when the last of them unmounts.
 */
export function retainSymbols(symbols: string[]): () => void {
  const upper = [...new Set(symbols.map((s) => s.toUpperCase()))];
  for (const symbol of upper) {
    interest.set(symbol, (interest.get(symbol) ?? 0) + 1);
  }

  connect();
  scheduleResync();

  return () => {
    for (const symbol of upper) {
      const count = (interest.get(symbol) ?? 1) - 1;
      if (count <= 0) interest.delete(symbol);
      else interest.set(symbol, count);
    }
    scheduleResync();
    disconnectIfIdle();
  };
}

export function subscribeToSymbol(symbol: string, listener: () => void): () => void {
  const key = symbol.toUpperCase();
  let listeners = symbolListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    symbolListeners.set(key, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) symbolListeners.delete(key);
  };
}

export function getTick(symbol: string): LiveTick | undefined {
  return ticks.get(symbol.toUpperCase());
}

export function subscribeToStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export function isConnected(): boolean {
  return connected;
}
