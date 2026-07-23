import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

// ============================================================================
// КАПИТАЛ / РИСК
// ============================================================================
export const STARTING_BALANCE = 50000;
export const MAX_RISK_PER_TRADE = 0.01;
export const COMMISSION_RATE = 0.0005;
export const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2;
export const TP1_FRACTION = 0.5;
export const TREND_TP1_R = 1.2;
export const TREND_TP2_R = 1.8;
export const BREAKOUT_TP1_R = 1.0;
export const BREAKOUT_TP2_R = 2.5;
export const PARTIAL_LOCK_R = 0;

const MIN_STOP_DISTANCE_RATE = 0.004;
const MAX_STOP_DISTANCE_RATE = 0.01;
const MAX_POSITION_FRAC = 0.3;
const MAX_COMMISSION_SHARE_OF_RISK = 0.28;
const MIN_ADX_TREND = 20;
const MIN_ADX_RANGE = 18;
const BB_SQUEEZE_THRESHOLD = 0.05;
const STOP_STRUCTURE_LOOKBACK = 8;
const STOP_SWING_PAD_ATR = 0.18;
const MAX_EXTENSION_FROM_EMA20 = 0.01;
const TRADING_HOUR_UTC_FROM = 7;
const TRADING_HOUR_UTC_TO = 15;
export const MIN_QUANTITY = 2;
const DEFAULT_TIME_FAIL_BARS = 4;

const MAX_DAY_EXT = 3.5;
const BOUNCE_LOOKBACK = 10;
const MAX_BOUNCE_ATR = 1.1;

const BREAKOUT_ATR_BUFFER_K = 0.2;
const BREAKOUT_BODY_ATR_MIN = 0.5;
const BREAKOUT_ATR_STOP_MULT = 1.5;

// ============================================================================
// ТИПЫ
// ============================================================================
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MarketRegime = 'trend_up' | 'trend_down' | 'range' | 'breakout_watch' | 'high_volatility' | 'unknown';
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

export const DEFAULT_HTF_FILTER: HtfFilterOptions = { enabled: false, minAdx1h: 18 };

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
  timeFailBars: number;
  indicators: Record<string, unknown>;
}

// ============================================================================
// УТИЛИТЫ
// ============================================================================
function last<T>(arr: T[]) {
  return arr[arr.length - 1];
}

function prev<T>(arr: T[]) {
  return arr[arr.length - 2];
}

function mean(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function isTradingHour(ts: number) {
  const h = new Date(ts).getUTCHours();
  return h >= TRADING_HOUR_UTC_FROM && h < TRADING_HOUR_UTC_TO;
}

function sessionStartTs(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    TRADING_HOUR_UTC_FROM,
    0,
    0,
    0
  );
}

function getSessionRange(candles: Candle[], ts: number): { high: number; low: number } | null {
  const start = sessionStartTs(ts);
  let hi = -Infinity;
  let lo = Infinity;
  let n = 0;

  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (c.time < start) break;
    if (c.time > ts) continue;
    hi = Math.max(hi, c.high);
    lo = Math.min(lo, c.low);
    n += 1;
  }

  if (n === 0 || !Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return { high: hi, low: lo };
}

function getStructureStop(params: {
  side: 'long' | 'short';
  highs: number[];
  lows: number[];
  price: number;
  lastAtr: number;
  atrStopMult: number;
}) {
  const { side, highs, lows, price, lastAtr, atrStopMult } = params;
  const recentHigh = Math.max(...highs.slice(-STOP_STRUCTURE_LOOKBACK));
  const recentLow = Math.min(...lows.slice(-STOP_STRUCTURE_LOOKBACK));
  const pad = lastAtr * STOP_SWING_PAD_ATR;
  const minDist = Math.max(lastAtr * atrStopMult, price * MIN_STOP_DISTANCE_RATE);
  const maxDist = Math.min(lastAtr * 1.8, price * MAX_STOP_DISTANCE_RATE);

  if (side === 'long') {
    let stop = recentLow - pad;
    if (price - stop < minDist) stop = price - minDist;
    if (price - stop > maxDist) stop = price - maxDist;
    if (stop >= price) stop = price - minDist;
    return stop;
  }

  let stop = recentHigh + pad;
  if (stop - price < minDist) stop = price + minDist;
  if (stop - price > maxDist) stop = price - maxDist;
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
  const maxQty = Math.floor((balance * MAX_POSITION_FRAC) / price);
  quantity = Math.min(quantity, maxQty);

  if (quantity < MIN_QUANTITY) {
    return { quantity: null, positionSize: null };
  }

  return { quantity, positionSize: quantity * price };
}

function getVolumeSpike(volumes: number[], avgVol: number) {
  const v = volumes[volumes.length - 1] ?? 0;
  return v >= avgVol * 1.1;
}

// ============================================================================
// HTF (1H bias)
// ============================================================================
export function hourBucketStart(ts: number) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0);
}

export function aggregateTo1h(candles15: Candle[]) {
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

export function buildHtfBiasSeries(hours: Candle[], minAdx1h = 18) {
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

export function getHtfBiasAt(series: HtfBarState[], ts15: number) {
  if (!series.length) return null;
  let lo = 0;
  let hi = series.length - 1;
  let best: HtfBarState | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const closeTs = series[mid].time + 3_600_000;
    if (closeTs <= ts15) {
      best = series[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// ============================================================================
// РЕЖИМ РЫНКА
// ============================================================================
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
  const avgVol20 = mean(volumes.slice(-20));

  const bbWidth = (lastBb.upper - lastBb.lower) / lastBb.middle;
  const atrPct = lastAtr / lastClose;
  const adxRising = lastAdx.adx > prevAdx.adx;
  const adxOk = lastAdx.adx >= MIN_ADX_TREND && (adxRising || lastAdx.adx >= 26);
  const stackUp = lastEma20 > lastEma50 && lastEma50 > lastEma200;
  const stackDown = lastEma20 < lastEma50 && lastEma50 < lastEma200;
  const highVolatility = atrPct > 0.028 || bbWidth > 0.13;
  const compression = bbWidth <= BB_SQUEEZE_THRESHOLD;
  const trendUp = !highVolatility && lastClose > lastEma200 && stackUp && adxOk;
  const trendDown = !highVolatility && lastClose < lastEma200 && stackDown && adxOk;
  const range = lastAdx.adx < MIN_ADX_RANGE && bbWidth < 0.08;
  const breakoutWatch = compression && lastAdx.adx >= 15 && lastAdx.adx <= 28 && getVolumeSpike(volumes, avgVol20) && !highVolatility;

  let regime: MarketRegime = 'unknown';
  if (highVolatility) regime = 'high_volatility';
  else if (trendUp) regime = 'trend_up';
  else if (trendDown) regime = 'trend_down';
  else if (breakoutWatch) regime = 'breakout_watch';
  else if (range) regime = 'range';

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
      avgVol20
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
    timeFailBars: DEFAULT_TIME_FAIL_BARS,
    indicators: { ready: false }
  };
}

// ============================================================================
// ВХОД — ТОЛЬКО BREAKOUT
// ============================================================================
export function analyzeMarket(
  candles: Candle[],
  balance: number = STARTING_BALANCE,
  htf: HtfFilterOptions = DEFAULT_HTF_FILTER
): StrategySignal {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const opens = candles.map(c => c.open);
  const volumes = candles.map(c => c.volume);

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
  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });

  if (
    !regimeInfo.ready ||
    !regimeInfo.indicators ||
    macd.length < 2 ||
    rsi.length < 2 ||
    atr.length < 2 ||
    bb.length < 2 ||
    candles.length < 40
  ) {
    return emptySignal(closes[closes.length - 1] ?? 0);
  }

  const price = last(closes);
  const regime = regimeInfo.regime;
  const ind = regimeInfo.indicators;
  const lastAtr = last(atr);
  const lastRsi = last(rsi);
  const lastCandle = last(candles);
  const lastBb = last(bb);
  const lastTs = last(candles).time;

  if (!isTradingHour(lastTs)) {
    return {
      ...emptySignal(price, regime),
      indicators: { ready: true, skipped: true, regime }
    };
  }

  // Pullback отключены
  let longSignal = false;
  let shortSignal = false;

  // --- Breakout module (единственный источник сигналов) ---
  let breakoutUp = false;
  let breakoutDown = false;
  let breakoutSide: 'long' | 'short' | 'none' = 'none';

  if (regime === 'breakout_watch') {
    const candleBody = Math.abs(lastCandle.close - lastCandle.open);
    const atrBuffer = lastAtr * BREAKOUT_ATR_BUFFER_K;
    const minBody = lastAtr * BREAKOUT_BODY_ATR_MIN;
    const volumeSpike = getVolumeSpike(volumes, ind.avgVol20 as number);

    breakoutUp = price > lastBb.upper + atrBuffer && candleBody >= minBody && lastRsi > 55 && volumeSpike;
    breakoutDown = price < lastBb.lower - atrBuffer && candleBody >= minBody && lastRsi < 45 && volumeSpike;

    if (breakoutUp) breakoutSide = 'long';
    if (breakoutDown) breakoutSide = 'short';
  }

  // --- HTF filter ---
  const sideWouldBe: 'long' | 'short' | 'none' = breakoutSide;

  if (htf.enabled && sideWouldBe !== 'none') {
    const minAdx = htf.minAdx1h ?? 18;
    const series = htf.precomputedHtf ?? buildHtfBiasSeries(aggregateTo1h(candles), minAdx);
    const st = getHtfBiasAt(series, lastTs);

    if (!st) {
      return {
        ...emptySignal(price, regime),
        indicators: {
          ready: true,
          reject: 'htf_warmup',
          breakoutUp,
          breakoutDown,
          sideWouldBe
        }
      };
    }

    if (breakoutUp && st.bias !== 'up') breakoutUp = false;
    if (breakoutDown && st.bias !== 'down') breakoutDown = false;

    if (!breakoutUp && !breakoutDown) {
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

  // --- Dispatch ---
  let side: 'long' | 'short' | 'none' = 'none';
  let entryPrice = price;
  let tp1R = BREAKOUT_TP1_R;
  let tp2R = BREAKOUT_TP2_R;
  let atrStopMult = BREAKOUT_ATR_STOP_MULT;

  if (breakoutUp) {
    side = 'long';
  } else if (breakoutDown) {
    side = 'short';
  }

  if (side === 'none') {
    return {
      ...emptySignal(price, regime),
      indicators: {
        ready: true,
        longSignal,
        shortSignal,
        breakoutUp,
        breakoutDown,
        lastRsi,
        regime,
        htfEnabled: htf.enabled
      }
    };
  }

  const stopLossPrice = getStructureStop({ side, highs, lows, price: entryPrice, lastAtr, atrStopMult });
  const initialR = Math.abs(entryPrice - stopLossPrice);
  const stopPct = initialR / entryPrice;

  if (initialR <= 0 || stopPct < MIN_STOP_DISTANCE_RATE || stopPct > MAX_STOP_DISTANCE_RATE) {
    return {
      ...emptySignal(price, regime),
      indicators: { ready: true, reject: 'stop_distance', stopPct }
    };
  }

  const takeProfit1Price = side === 'long' ? entryPrice + tp1R * initialR : entryPrice - tp1R * initialR;
  const takeProfit2Price = side === 'long' ? entryPrice + tp2R * initialR : entryPrice - tp2R * initialR;

  const riskCapital = balance * MAX_RISK_PER_TRADE;
  const sized = calcPositionSize({ price: entryPrice, stopLossPrice, riskCapital, balance });

  if (sized.quantity == null) {
    return {
      ...emptySignal(price, regime),
      indicators: { ready: true, reject: 'size' }
    };
  }

  return {
    price: entryPrice,
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
    timeFailBars: DEFAULT_TIME_FAIL_BARS,
    indicators: {
      ready: true,
      lastRsi,
      initialR,
      stopPct,
      tp1: takeProfit1Price,
      tp2: takeProfit2Price,
      breakoutUp,
      breakoutDown,
      htfEnabled: htf.enabled
    }
  };
}
