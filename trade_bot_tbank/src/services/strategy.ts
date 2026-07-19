import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

// ============================================================================
// КАПИТАЛ / РИСК
// ============================================================================
export const STARTING_BALANCE = 50000;
/** 1% — лучший PF/DD на этом отрезке; 2% только раздул убытки */
export const MAX_RISK_PER_TRADE = 0.01;

export const COMMISSION_RATE = 0.0005;
export const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2;

// ============================================================================
// ВЫХОД ИЗ ПОЗИЦИИ
// ============================================================================
/**
 * Новый базовый вариант для проверки:
 *
 * - TP1: закрыть 25% позиции на 1.5R;
 * - после TP1: защитить остаток минимум на +0.1R;
 * - остаток позиции вести ATR-трейлингом в strategyBacktest.ts;
 * - фиксированный TP2 отключён, чтобы не обрезать сильные тренды.
 *
 * Важно: эти параметры надо проверить отдельно на out-of-sample,
 * а не считать финальными до бэктестов по нескольким тикерам.
 */
export const TP1_FRACTION = 0.25;
export const TP1_R = 1.5;

/**
 * Фиксированного TP2 больше нет.
 * Поле takeProfit2Price сохраняется в интерфейсе ради совместимости,
 * но возвращается как null.
 */
export const TP2_R = 0;

/**
 * После TP1 остаток защищается выше/ниже точки входа на 0.1R.
 * Реальный итог всё равно должен покрывать комиссии, которые учитываются
 * в расчёте размера позиции и в бэктестере.
 */
export const PARTIAL_LOCK_R = 0.1;

/**
 * Множитель ATR для runner после TP1.
 * Используется в strategyBacktest.ts при обновлении trailing stop.
 *
 * Для long:
 *   stop = highestHighSinceEntry - ATR(14) * RUNNER_TRAIL_ATR_MULT
 *
 * Для short:
 *   stop = lowestLowSinceEntry + ATR(14) * RUNNER_TRAIL_ATR_MULT
 */
export const RUNNER_TRAIL_ATR_MULT = 2.5;

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

  /**
   * Теперь всегда null: выход runner выполняется по ATR-trailing stop.
   * Оставлено ради обратной совместимости с существующим бэктестером.
   */
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

    if (price - stop < minDist) {
      stop = price - minDist;
    }

    if (price - stop > maxDist) {
      stop = price - maxDist;
    }

    if (stop >= price) {
      stop = price - minDist;
    }

    return stop;
  }

  let stop = recentHigh + pad;

  if (stop - price < minDist) {
    stop = price + minDist;
  }

  if (stop - price > maxDist) {
    stop = price + maxDist;
  }

  if (stop <= price) {
    stop = price + minDist;
  }

  return stop;
}

function calcPositionSize(params: {
  price: number;
  stopLossPrice: number;
  riskCapital: number;
  balance: number;
}): {
  quantity: number | null;
  positionSize: number | null;
} {
  const { price, stopLossPrice, riskCapital, balance } = params;
  const stopDist = Math.abs(price - stopLossPrice);

  if (stopDist <= 0 || price <= 0) {
    return {
      quantity: null,
      positionSize: null
    };
  }

  const commPerShare = price * ROUND_TRIP_COMMISSION_RATE;
  const riskPerShare = stopDist + commPerShare;

  if (commPerShare / riskPerShare > MAX_COMMISSION_SHARE_OF_RISK) {
    return {
      quantity: null,
      positionSize: null
    };
  }

  let quantity = Math.floor(riskCapital / riskPerShare);

  /**
   * TP1 закрывает 25%. Чтобы не иметь проблем с дробными акциями,
   * желательно иметь количество, кратное 4.
   *
   * Если объём слишком маленький, ниже остаётся безопасный fallback:
   * первая часть будет минимум одной акцией, остаток — минимум одной.
   */
  if (quantity >= 4) {
    quantity -= quantity % 4;
  }

  const maxQty = Math.floor((balance * MAX_POSITION_FRAC) / price);
  quantity = Math.min(quantity, maxQty);

  if (quantity < MIN_QUANTITY) {
    return {
      quantity: null,
      positionSize: null
    };
  }

  return {
    quantity,
    positionSize: quantity * price
  };
}

export function detectMarketRegime(candles: Candle[]) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const atr = ATR.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes
  });

  const adx = ADX.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes
  });

  const ema20 = EMA.calculate({
    period: 20,
    values: closes
  });

  const ema50 = EMA.calculate({
    period: 50,
    values: closes
  });

  const ema200 = EMA.calculate({
    period: 200,
    values: closes
  });

  const bb = BollingerBands.calculate({
    period: 20,
    values: closes,
    stdDev: 2
  });

  if (
    atr.length < 2 ||
    adx.length < 2 ||
    ema20.length < 1 ||
    ema50.length < 1 ||
    ema200.length < 1 ||
    bb.length < 1
  ) {
    return {
      regime: 'unknown' as MarketRegime,
      ready: false,
      indicators: null
    };
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
  const adxOk =
    lastAdx.adx >= MIN_ADX_TREND &&
    (adxRising || lastAdx.adx >= 26);

  const stackUp =
    lastEma20 > lastEma50 &&
    lastEma50 > lastEma200;

  const stackDown =
    lastEma20 < lastEma50 &&
    lastEma50 < lastEma200;

  const highVolatility = atrPct > 0.028 || bbWidth > 0.13;

  const trendUp =
    !highVolatility &&
    lastClose > lastEma200 &&
    stackUp &&
    adxOk;

  const trendDown =
    !highVolatility &&
    lastClose < lastEma200 &&
    stackDown &&
    adxOk;

  let regime: MarketRegime = 'unknown';

  if (highVolatility) {
    regime = 'high_volatility';
  } else if (trendUp) {
    regime = 'trend_up';
  } else if (trendDown) {
    regime = 'trend_down';
  } else if (lastAdx.adx < 18) {
    regime = 'range';
  }

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
    indicators: {
      ready: false
    }
  };
}

/**
 * @param balance — текущий баланс для сайзинга.
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

  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });

  const rsi = RSI.calculate({
    period: 14,
    values: closes
  });

  const atr = ATR.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes
  });

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
      indicators: {
        ready: true,
        skipped: true,
        regime,
        lastAtr
      }
    };
  }

  const ema20 = Number(ind.ema20);
  const ema50 = Number(ind.ema50);
  const extension = (price - ema20) / price;

  const macdCrossUp =
    prevMacd.MACD! < prevMacd.signal! &&
    lastMacd.MACD! > lastMacd.signal!;

  const macdCrossDown =
    prevMacd.MACD! > prevMacd.signal! &&
    lastMacd.MACD! < lastMacd.signal!;

  const macdBull =
    lastMacd.MACD! > lastMacd.signal! &&
    (lastMacd.histogram ?? 0) >= (prevMacd.histogram ?? 0);

  const macdBear =
    lastMacd.MACD! < lastMacd.signal! &&
    (lastMacd.histogram ?? 0) <= (prevMacd.histogram ?? 0);

  const candleRange = Math.max(lastHigh - lastLow, 1e-9);
  const bodyPct = Math.abs(price - lastOpen) / candleRange;

  const bullCandle =
    price > lastOpen &&
    bodyPct >= 0.4;

  const bearCandle =
    price < lastOpen &&
    bodyPct >= 0.4;

  const touchLong =
    lastLow <= ema20 * 1.006 ||
    lastLow <= ema50 * 1.01 ||
    (prevPrice <= ema20 * 1.006 && lastLow <= ema20 * 1.01);

  const touchShort =
    lastHigh >= ema20 * 0.994 ||
    lastHigh >= ema50 * 0.99 ||
    (prevPrice >= ema20 * 0.994 && lastHigh >= ema20 * 0.99);

  const notExtLong =
    extension > -0.003 &&
    extension < MAX_EXTENSION_FROM_EMA20;

  const notExtShort =
    extension < 0.003 &&
    extension > -MAX_EXTENSION_FROM_EMA20;

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

  const longSignal =
    regime === 'trend_up' &&
    price > Number(ind.ema200) &&
    (pullbackLong || crossLong);

  const shortSignal =
    regime === 'trend_down' &&
    price < Number(ind.ema200) &&
    (pullbackShort || crossShort);

  if (!longSignal && !shortSignal) {
    return {
      ...emptySignal(price, regime),
      indicators: {
        ready: true,
        lastAtr,
        lastRsi,
        extension,
        longSignal,
        shortSignal,
        pullbackLong,
        pullbackShort,
        crossLong,
        crossShort
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
        stopPct
      }
    };
  }

  const takeProfit1Price =
    side === 'long'
      ? price + TP1_R * initialR
      : price - TP1_R * initialR;

  /**
   * Fixed TP2 отключён.
   * Runner должен закрываться по ATR-trailing stop в бэктестере/боевом
   * исполнителе после того, как TP1 был достигнут.
   */
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
        reject: 'size'
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
      initialR,
      stopPct,
      tp1: takeProfit1Price,
      tp2: null,
      partialLockR: PARTIAL_LOCK_R,
      runnerTrailAtrMult: RUNNER_TRAIL_ATR_MULT,
      pullbackLong,
      pullbackShort,
      crossLong,
      crossShort
    }
  };
}
