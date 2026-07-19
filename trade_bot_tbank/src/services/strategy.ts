import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

// ============================================================================
// КАПИТАЛ / РИСК
// ============================================================================
export const STARTING_BALANCE = 50000;
/** 1% на бэктесте одной бумаги; на портфеле лучше 0.25–0.5% */
export const MAX_RISK_PER_TRADE = 0.01;

export const COMMISSION_RATE = 0.0005;
export const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2;

// ============================================================================
// ВЫХОД ИЗ ПОЗИЦИИ (Priority #1 — зафиксирован)
// ============================================================================
/**
 * TP1 25% @ 1.5R → lock 0.1R → ATR-trail runner.
 * Фиксированный TP2 отключён.
 */
export const TP1_FRACTION = 0.25;
export const TP1_R = 1.5;
export const TP2_R = 0;
export const PARTIAL_LOCK_R = 0.1;
export const RUNNER_TRAIL_ATR_MULT = 2.5;

// ============================================================================
// СТОП / САЙЗИНГ
// ============================================================================
const MIN_STOP_DISTANCE_RATE = 0.005;
const MAX_STOP_DISTANCE_RATE = 0.012;

const MAX_POSITION_FRAC = 0.3;
const MAX_COMMISSION_SHARE_OF_RISK = 0.28;
const MIN_QUANTITY = 2;

// ============================================================================
// ЧАСТОТА v1 — более мягкие фильтры входа
// ============================================================================
/** Было 20 — реже давал trend_up/trend_down */
const MIN_ADX_TREND = 18;

/** Было 0.01 — отсекало нормальные откаты */
const MAX_EXTENSION_FROM_EMA20 = 0.015;

const STOP_STRUCTURE_LOOKBACK = 10;
const STOP_SWING_PAD_ATR = 0.25;

/**
 * Минимальная «полнотелость» сигнальной свечи.
 * Было 0.4 — слишком строго для 15m.
 */
const MIN_BODY_PCT = 0.25;

/** RSI long: было 42..68 */
const RSI_LONG_MIN = 38;
const RSI_LONG_MAX = 72;

/** RSI short: было 32..58 */
const RSI_SHORT_MIN = 28;
const RSI_SHORT_MAX = 62;

/**
 * Допуск касания EMA (шире, чем раньше).
 * long: low может чуть проколоть EMA20/50
 * short: high может чуть проколоть EMA20/50
 */
const EMA20_TOUCH_LONG = 1.01;
const EMA50_TOUCH_LONG = 1.015;
const EMA20_TOUCH_SHORT = 0.99;
const EMA50_TOUCH_SHORT = 0.985;

/** 10:00–18:00 МСК = 07:00–15:00 UTC */
const TRADING_HOUR_UTC_FROM = 7;
const TRADING_HOUR_UTC_TO = 15;

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

export interface StrategySignal {
  price: number;
  buy: boolean;
  sell: boolean;
  side: 'long' | 'short' | 'none';
  stopLossPrice: number | null;
  takeProfit1Price: number | null;
  /** Всегда null — runner по ATR-trail */
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
}): { quantity: number | null; positionSize: number | null } {
  const { price, stopLossPrice, riskCapital, balance } = params;
  const stopDist = Math.abs(price - stopLossPrice);

  if (stopDist <= 0 || price <= 0) {
    return { quantity: null, positionSize: null };
  }

  const commPerShare = price * ROUND_TRIP_COMMISSION_RATE;
  const riskPerShare = stopDist + commPerShare;

  if (commPerShare / riskPerShare > MAX_COMMISSION_SHARE_OF_RISK) {
    return { quantity: null, positionSize: null };
  }

  let quantity = Math.floor(riskCapital / riskPerShare);

  // TP1 = 25% → желательно кратность 4
  if (quantity >= 4) {
    quantity -= quantity % 4;
  }

  const maxQty = Math.floor((balance * MAX_POSITION_FRAC) / price);
  quantity = Math.min(quantity, maxQty);

  if (quantity < MIN_QUANTITY) {
    return { quantity: null, positionSize: null };
  }

  return { quantity, positionSize: quantity * price };
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

  // Частота v1: ADX >= 18 и (растёт ИЛИ уже >= 22)
  const adxOk =
    lastAdx.adx >= MIN_ADX_TREND &&
    (adxRising || lastAdx.adx >= 22);

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

function emptySignal(
  price: number,
  regime: MarketRegime = 'unknown'
): StrategySignal {
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
 */
export function analyzeMarket(
  candles: Candle[],
  balance: number = STARTING_BALANCE
): StrategySignal {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const opens = candles.map(c => c.open);

  const regimeInfo = detectMarketRegime(candles);

  // MACD оставлен для диагностики в indicators, но НЕ обязателен для входа (частота v1)
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

  if (!isTradingHour(last(candles).time) || regime === 'high_volatility') {
    return {
      ...emptySignal(price, regime),
      indicators: { ready: true, skipped: true, regime, lastAtr }
    };
  }

  const ema20 = Number(ind.ema20);
  const ema50 = Number(ind.ema50);
  const ema200 = Number(ind.ema200);
  const extension = (price - ema20) / price;

  const macdBull =
    lastMacd.MACD! > lastMacd.signal! &&
    (lastMacd.histogram ?? 0) >= (prevMacd.histogram ?? 0);

  const macdBear =
    lastMacd.MACD! < lastMacd.signal! &&
    (lastMacd.histogram ?? 0) <= (prevMacd.histogram ?? 0);

  const candleRange = Math.max(lastHigh - lastLow, 1e-9);
  const bodyPct = Math.abs(price - lastOpen) / candleRange;

  const bullCandle = price > lastOpen && bodyPct >= MIN_BODY_PCT;
  const bearCandle = price < lastOpen && bodyPct >= MIN_BODY_PCT;

  // --- touch (шире) ---
  const touchLong =
    lastLow <= ema20 * EMA20_TOUCH_LONG ||
    lastLow <= ema50 * EMA50_TOUCH_LONG ||
    (prevPrice <= ema20 * EMA20_TOUCH_LONG && lastLow <= ema20 * 1.012);

  const touchShort =
    lastHigh >= ema20 * EMA20_TOUCH_SHORT ||
    lastHigh >= ema50 * EMA50_TOUCH_SHORT ||
    (prevPrice >= ema20 * EMA20_TOUCH_SHORT && lastHigh >= ema20 * 0.988);

  const notExtLong =
    extension > -0.004 && extension < MAX_EXTENSION_FROM_EMA20;

  const notExtShort =
    extension < 0.004 && extension > -MAX_EXTENSION_FROM_EMA20;

  /**
   * Частота v1: основной сетап — pullback.
   * MACD-cross убран из обязательных условий (он сильно резал число сделок).
   * macdBull/macdBear остаются мягким подтверждением направления.
   */
  const pullbackLong =
    touchLong &&
    bullCandle &&
    price >= ema20 * 0.995 &&
    macdBull &&
    lastRsi > RSI_LONG_MIN &&
    lastRsi < RSI_LONG_MAX &&
    notExtLong;

  const pullbackShort =
    touchShort &&
    bearCandle &&
    price <= ema20 * 1.005 &&
    macdBear &&
    lastRsi < RSI_SHORT_MAX &&
    lastRsi > RSI_SHORT_MIN &&
    notExtShort;

  const longSignal =
    regime === 'trend_up' &&
    price > ema200 &&
    pullbackLong;

  const shortSignal =
    regime === 'trend_down' &&
    price < ema200 &&
    pullbackShort;

  if (!longSignal && !shortSignal) {
    return {
      ...emptySignal(price, regime),
      indicators: {
        ready: true,
        lastAtr,
        lastRsi,
        extension,
        bodyPct,
        longSignal,
        shortSignal,
        pullbackLong,
        pullbackShort,
        macdBull,
        macdBear,
        touchLong,
        touchShort,
        freqPatch: 'v1'
      }
    };
  }

  const side: 'long' | 'short' = longSignal ? 'long' : 'short';
  const atrPct = Number(ind.atrPct);
  const atrStopMult = atrPct > 0.015 ? 1.6 : 1.45;

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
      indicators: {
        ready: true,
        lastAtr,
        reject: 'stop_distance',
        stopPct,
        freqPatch: 'v1'
      }
    };
  }

  const takeProfit1Price =
    side === 'long'
      ? price + TP1_R * initialR
      : price - TP1_R * initialR;

  const takeProfit2Price: number | null = null;

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
      indicators: {
        ready: true,
        lastAtr,
        reject: 'size',
        freqPatch: 'v1'
      }
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
    takeProfitPrice: null,
    tp1Fraction: TP1_FRACTION,
    positionSize: sized.positionSize,
    quantity: sized.quantity,
    regime,
    initialR,
    indicators: {
      ready: true,
      lastAtr,
      atrPct,
      lastRsi,
      extension,
      bodyPct,
      initialR,
      stopPct,
      tp1: takeProfit1Price,
      tp2: null,
      partialLockR: PARTIAL_LOCK_R,
      runnerTrailAtrMult: RUNNER_TRAIL_ATR_MULT,
      pullbackLong,
      pullbackShort,
      macdBull,
      macdBear,
      freqPatch: 'v1'
    }
  };
}
