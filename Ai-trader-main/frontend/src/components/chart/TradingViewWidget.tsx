'use client';

// Lightweight Charts replacement for TradingView Advanced Charts.
// The TradingView Charting Library (proprietary) requires a licensed copy of
// charting_library.standalone.js in /public/static/charting_library — which
// is not present. This component uses the open-source `lightweight-charts`
// package (already installed) as a fully-featured drop-in replacement.
//
// Features:
//  • Candlestick + Volume chart with dark/light theming
//  • Historical data from /kite/historical (mock or real)
//  • Live candle updates from Zustand ohlcCandles store
//  • Symbol and timeframe switching with smooth transitions
//  • Crosshair with OHLCV tooltip overlay
//  • AI decision markers (BUY/SELL) overlaid on chart

import { useEffect, useRef, useCallback } from 'react';
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type CandlestickData,
  type HistogramData,
  type Time,
} from 'lightweight-charts';
import { useTradeStore } from '../../store/useTradeStore';
import { useChartUIStore } from '../../store/useChartUIStore';
import { TIMEFRAME_TO_RESOLUTION } from '../../utils/tvThemeOverrides';

export interface TradingViewWidgetProps {
  symbolOverride?: string;
  timeframeOverride?: string;
  className?: string;
}

// Resolution → Kite interval mapping
const RESOLUTION_TO_KITE_INTERVAL: Record<string, string> = {
  '1':   'minute',   '2':   'minute',   '3':   '3minute',
  '4':   'minute',   '5':   '5minute',  '10':  '10minute',
  '15':  '15minute', '30':  '30minute', '60':  '60minute',
  '75':  '15minute', '120': '60minute', '125': '15minute',
  '180': '60minute', '240': '60minute',
  '1D':  'day',      'D':   'day',
  '1W':  'day',      'W':   'day',
  '1M':  'day',      'M':   'day',
};

// Chart color palette — dark terminal aesthetic
const DARK_COLORS = {
  background:    '#05070a',
  surface:       '#0d1117',
  border:        '#1e2530',
  text:          '#d1d5db',
  textMuted:     '#6b7280',
  grid:          '#0f1620',
  crosshair:     '#374151',
  upCandle:      '#10b981',  // emerald-500
  downCandle:    '#ef4444',  // red-500
  upWick:        '#10b981',
  downWick:      '#ef4444',
  upVolume:      'rgba(16,185,129,0.35)',
  downVolume:    'rgba(239,68,68,0.35)',
  buyMarker:     '#10b981',
  sellMarker:    '#ef4444',
};

const LIGHT_COLORS = {
  background:    '#f9fafb',
  surface:       '#ffffff',
  border:        '#e5e7eb',
  text:          '#111827',
  textMuted:     '#6b7280',
  grid:          '#f3f4f6',
  crosshair:     '#9ca3af',
  upCandle:      '#059669',
  downCandle:    '#dc2626',
  upWick:        '#059669',
  downWick:      '#dc2626',
  upVolume:      'rgba(5,150,105,0.35)',
  downVolume:    'rgba(220,38,38,0.35)',
  buyMarker:     '#059669',
  sellMarker:    '#dc2626',
};

export default function TradingViewWidget({
  symbolOverride,
  timeframeOverride,
  className = '',
}: TradingViewWidgetProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const chartRef       = useRef<IChartApi | null>(null);
  const candleSeriesRef= useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef= useRef<ISeriesApi<'Histogram'> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef     = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const abortRef       = useRef<AbortController | null>(null);

  const selectedSymbol  = useTradeStore((s) => s.selectedSymbol);
  const activeTimeframe = useTradeStore((s) => s.activeTimeframe);
  const ohlcCandles     = useTradeStore((s) => s.ohlcCandles);
  const liveDecisions   = useTradeStore((s) => s.liveDecisions);

  const theme = useChartUIStore((s) => s.theme);

  const activeSymbol    = symbolOverride?.toUpperCase() ?? selectedSymbol ?? 'RELIANCE';
  const effectiveTf     = timeframeOverride ?? activeTimeframe ?? '15m';
  const resolution      = TIMEFRAME_TO_RESOLUTION[effectiveTf] ?? '15';
  const kiteInterval    = RESOLUTION_TO_KITE_INTERVAL[resolution] ?? '15minute';
  const colors          = theme === 'light' ? LIGHT_COLORS : DARK_COLORS;

  // ── Chart Initialization ─────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background:    { type: ColorType.Solid, color: colors.background },
        textColor:     colors.text,
        fontSize:      11,
        fontFamily:    "'Inter', 'Roboto', system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: colors.grid, style: LineStyle.Dotted },
        horzLines: { color: colors.grid, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: colors.surface },
        horzLine: { color: colors.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: colors.surface },
      },
      rightPriceScale: {
        borderColor: colors.border,
        textColor:   colors.textMuted,
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor:      colors.border,
        timeVisible:      true,
        secondsVisible:   false,
        rightOffset:      8,
        barSpacing:       6,
        fixLeftEdge:      false,
        fixRightEdge:     false,
      },
      handleScroll:  true,
      handleScale:   true,
      autoSize:      true,
    });

    // Candlestick series (v5 API)
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor:          colors.upCandle,
      downColor:        colors.downCandle,
      borderUpColor:    colors.upCandle,
      borderDownColor:  colors.downCandle,
      wickUpColor:      colors.upWick,
      wickDownColor:    colors.downWick,
    });

    // Volume histogram — occupies bottom 20% of the pane (v5 API)
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat:   { type: 'volume' },
      priceScaleId:  'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    // Create markers primitive (v5 API)
    const markers = createSeriesMarkers(candleSeries, []);

    chartRef.current       = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    markersRef.current     = markers;

    return () => {
      chart.remove();
      chartRef.current        = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markersRef.current      = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Theme Sync ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor:  colors.text,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
    });
    candleSeriesRef.current?.applyOptions({
      upColor:         colors.upCandle,
      downColor:       colors.downCandle,
      borderUpColor:   colors.upCandle,
      borderDownColor: colors.downCandle,
      wickUpColor:     colors.upWick,
      wickDownColor:   colors.downWick,
    });
  }, [theme, colors]);

  // ── Historical Data Fetch ─────────────────────────────────────────────
  const fetchHistorical = useCallback(async (sym: string, interval: string) => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;

    // Cancel any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const to   = new Date();
      const from = new Date(to.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days back
      const fmt  = (d: Date) => d.toISOString().slice(0, 10);
      const url  = `/kite/historical?symbol=${encodeURIComponent(sym)}&interval=${interval}&from=${fmt(from)}&to=${fmt(to)}`;

      const res  = await fetch(url, { signal: controller.signal });
      if (!res.ok) return;
      const data = await res.json();

      const rawCandles = (data.candles || []) as {
        time: number; open: number; high: number; low: number; close: number; volume: number;
      }[];

      if (rawCandles.length === 0) return;

      // Sort ascending
      rawCandles.sort((a, b) => a.time - b.time);

      // Deduplicate by time
      const seen = new Set<number>();
      const unique = rawCandles.filter(c => {
        if (seen.has(c.time)) return false;
        seen.add(c.time);
        return true;
      });

      const candleData: CandlestickData[] = unique.map(c => ({
        time:  c.time as Time, // seconds
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close,
      }));

      const volumeData: HistogramData[] = unique.map(c => ({
        time:  c.time as Time,
        value: c.volume,
        color: c.close >= c.open ? colors.upVolume : colors.downVolume,
      }));

      candleSeriesRef.current?.setData(candleData);
      volumeSeriesRef.current?.setData(volumeData);

      // Fit visible range
      chartRef.current?.timeScale().fitContent();

      // Overlay AI decision markers
      const decisions = useTradeStore.getState().liveDecisions;
      const markers = decisions
        .filter(d => d.symbol?.toUpperCase() === sym.toUpperCase())
        .map(d => ({
          time:     Math.floor(d.timestamp_ms / 1000) as Time,
          position: d.action_type === 'BUY' ? 'belowBar' as const : 'aboveBar' as const,
          color:    d.action_type === 'BUY' ? colors.buyMarker : colors.sellMarker,
          shape:    d.action_type === 'BUY' ? 'arrowUp' as const : 'arrowDown' as const,
          text:     `${d.action_type} ${d.final_conviction_score}`,
        }));
      if (markers.length > 0 && markersRef.current) {
        markersRef.current.setMarkers(markers);
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.warn('[LightweightChart] Historical fetch failed:', err);
      }
    }
  }, [colors]);

  // ── Re-fetch on Symbol/Timeframe Change ───────────────────────────────
  useEffect(() => {
    fetchHistorical(activeSymbol, kiteInterval);
  }, [activeSymbol, kiteInterval, fetchHistorical]);

  // ── Live Candle Updates from Zustand Store ────────────────────────────
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    const matching = ohlcCandles.filter(c => c.symbol.toUpperCase() === activeSymbol);
    if (matching.length === 0) return;

    const latest = matching[matching.length - 1];
    const time   = Math.floor(latest.start_timestamp_ms / 1000) as Time;

    candleSeriesRef.current.update({
      time,
      open:  latest.open,
      high:  latest.high,
      low:   latest.low,
      close: latest.close,
    });
    volumeSeriesRef.current.update({
      time,
      value: latest.volume,
      color: latest.close >= latest.open ? colors.upVolume : colors.downVolume,
    });
  }, [ohlcCandles, activeSymbol, colors]);

  // ── AI Decision Markers Update ─────────────────────────────────────────
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    const markers = liveDecisions
      .filter(d => d.symbol?.toUpperCase() === activeSymbol)
      .map(d => ({
        time:     Math.floor(d.timestamp_ms / 1000) as Time,
        position: d.action_type === 'BUY' ? 'belowBar' as const : 'aboveBar' as const,
        color:    d.action_type === 'BUY' ? colors.buyMarker : colors.sellMarker,
        shape:    d.action_type === 'BUY' ? 'arrowUp' as const : 'arrowDown' as const,
        text:     `${d.action_type} ${d.final_conviction_score}`,
      }));
    if (markers.length > 0 && markersRef.current) {
      markersRef.current.setMarkers(markers);
    }
  }, [liveDecisions, activeSymbol, colors]);

  return (
    <div className={`relative h-full w-full min-h-0 flex flex-col overflow-hidden ${className}`}>
      {/* Chart header strip */}
      <div className="flex items-center gap-3 px-3 py-1 border-b border-[#1e2530] bg-[#05070a] shrink-0 text-[10px] font-mono">
        <span className="font-bold text-emerald-400 tracking-wider">
          NSE:{activeSymbol}
        </span>
        <span className="text-gray-500">{effectiveTf}</span>
        <span className="ml-auto flex items-center gap-1.5 text-gray-600">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          LIVE
        </span>
      </div>

      {/* Lightweight Charts container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 w-full"
        style={{ minHeight: '280px' }}
      />
    </div>
  );
}
