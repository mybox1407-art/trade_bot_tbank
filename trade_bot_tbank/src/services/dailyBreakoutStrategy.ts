import { ATR, SMA } from 'technicalindicators';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type BreakoutSide = 'long' | 'short' | 'none';

export interface DailyBreakoutSignal {
  symbol: string;
  side: BreakoutSide;
  entryPrice: number | null;
  stopLossPrice: number | null;
  trailingStopPrice: number | null;
  reverseLevel: number | null;
  takeProfitPrice: number | null;
  quantity: number | null;
  positionSize: number | null;
  atr: number | null;
  sma20: number | null;
  prevDayHigh: number | null;
  prevDayLow: number | null;
  riskPerShare: number | null;
  riskCapital: number | null;
  breakoutDistancePct: number | null;
  regime: 'trend_up' | 'trend_down' | 'none';
  indicators: {
    ready: boolean;
    close: number | null;
    aboveSma20: boolean;
    belowSma20: boolean;
    atrPct: number | null;
    trailingAtrMult: number;
    stopAtrMult: number;
  };
}

export interface DailyBreakoutPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  stopLossPrice: number;
  trailingStopPrice: number;
  reverseLevel: number;
  atrAtEntry: number;
  highestHighSinceEntry: number;
  lowestLowSinceEntry: number;
  quantity: number;
  positionSize: number;
  riskPerShare: number;
  openedAt: number;
  regime: 'trend_up' | 'trend_down';
}

export interface DailyBreakoutOptions {
  riskPerTrade?: number;
  stopAtrMult?: number;
  trailingAtrMult?: number;
  smaPeriod?: number;
  atrPeriod?: number;
  minAtrPct?: number;
  maxAtrPct?: number;
  maxBreakoutDistancePct?: number;
  allowLongs?: boolean;
  allowShorts?: boolean;
}

const DEFAULT_OPTIONS: Required<DailyBreakoutOptions> = {
  riskPerTrade: 0.01,
  stopAtrMult: 2.5,
  trailingAtrMult: 2.0,
  smaPeriod: 20,
  atrPeriod: 14,
  minAtrPct: 0.008,
  maxAtrPct: 0.12,
  maxBreakoutDistancePct: 0.04,
  allowLongs: true,
  allowShorts: true
};

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function resolveOptions(
  options: DailyBreakoutOptions = {}
): Required<DailyBreakoutOptions> {
  return {
    riskPerTrade: options.riskPerTrade ?? DEFAULT_OPTIONS.riskPerTrade,
    stopAtrMult: options.stopAtrMult ?? DEFAULT_OPTIONS.stopAtrMult,
    trailingAtrMult: options.trailingAtrMult ?? DEFAULT_OPTIONS.trailingAtrMult,
    smaPeriod: options.smaPeriod ?? DEFAULT_OPTIONS.smaPeriod,
    atrPeriod: options.atrPeriod ?? DEFAULT_OPTIONS.atrPeriod,
    minAtrPct: options.minAtrPct ?? DEFAULT_OPTIONS.minAtrPct,
    maxAtrPct: options.maxAtrPct ?? DEFAULT_OPTIONS.maxAtrPct,
    maxBreakoutDistancePct:
      options.maxBreakoutDistancePct ?? DEFAULT_OPTIONS.maxBreakoutDistancePct,
    allowLongs: options.allowLongs ?? DEFAULT_OPTIONS.allowLongs,
    allowShorts: options.allowShorts ?? DEFAULT_OPTIONS.allowShorts
  };
}

function buildEmptySignal(symbol: string): DailyBreakoutSignal {
  return {
    symbol,
    side: 'none',
    entryPrice: null,
    stopLossPrice: null,
    trailingStopPrice: null,
    reverseLevel: null,
    takeProfitPrice: null,
    quantity: null,
    positionSize: null,
    atr: null,
    sma20: null,
    prevDayHigh: null,
    prevDayLow: null,
    riskPerShare: null,
    riskCapital: null,
    breakoutDistancePct: null,
    regime: 'none',
    indicators: {
      ready: false,
      close: null,
      aboveSma20: false,
      belowSma20: false,
      atrPct: null,
      trailingAtrMult: DEFAULT_OPTIONS.trailingAtrMult,
      stopAtrMult: DEFAULT_OPTIONS.stopAtrMult
    }
  };
}

export function getDailyBreakoutWarmup(
  options: DailyBreakoutOptions = {}
): number {
  const resolved = resolveOptions(options);
  return Math.max(resolved.smaPeriod + 2, resolved.atrPeriod + 2, 30);
}

export function analyzeDailyBreakout(
  symbol: string,
  candles: Candle[],
  balance: number,
  options: DailyBreakoutOptions = {}
): DailyBreakoutSignal {
  const resolved = resolveOptions(options);

  const minBars = getDailyBreakoutWarmup(resolved);
  if (!Array.isArray(candles) || candles.length < minBars) {
    return buildEmptySignal(symbol);
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const smaSeries = SMA.calculate({
    period: resolved.smaPeriod,
    values: closes
  });

  const atrSeries = ATR.calculate({
    period: resolved.atrPeriod,
    high: highs,
    low: lows,
    close: closes
  });

  if (!smaSeries.length || !atrSeries.length) {
    return buildEmptySignal(symbol);
  }

  const current = last(candles);
  const prev = candles[candles.length - 2];
  const sma20 = last(smaSeries);
  const atr = last(atrSeries);

  if (!current || !prev || !Number.isFinite(sma20) || !Number.isFinite(atr)) {
    return buildEmptySignal(symbol);
  }

  const price = current.close;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(atr) || atr <= 0) {
    return buildEmptySignal(symbol);
  }

  const prevDayHigh = prev.high;
  const prevDayLow = prev.low;
  const aboveSma20 = price > sma20;
  const belowSma20 = price < sma20;
  const atrPct = atr / price;

  if (atrPct < resolved.minAtrPct || atrPct > resolved.maxAtrPct) {
    return {
      ...buildEmptySignal(symbol),
      sma20: round(sma20),
      atr: round(atr),
      prevDayHigh: round(prevDayHigh),
      prevDayLow: round(prevDayLow),
      indicators: {
        ready: true,
        close: round(price),
        aboveSma20,
        belowSma20,
        atrPct: round(atrPct, 6),
        trailingAtrMult: resolved.trailingAtrMult,
        stopAtrMult: resolved.stopAtrMult
      }
    };
  }

  let side: BreakoutSide = 'none';
  let regime: 'trend_up' | 'trend_down' | 'none' = 'none';
  let entryPrice: number | null = null;
  let reverseLevel: number | null = null;

  if (resolved.allowLongs && aboveSma20 && current.high > prevDayHigh) {
    side = 'long';
    regime = 'trend_up';
    entryPrice = Math.max(prevDayHigh, current.open);
    reverseLevel = prevDayLow;
  } else if (resolved.allowShorts && belowSma20 && current.low < prevDayLow) {
    side = 'short';
    regime = 'trend_down';
    entryPrice = Math.min(prevDayLow, current.open);
    reverseLevel = prevDayHigh;
  }

  if (side === 'none' || entryPrice == null || reverseLevel == null) {
    return {
      ...buildEmptySignal(symbol),
      sma20: round(sma20),
      atr: round(atr),
      prevDayHigh: round(prevDayHigh),
      prevDayLow: round(prevDayLow),
      regime: 'none',
      indicators: {
        ready: true,
        close: round(price),
        aboveSma20,
        belowSma20,
        atrPct: round(atrPct, 6),
        trailingAtrMult: resolved.trailingAtrMult,
        stopAtrMult: resolved.stopAtrMult
      }
    };
  }

  const breakoutDistancePct = Math.abs(entryPrice - price) / price;
  if (breakoutDistancePct > resolved.maxBreakoutDistancePct) {
    return {
      ...buildEmptySignal(symbol),
      sma20: round(sma20),
      atr: round(atr),
      prevDayHigh: round(prevDayHigh),
      prevDayLow: round(prevDayLow),
      breakoutDistancePct: round(breakoutDistancePct, 6),
      regime: 'none',
      indicators: {
        ready: true,
        close: round(price),
        aboveSma20,
        belowSma20,
        atrPct: round(atrPct, 6),
        trailingAtrMult: resolved.trailingAtrMult,
        stopAtrMult: resolved.stopAtrMult
      }
    };
  }

  const stopLossPrice =
    side === 'long'
      ? entryPrice - atr * resolved.stopAtrMult
      : entryPrice + atr * resolved.stopAtrMult;

  const trailingStopPrice =
    side === 'long'
      ? current.high - atr * resolved.trailingAtrMult
      : current.low + atr * resolved.trailingAtrMult;

  const riskPerShare = Math.abs(entryPrice - stopLossPrice);
  if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) {
    return buildEmptySignal(symbol);
  }

  const riskCapital = balance * resolved.riskPerTrade;
  let quantity = Math.floor(riskCapital / riskPerShare);

  if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;

  const positionSize = quantity * entryPrice;

  return {
    symbol,
    side,
    entryPrice: round(entryPrice),
    stopLossPrice: round(stopLossPrice),
    trailingStopPrice: round(trailingStopPrice),
    reverseLevel: round(reverseLevel),
    takeProfitPrice: null,
    quantity,
    positionSize: round(positionSize, 6),
    atr: round(atr),
    sma20: round(sma20),
    prevDayHigh: round(prevDayHigh),
    prevDayLow: round(prevDayLow),
    riskPerShare: round(riskPerShare),
    riskCapital: round(riskCapital, 6),
    breakoutDistancePct: round(breakoutDistancePct, 6),
    regime,
    indicators: {
      ready: true,
      close: round(price),
      aboveSma20,
      belowSma20,
      atrPct: round(atrPct, 6),
      trailingAtrMult: resolved.trailingAtrMult,
      stopAtrMult: resolved.stopAtrMult
    }
  };
}

export function buildDailyBreakoutPositionFromSignal(
  signal: 
