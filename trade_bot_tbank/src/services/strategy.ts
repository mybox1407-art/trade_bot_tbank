import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

// ============================================================================
// КАПИТАЛ / РИСК
// ============================================================================
export const STARTING_BALANCE = 50000;
/** Baseline 1% — 2% раздувал убытки без роста PF */
export const MAX_RISK_PER_TRADE = 0.01;

export const COMMISSION_RATE = 0.0005;
export const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2;

/**
 * Path Exit v1 (вход primary без ужесточения):
 * TP1 40% @ 1.5R → SL runner = entry (lock 0) → TP2 @ 2.0R
 * Early abort / time-stop задаются в runBacktest options.
 */
export const TP1_FRACTION = 0.4;
export const TP1_R = 1.5;
export const TP2_R = 2.0;
export const PARTIAL_LOCK_R = 0;

const MIN_STOP_DISTANCE_RATE = 0.005;
const MAX_STOP_DISTANCE_RATE = 0.012;

const MAX_POSITION_FRAC = 0.3;
const MAX_COMMISSION_SHARE_OF_RISK = 0.28;

const MIN_ADX_TREND = 20;
const STOP_STRUCTURE_LOOKBACK = 10;
const STOP_SWING_PAD_ATR = 0.25;
const MAX_EXTENSION_FROM_EMA20 = 0.01;

/** 10:00–18:00 МСК = 07:00–15:00 UTC */
const TRADING_HOUR_UTC_FROM = 7;
const TRADING_HOUR_UTC_TO = 15;

const MIN_QUANTITY = 2;

/** Мин. 15m-баров при HTF */
export const HTF_WARMUP_15M = 850;
const MS_PER_HOUR = 3_600_000;

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MarketRegime =
  | 'trend_up'
  | 'trend_down'
  | 'range'
  | 'breakout_watch'
  | 'high_volatility'
  | 'unknown';

export type HtfBias = 'up' | 'down' | 'neutral';

export interface HtfBarState {
  time: number;
  bias: HtfBias;
  adx: number;
  ema20: number;
  ema50: number;
  ema200: number;
  close: number;
}

export interface HtfFilterOptions {
  enabled: boolean;
  minAdx1h?: number;
  precomputedHtf?: HtfBarState[];
}

export const DEFAULT_HTF_FILTER: HtfFilterOptions = {
  enabled: false,
  minAdx1h: 18
};

export interface StrategySignal {
  price: number;
  buy: boolean;
  sell: boolean;
  side: 'long' | 'short' | 'none';
  stopLossPrice: number | null;
  takeProfit1Price: number | null;
  takeProfit2Price: number | null;
  takeProfitPrice: number | null;
  tp1Fraction: number;
  positionSize: number | null;
  quantity: number | null;
  regime: MarketRegime;
  initialR: number | null;
  indicators: Record<string, unknown>;
}

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function prev<T>(arr: T[]): T {
  return arr[arr.length - 2];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function isTradingHour(timestamp: number): boolean {
  const hourUtc = new Date(timestamp).getUTCHours();
  return hourUtc >= TRADING_HOUR_UTC_FROM && hourUtc < TRADING_HOUR_UTC_TO;
}

function getStructureStop(params: {
  side: 'long' | 'short';
  highs: number[];
  lows: number[];
  price: number;
  lastAtr: number;
  atrStopMult: number;
}): number {
  const { side, highs, lows, price, lastAtr, atrStopMult } = params;
  const recentHigh = Math.max(...highs.slice(-STOP_STRUCTURE_LOOKBACK));
  const recentLow = Math.min(...lows.slice(-STOP_STRUCTURE_LOOKBACK));
  const pad = lastAtr * STOP_SWING_PAD_ATR;

  const minDist = Math.max(lastAtr * atrStopMult, price * MIN_STOP_DISTANCE_RATE);
  const maxDist = Math.min(lastAtr * 2.2, price * MAX_STOP_DISTANCE_RATE);

  if (side === 'long') {
    let stop = recentLow - pad;
    if (price - stop < minDist) stop = price - minDist;
    if (price - stop > maxDist) stop = price - maxDist;
    if (stop >= price) stop = price - minDist;
    return stop;
  }

  let stop = recentHigh + pad;
  if (stop - price < minDist) stop = price + minDist;
  if (stop - price > maxDist) stop = price + maxDist;
  if (stop <= price) stop = price + minDist;
  return stop;
}

function calcPositionSize(params: {
  price: number;
  stopLossPrice: number;
  riskCapital: number;
  balance: number;
}) {
  const { price, stopLossPrice, riskCapital, balance } = params;
  const stopDist = Math.abs(price - stopLossPrice);
  if (stopDist <= 0 || price <= 0) {
    return { quantity: null as number | null, positionSize: null as number | null };
  }

  const commPerShare = price * ROUND_TRIP_COMMISSION_RATE;
  const riskPerShare = stopDist + commPerShare;
  if (commPerShare / riskPerShare > MAX_COMMISSION_SHARE_OF_RISK) {
    return { quantity: null, positionSize: null };
  }

  let quantity = Math.floor(riskCapital / riskPerShare);
  if (quantity >= 3 && quantity % 2 === 1) quantity -= 1;

  const maxQty = Math.floor((balance * MAX_POSITION_FRAC) / price);
  quantity = Math.min(quantity, maxQty);

  if (quantity < MIN_QUANTITY) {
    return { quantity: null, positionSize: null };
  }

  return { quantity, positionSize: quantity * price };
}

// ============================================================================
// HTF 1h
// ============================================================================

export function hourBucketStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    0,
    0,
    0
  );
}

export function aggregateTo1h(candles15: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of candles15) {
    const key = hourBucketStart(c.time);
    const prevBar = map.get(key);
    if (!prevBar) {
      map.set(key, {
        time: key,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      });
    } else {
      prevBar.high = Math.max(prevBar.high, c.high);
      prevBar.low = Math.min(prevBar.low, c.low);
      prevBar.close = c.close;
      prevBar.volume += c.volume;
    }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

export function buildHtfBiasSeries(
  hours: Candle[],
  minAdx1h = 18
): HtfBarState[] {
  if (hours.length < 210) return [];

  const closes = hours.map(h => h.close);
  const highs = hours.map(h => h.high);
  const lows = hours.map(h => h.low);

  const ema20Arr = EMA.calculate({ period: 20, values: closes });
  const ema50Arr = EMA.calculate({ period: 50, values: closes });
  const ema200Arr = EMA.calculate({ period: 200, values: closes });
  const adxArr = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });

  const n = hours.length;
  const offE20 = n - ema20Arr.length;
  const offE50 = n - ema50Arr.length;
  const offE200 = n - ema200Arr.length;
  const offAdx = n - adxArr.length;

  const out: HtfBarState[] = [];

  for (let i = 0; i < n; i++) {
    const i20 = i - offE20;
    const i50 = i - offE50;
    const i200 = i - offE200;
    const iAdx = i - offAdx;
    if (i20 < 0 || i50 < 0 || i200 < 0 || iAdx < 0) continue;

    const ema20 = ema20Arr[i20];
    const ema50 = ema50Arr[i50];
    const ema200 = ema200Arr[i200];
    const adxVal = adxArr[iAdx].adx;
    const close = closes[i];

    const adxOk = minAdx1h <= 0 || adxVal >= minAdx1h;
    let bias: HtfBias = 'neutral';
    if (adxOk && close > ema200 && ema20 > ema50) bias = 'up';
    else if (adxOk && close < ema200 && ema20 < ema50) bias = 'down';

    out.push({
      time: hours[i].time,
      bias,
      adx: adxVal,
      ema20,
      ema50,
      ema200,
      close
    });
  }

  return out;
}

export function getHtfBiasAt(
  series: HtfBarState[],
  ts15: number
): HtfBarState | null {
  if (!series.length) return null;
  let lo = 0;
  let hi = series.length - 1;
  let best: HtfBarState | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const closeTs = series[mid].time + MS_PER_HOUR;
    if (closeTs <= ts15) {
      best = series[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function detectMarketRegime(candles: Candle[]) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });

  if (
    atr.length < 2 ||
    adx.length < 2 ||
    ema20.length < 1 ||
    ema50.length < 1 ||
    ema200.length < 1 ||
    bb.length < 1
  ) {
    return { regime: 'unknown' as MarketRegime, ready: false, indicators: null };
  }

  const lastClose = last(closes);
  const lastAtr = last(atr);
  const lastAdx = last(adx);
  const prevAdx = prev(adx);
  const lastEma20 = last(ema20);
  const lastEma50 = last(ema50);
  const lastEma200 = last(ema200);
  const lastBb = last(bb);

  const bbWidth = (lastBb.upper - lastBb.lower) / lastBb.middle;
  const atrPct = lastAtr / lastClose;
  const adxRising = lastAdx.adx > prevAdx.adx;
  const adxOk = lastAdx.adx >= MIN_ADX_TREND && (adxRising || lastAdx.adx >= 26);

  const stackUp = lastEma20 > lastEma50 && lastEma50 > lastEma200;
  const stackDown = lastEma20 < lastEma50 && lastEma50 < lastEma200;

  const highVolatility = atrPct > 0.028 || bbWidth > 0.13;
  const trendUp = !highVolatility && lastClose > lastEma200 && stackUp && adxOk;
  const trendDown = !highVolatility && lastClose < lastEma200 && stackDown && adxOk;

  let regime: MarketRegime = 'unknown';
  if (highVolatility) regime = 'high_volatility';
  else if (trendUp) regime = 'trend_up';
  else if (trendDown) regime = 'trend_down';
  else if (lastAdx.adx < 18) regime = 'range';

  return {
    regime,
    ready: true,
    indicators: {
      lastClose,
      lastAtr,
      atrPct,
      adx: lastAdx.adx,
      adxRising,
      ema20: lastEma20,
      ema50: lastEma50,
      ema200: lastEma200,
      bbWidth,
      avgVol20: mean(volumes.slice(-20))
    }
  };
}

function emptySignal(price: number, regime: MarketRegime = 'unknown'): StrategySignal {
  return {
    price,
    buy: false,
    sell: false,
    side: 'none',
    stopLossPrice: null,
    takeProfit1Price: null,
    takeProfit2Price: null,
    takeProfitPrice: null,
    tp1Fraction: TP1_FRACTION,
    positionSize: null,
    quantity: null,
    regime,
    initialR: null,
    indicators: { ready: false }
  };
}

/**
 * @param balance — текущий баланс для сайзинга
 * @param htf — фильтр 1h (по умолчанию выкл.)
 */
export function analyzeMarket(
  candles: Candle[],
  balance: number = STARTING_BALANCE,
  htf: HtfFilterOptions = DEFAULT_HTF_FILTER
): StrategySignal {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const opens = candles.map(c => c.open);

  const regimeInfo = detectMarketRegime(candles);
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const rsi = RSI.calculate({ period: 14, values: closes });
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

  if (
    !regimeInfo.ready ||
    !regimeInfo.indicators ||
    macd.length < 3 ||
    rsi.length < 2 ||
    atr.length < 2 ||
    candles.length < 30
  ) {
    return emptySignal(closes[closes.length - 1] ?? 0);
  }

  const price = last(closes);
  const prevPrice = prev(closes);
  const regime = regimeInfo.regime;
  const ind = regimeInfo.indicators;
  const lastAtr = last(atr);
  const lastMacd = last(macd);
  const prevMacd = prev(macd);
  const lastRsi = last(rsi);
  const lastOpen = last(opens);
  const lastHigh = last(highs);
  const lastLow = last(lows);
  const lastTs = last(candles).time;

  if (!isTradingHour(lastTs) || regime === 'high_volatility') {
    return {
      ...emptySignal(price, regime),
      indicators: { ready: true, skipped: true, regime }
    };
  }

  const ema20 = ind.ema20 as number;
  const ema50 = ind.ema50 as number;
  const extension = (price - ema20) / price;

  const macdCrossUp =
    prevMacd.MACD! < prevMacd.signal! && lastMacd.MACD! > lastMacd.signal!;
  const macdCrossDown =
    prevMacd.MACD! > prevMacd.signal! && lastMacd.MACD! < lastMacd.signal!;

  const macdBull =
    lastMacd.MACD! > lastMacd.signal! &&
    (lastMacd.histogram ?? 0) >= (prevMacd.histogram ?? 0);
  const macdBear =
    lastMacd.MACD! < lastMacd.signal! &&
    (lastMacd.histogram ?? 0) <= (prevMacd.histogram ?? 0);

  const range = Math.max(lastHigh - lastLow, 1e-9);
  const bodyPct = Math.abs(price - lastOpen) / range;
  const bullCandle = price > lastOpen && bodyPct >= 0.4;
  const bearCandle = price < lastOpen && bodyPct >= 0.4;

  const touchLong =
    lastLow <= ema20 * 1.006 ||
    lastLow <= ema50 * 1.01 ||
    (prevPrice <= ema20 * 1.006 && lastLow <= ema20 * 1.01);
  const touchShort =
    lastHigh >= ema20 * 0.994 ||
    lastHigh >= ema50 * 0.99 ||
    (prevPrice >= ema20 * 0.994 && lastHigh >= ema20 * 0.99);

  const notExtLong = extension > -0.003 && extension < MAX_EXTENSION_FROM_EMA20;
  const notExtShort = extension < 0.003 && extension > -MAX_EXTENSION_FROM_EMA20;

  const pullbackLong =
    touchLong &&
    bullCandle &&
    price >= ema20 * 0.997 &&
    macdBull &&
    lastRsi > 42 &&
    lastRsi < 68 &&
    notExtLong;

  const pullbackShort =
    touchShort &&
    bearCandle &&
    price <= ema20 * 1.003 &&
    macdBear &&
    lastRsi < 58 &&
    lastRsi > 32 &&
    notExtShort;

  const crossLong =
    macdCrossUp &&
    touchLong &&
    bullCandle &&
    price > ema20 &&
    lastRsi > 42 &&
    lastRsi < 68 &&
    notExtLong;

  const crossShort =
    macdCrossDown &&
    touchShort &&
    bearCandle &&
    price < ema20 &&
    lastRsi < 58 &&
    lastRsi > 32 &&
    notExtShort;

  let longSignal =
    regime === 'trend_up' &&
    price > (ind.ema200 as number) &&
    (pullbackLong || crossLong);
  let shortSignal =
    regime === 'trend_down' &&
    price < (ind.ema200 as number) &&
    (pullbackShort || crossShort);

  // ---------- HTF 1h GATE ----------
  if (htf.enabled && (longSignal || shortSignal)) {
    const minAdx = htf.minAdx1h ?? 18;
    let series = htf.precomputedHtf;
    if (!series) {
      series = buildHtfBiasSeries(aggregateTo1h(candles), minAdx);
    }
    const st = getHtfBiasAt(series, lastTs);

    if (!st) {
      return {
        ...emptySignal(price, regime),
        indicators: {
          ready: true,
          reject: 'htf_warmup',
          longWould: longSignal,
          shortWould: shortSignal
        }
      };
    }

    const sideWouldBe: 'long' | 'short' = longSignal ? 'long' : 'short';
    if (longSignal && st.bias !== 'up') longSignal = false;
    if (shortSignal && st.bias !== 'down') shortSignal = false;

    if (!longSignal && !shortSignal) {
      return {
        ...emptySignal(price, regime),
        indicators: {
          ready: true,
          reject: 'htf_gate',
          htfBias: st.bias,
          htfAdx: st.adx,
          sideWouldBe,
          htfEma20: st.ema20,
          htfEma200: st.ema200
        }
      };
    }
  }

  if (!longSignal && !shortSignal) {
    return {
      ...emptySignal(price, regime),
      indicators: {
        ready: true,
        longSignal,
        shortSignal,
        lastRsi,
        extension,
        bodyPct,
        pullbackLong,
        pullbackShort,
        crossLong,
        crossShort
      }
    };
  }

  const side: 'long' | 'short' = longSignal ? 'long' : 'short';
  const atrStopMult = (ind.atrPct as number) > 0.015 ? 1.6 : 1.45;

  const stopLossPrice = getStructureStop({
    side,
    highs,
    lows,
    price,
    lastAtr,
    atrStopMult
  });

  const initialR = Math.abs(price - stopLossPrice);
  const stopPct = initialR / price;

  if (
    initialR <= 0 ||
    stopPct < MIN_STOP_DISTANCE_RATE ||
    stopPct > MAX_STOP_DISTANCE_RATE
  ) {
    return {
      ...emptySignal(price, regime),
      indicators: { ready: true, reject: 'stop_distance', stopPct }
    };
  }

  const takeProfit1Price =
    side === 'long' ? price + TP1_R * initialR : price - TP1_R * initialR;
  const takeProfit2Price =
    side === 'long' ? price + TP2_R * initialR : price - TP2_R * initialR;

  const riskCapital = balance * MAX_RISK_PER_TRADE;
  const sized = calcPositionSize({
    price,
    stopLossPrice,
    riskCapital,
    balance
  });

  if (sized.quantity == null) {
    return {
      ...emptySignal(price, regime),
      indicators: { ready: true, reject: 'size' }
    };
  }

  return {
    price,
    buy: side === 'long',
    sell: side === 'short',
    side,
    stopLossPrice,
    takeProfit1Price,
    takeProfit2Price,
    takeProfitPrice: takeProfit2Price,
    tp1Fraction: TP1_FRACTION,
    positionSize: sized.positionSize,
    quantity: sized.quantity,
    regime,
    initialR,
    indicators: {
      ready: true,
      lastRsi,
      extension,
      initialR,
      stopPct,
      bodyPct,
      tp1: takeProfit1Price,
      tp2: takeProfit2Price,
      pullbackLong,
      pullbackShort,
      crossLong,
      crossShort,
      htfEnabled: htf.enabled
    }
  };
}
