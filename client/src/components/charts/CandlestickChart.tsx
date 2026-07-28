/**
 * Price history candlestick + volume.
 *
 * Uses lightweight-charts rather than hand-rolled SVG: OHLC with a synced
 * volume pane, crosshair, and pan/zoom is genuinely hard to get right, and the
 * library is 45kb and purpose-built for exactly this.
 *
 * Colours come from the app's own tokens read at runtime, so the chart follows
 * the theme rather than shipping its own palette.
 */
import { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '@aminfinance/shared';
import { resolveCssColor, rgbToHex } from '@/lib/cssColor';

interface CandlestickChartProps {
  candles: Candle[];
  height?: number;
  /** PSX EOD has no true intraday extremes; say so rather than implying precision. */
  note?: string | undefined;
}

/**
 * Read a theme token, normalized to `rgb()`.
 *
 * lightweight-charts' colour parser handles hex/rgb/hsl only — passing the raw
 * `oklch()` token throws `Failed to parse color` and takes the whole chart
 * down, so the value goes through the browser first.
 */
const cssVar = resolveCssColor;

export function CandlestickChart({ candles, height = 320, note }: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || candles.length === 0) return;

    const chart = createChart(container, {
      height,
      layout: {
        background: { color: 'transparent' },
        textColor: cssVar('--text-muted', '#888'),
        fontFamily: getComputedStyle(document.body).fontFamily,
      },
      grid: {
        vertLines: { color: cssVar('--viz-grid', '#e1e0d9') },
        horzLines: { color: cssVar('--viz-grid', '#e1e0d9') },
      },
      rightPriceScale: { borderColor: cssVar('--viz-axis', '#c3c2b7') },
      timeScale: {
        borderColor: cssVar('--viz-axis', '#c3c2b7'),
        timeVisible: false,
      },
      crosshair: { mode: 1 },
      handleScale: { axisPressedMouseMove: false },
    });
    chartRef.current = chart;

    const up = cssVar('--positive', '#1baf7a');
    const down = cssVar('--negative', '#e34948');

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
    });
    candleSeries.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    // Volume shares the pane but is scaled to the bottom fifth, so it reads as
    // context rather than competing with price. This is one price axis, not two.
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    // Volume bars are the same hues at ~25% alpha. The 8-digit hex form needs
    // real hex — appending an alpha pair to an `rgb()` string is not a colour.
    const upFaint = `${rgbToHex(up)}40`;
    const downFaint = `${rgbToHex(down)}40`;
    volumeSeries.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? upFaint : downFaint,
      })),
    );

    chart.timeScale().fitContent();

    const resize = () => chart.applyOptions({ width: container.clientWidth });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, height]);

  if (candles.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-text-muted"
        style={{ height }}
      >
        No price history available.
      </div>
    );
  }

  return (
    <div>
      <div ref={containerRef} style={{ height }} />
      {note ? <p className="mt-2 px-1 text-xs text-text-subtle">{note}</p> : null}
    </div>
  );
}
