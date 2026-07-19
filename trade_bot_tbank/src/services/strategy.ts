import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

// ============================================================================
// КАПИТАЛ / РИСК
// ============================================================================
export const STARTING_BALANCE = 50000;
export const MAX_RISK_PER_TRADE = 0.01;

// Тариф «Трейдер» 0.05%. В бэктесте: commissionRate: COMMISSION_RATE
export const COMMISSION_RATE = 0.0005;
export const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2;

const MIN_NET_PROFIT_BUFFER_RATE = 0.0004;
const MIN_EXPECTED_NET_MOVE_RATE = 0.003;
const MIN_RISK_REWARD_RATIO = 1.8;
const MIN_STOP_DISTANCE_RATE = 0.005; // 0.5% мин. стоп
const MAX_STOP_DISTANCE_RATE = 0.02;
const MAX_POSITION_FRAC = 0.30;
const MAX_COMMISSION_SHARE_OF_RISK = 0.25;

// ============================================================================
// РЕЖИМЫ
// ============================================================================
const MIN_ADX_TREND = 18;
const BB_SQUEEZE_THRESHOLD = 0.055;

// range и breakout на 15m SBER — выключены (пилят депозит)
const ENABLE_RANGE_ENTRIES = false;
const ENABLE_BREAKOUT_ENTRIES = false;

const STRUCTURE_LOOKBACK = 14;
const STOP_STRUCTURE_LOOKBACK = 8;
const BREAKOUT_LOOKBACK = 16;

// 10:00–18:00 МСК = 07:00–15:00 UTC
const TRADING_HOUR_UTC_FROM = 7;
const TRADING_HOUR_UTC_TO = 15;

const VOLUME_SPIKE_MULTIPLIER = 1.3;
const BREAKOUT_MIN_ATR_DISPLACEMENT = 0.5;
const BREAKOUT_MIN_BODY_PCT = 0.55;

// Не входим, если цена улетела от EMA20 больше чем на 1.2%
const MAX_EXTENSION_FROM_EMA20 = 0.012;
const STOP_SWING_PAD_ATR = 0.2;

const MIN_QUANTITY = 1;

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

type RegimeIndicators = {
  lastClose: number;
  lastAtr: number;
  atrPct: number;
  adx: number;
  adxRising: boolean;
  ema20: number;
  ema50: number;
  ema200: number;
  bbWidth: number;
  avgVol20: number;
};

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

function getVolumeSpike(volumes: number[], avgVol20: number): boolean {
  const v = volumes[volumes.length - 1] ?? 0;
  return avgVol20 > 0 && v >= avgVol20 * VOLUME_SPIKE_MULTIPLIER;
}

function getAtrMultipliers(regime: MarketRegime, atrPct: number) {
  const highVol = atrPct > 0.015;

  if (regime === 'trend_up' || regime === 'trend_down') {
    return {
      stop: highVol ? 1.6 : 1.4,
      target: highVol ? 3.6 : 3.2 // ~2.3R до комиссии
    };
  }

  if (regime === 'breakout_watch') {
    return {
      stop: highVol ? 1.5 : 1.3,
      target: highVol ? 4.0 : 3.6
    };
  }

  if (regime === 'range') {
    return { stop: 1.0, target: 2.0 };
  }

  return { stop: 0, target: 0 };
}

/** 10:00–18:00 МСК */
function isTradingHour(timestamp: number): boolean {
  const hourUtc = new Date(timestamp).getUTCHours();
  return hourUtc >= TRADING_HOUR_UTC_FROM && hourUtc < TRADING_HOUR_UTC_TO;
}

function expectedNetMove(params: {
  side: 'long' | 'short' | 'none';
  price: number;
  takeProfitPrice: number | null;
}) {
  const { side, price, takeProfitPrice } = params;

  if (side === 'none' || takeProfitPrice == null || price <= 0) {
    return { grossMove: 0, netMove: 0, netMoveRate: 0 };
  }

  const grossMove =
    side === 'long' ? takeProfitPrice - price : price - takeProfitPrice;
  const commissionCost = price * ROUND_TRIP_COMMISSION_RATE;
  const netMove = grossMove - commissionCost;

  return { grossMove, netMove, netMoveRate: netMove / price };
}

function getNetRiskReward(params: {
  side: 'long' | 'short' | 'none';
  price: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
}) {
  const { side, price, stopLossPrice, takeProfitPrice } = params;

  if (
    side === 'none' ||
    stopLossPrice == null ||
    takeProfitPrice == null ||
    price <= 0
  ) {
    return { risk: 0, reward: 0, ratio: 0, stopDist: 0, tpDist: 0, commPerShare: 0 };
  }

  const stopDist = side === 'long' ? price - stopLossPrice : stopLossPrice - price;
  const tpDist = side === 'long' ? takeProfitPrice - price : price - takeProfitPrice;
  const commPerShare = price * ROUND_TRIP_COMMISSION_RATE;

  const risk = stopDist + commPerShare;
  const reward = tpDist - commPerShare;

  if (risk <= 0 || reward <= 0) {
    return { risk, reward, ratio: 0, stopDist, tpDist, commPerShare };
  }

  return { risk, reward, ratio: reward / risk, stopDist, tpDist, commPerShare };
}

function getStructureTarget(params: {
  side: 'long' | 'short' | 'none';
  highs: number[];
  lows: number[];
  price: number;
  lastAtr: number;
  atrTargetMultiplier: number;
}) {
  const { side, highs, lows, price, lastAtr, atrTargetMultiplier } = params;
  if (side === 'none') return null;

  const recentHigh = Math.max(...highs.slice(-STRUCTURE_LOOKBACK));
  const recentLow = Math.min(...lows.slice(-STRUCTURE_LOOKBACK));
  const atrFloor = lastAtr * Math.max(atrTargetMultiplier, 2.8);

  if (side === 'long') {
    const structure =
      recentHigh > price + lastAtr * 0.8 ? recentHigh : price + atrFloor;
    return Math.max(structure, price + atrFloor);
  }

  const structure =
    recentLow < price - lastAtr * 0.8 ? recentLow : price - atrFloor;
  return Math.min(structure, price - atrFloor);
}

function getStructureStop(params: {
  side: 'long' | 'short' | 'none';
  highs: number[];
  lows: number[];
  price: number;
  lastAtr: number;
  atrStopMultiplier: number;
}) {
  const { side, highs, lows, price, lastAtr, atrStopMultiplier } = params;
  if (side === 'none') return null;

  const recentHigh = Math.max(...highs.slice(-STOP_STRUCTURE_LOOKBACK));
  const recentLow = Math.min(...lows.slice(-STOP_STRUCTURE_LOOKBACK));
  const pad = lastAtr * STOP_SWING_PAD_ATR;

  const minStopDist = Math.max(
    lastAtr * atrStopMultiplier,
    price * MIN_STOP_DISTANCE_RATE
  );
  const maxStopDist = Math.min(lastAtr * 2.6, price * MAX_STOP_DISTANCE_RATE);

  if (side === 'long') {
    let stop = recentLow - pad;
    if (price - stop < minStopDist) stop = price - minStopDist;
    if (price - stop > maxStopDist) stop = price - maxStopDist;
    if (stop >= price) stop = price - minStopDist;
    return stop;
  }

  let stop = recentHigh + pad;
  if (stop - price < minStopDist) stop = price + minStopDist;
  if (stop - price > maxStopDist) stop = price + maxStopDist;
  if (stop <= price) stop = price + minStopDist;
  return stop;
}

function getBreakoutDisplacement(params: {
  side: 'long' | 'short';
  price: number;
  bandLevel: number;
  lastAtr: number;
}) {
  const { side, price, bandLevel, lastAtr } = params;
  if (lastAtr <= 0) return { distance: 0, distanceAtr: 0 };
  const distance = side === 'long' ? price - bandLevel : bandLevel - price;
  return { distance, distanceAtr: distance / lastAtr };
}

function getStructureBreak(params: {
  side: 'long' | 'short';
  highs: number[];
  lows: number[];
  price: number;
}) {
  const { side, highs, lows, price } = params;
  const recentHigh = Math.max(...highs.slice(-BREAKOUT_LOOKBACK, -1));
  const recentLow = Math.min(...lows.slice(-BREAKOUT_LOOKBACK, -1));
  if (side === 'long') return { level: recentHigh, broken: price > recentHigh };
  return { level: recentLow, broken: price < recentLow };
}

function validateExitLevels(params: {
  side: 'long' | 'short' | 'none';
  price: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  lastAtr: number;
}) {
  const { side, price, lastAtr } = params;
  let { stopLossPrice, takeProfitPrice } = params;

  const fallbackStop = Math.max(lastAtr * 1.4, price * MIN_STOP_DISTANCE_RATE);
  const fallbackTake = Math.max(
    lastAtr * 3.2,
    2.0 * fallbackStop + price * ROUND_TRIP_COMMISSION_RATE * 3
  );

  if (side === 'long') {
    if (stopLossPrice == null || stopLossPrice >= price) {
      stopLossPrice = price - fallbackStop;
    }
    if (takeProfitPrice == null || takeProfitPrice <= price) {
      takeProfitPrice = price + fallbackTake;
    }
  }

  if (side === 'short') {
    if (stopLossPrice == null || stopLossPrice <= price) {
      stopLossPrice = price + fallbackStop;
    }
    if (takeProfitPrice == null || takeProfitPrice >= price) {
      takeProfitPrice = price - fallbackTake;
    }
  }

  return { stopLossPrice, takeProfitPrice };
}

function normalizeTakeProfit(params: {
  side: 'long' | 'short' | 'none';
  price: number;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  lastAtr: number;
}) {
  const { side, price, takeProfitPrice, stopLossPrice, lastAtr } = params;
  if (side === 'none' || takeProfitPrice == null || lastAtr <= 0) {
    return takeProfitPrice;
  }

  const stopDist =
    stopLossPrice != null ? Math.abs(price - stopLossPrice) : lastAtr * 1.4;

  const minByRR =
    stopDist * MIN_RISK_REWARD_RATIO +
    price * ROUND_TRIP_COMMISSION_RATE * (1 + MIN_RISK_REWARD_RATIO);
  const minByAtr = lastAtr * 2.8;
  const minByComm =
    price *
    (ROUND_TRIP_COMMISSION_RATE +
      MIN_NET_PROFIT_BUFFER_RATE +
      MIN_EXPECTED_NET_MOVE_RATE);
  const minDist = Math.max(minByRR, minByAtr, minByComm);

  if (side === 'long') return Math.max(takeProfitPrice, price + minDist);
  return Math.min(takeProfitPrice, price - minDist);
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
    return { quantity: null, positionSize: null, rejectReason: 'bad_stop' as const };
  }

  const commPerShare = price * ROUND_TRIP_COMMISSION_RATE;
  const riskPerShare = stopDist + commPerShare;
  const commShare = commPerShare / riskPerShare;

  if (commShare > MAX_COMMISSION_SHARE_OF_RISK) {
    return {
      quantity: null,
      positionSize: null,
      rejectReason: 'commission_too_high' as const
    };
  }

  let quantity = Math.floor(riskCapital / riskPerShare);
  const maxQtyByFrac = Math.floor((balance * MAX_POSITION_FRAC) / price);
  quantity = Math.min(quantity, maxQtyByFrac);

  if (quantity < MIN_QUANTITY) {
    return {
      quantity: null,
      positionSize: null,
      rejectReason: 'qty_too_small' as const
    };
  }

  return {
    quantity,
    positionSize: quantity * price,
    rejectReason: null
  };
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
    return {
      regime: 'unknown' as MarketRegime,
      ready: false,
      indicators: null as RegimeIndicators | null
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

  const avgVol20 = mean(volumes.slice(-20));
  const bbWidth = (lastBb.upper - lastBb.lower) / lastBb.middle;
  const adxRising = lastAdx.adx > prevAdx.adx;
  const atrPct = lastAtr / lastClose;
  const compression = bbWidth <= BB_SQUEEZE_THRESHOLD;

  // ADX: либо растёт, либо уже достаточно сильный
  const adxOk =
    lastAdx.adx >= MIN_ADX_TREND && (adxRising || lastAdx.adx >= 25);

  const emaStackUp = lastEma20 > lastEma50 && lastEma50 > lastEma200;
  const emaStackDown = lastEma20 < lastEma50 && lastEma50 < lastEma200;

  const trendUp = lastClose > lastEma200 && emaStackUp && adxOk;
  const trendDown = lastClose < lastEma200 && emaStackDown && adxOk;

  const range = lastAdx.adx < 18 && bbWidth < 0.09;

  const breakoutWatch =
    compression &&
    lastAdx.adx >= 14 &&
    lastAdx.adx <= 30 &&
    getVolumeSpike(volumes, avgVol20);

  const highVolatility = atrPct > 0.03 || bbWidth > 0.14;

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
    } satisfies RegimeIndicators
  };
}

export function analyzeMarket(candles: Candle[]) {
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

  const empty = {
    price: closes[closes.length - 1] ?? 0,
    buy: false,
    sell: false,
    side: 'none' as const,
    takeProfitPrice: null as number | null,
    stopLossPrice: null as number | null,
    positionSize: null as number | null,
    quantity: null as number | null,
    regime: 'unknown' as MarketRegime,
    indicators: { ready: false as const }
  };

  if (
    !regimeInfo.ready ||
    !regimeInfo.indicators ||
    macd.length < 3 ||
    rsi.length < 2 ||
    atr.length < 2 ||
    bb.length < 2 ||
    candles.length < 30
  ) {
    return empty;
  }

  const price = last(closes);
  const prevPrice = prev(closes);

  const lastMacd = last(macd);
  const prevMacd = prev(macd);

  const lastRsi = last(rsi);
  const prevRsi = prev(rsi);

  const lastAtr = last(atr);
  const prevAtr = prev(atr);

  const lastBb = last(bb);
  const prevBb = prev(bb);

  const lastOpen = last(opens);
  const lastHigh = last(highs);
  const lastLow = last(lows);

  const regimeIndicators = regimeInfo.indicators;
  const regime = regimeInfo.regime;
  const atrMultipliers = getAtrMultipliers(regime, regimeIndicators.atrPct);

  const ema20 = regimeIndicators.ema20;
  const ema50 = regimeIndicators.ema50;
  const extension = (price - ema20) / price;

  // --- MACD ---
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

  // --- Свеча ---
  const candleRange = Math.max(lastHigh - lastLow, 1e-9);
  const bodyPctOfRange = Math.abs(price - lastOpen) / candleRange;
  const bullishCandle = price > lastOpen && bodyPctOfRange >= 0.35;
  const bearishCandle = price < lastOpen && bodyPctOfRange >= 0.35;

  // --- RSI зоны (широкие) ---
  const rsiBull = lastRsi > 38 && lastRsi < 72;
  const rsiBear = lastRsi < 62 && lastRsi > 28;

  // --- Не extended ---
  const notExtendedLong =
    extension >= -0.004 && extension <= MAX_EXTENSION_FROM_EMA20;
  const notExtendedShort =
    extension <= 0.004 && extension >= -MAX_EXTENSION_FROM_EMA20;

  // --- Pullback: касание EMA20/50 + разворотная свеча + MACD в сторону ---
  const touchedLong =
    lastLow <= ema20 * 1.004 ||
    lastLow <= ema50 * 1.008 ||
    prevPrice <= ema20 * 1.005;

  const touchedShort =
    lastHigh >= ema20 * 0.996 ||
    lastHigh >= ema50 * 0.992 ||
    prevPrice >= ema20 * 0.995;

  const pullbackLong =
    touchedLong &&
    bullishCandle &&
    price >= ema20 * 0.998 &&
    macdBull &&
    rsiBull &&
    notExtendedLong;

  const pullbackShort =
    touchedShort &&
    bearishCandle &&
    price <= ema20 * 1.002 &&
    macdBear &&
    rsiBear &&
    notExtendedShort;

  // --- MACD cross в тренде (запасной вход) ---
  const crossLong =
    macdCrossUp && rsiBull && notExtendedLong && price > ema20 && bullishCandle;

  const crossShort =
    macdCrossDown && rsiBear && notExtendedShort && price < ema20 && bearishCandle;

  // --- Импульс: MACD над signal, цена над EMA20, RSI ок (без обязательного касания) ---
  const momentumLong =
    macdBull &&
    price > ema20 &&
    price > ema50 &&
    rsiBull &&
    lastRsi >= prevRsi &&
    notExtendedLong &&
    bullishCandle &&
    extension > 0; // цена чуть выше EMA20

  const momentumShort =
    macdBear &&
    price < ema20 &&
    price < ema50 &&
    rsiBear &&
    lastRsi <= prevRsi &&
    notExtendedShort &&
    bearishCandle &&
    extension < 0;

  const trendLongSignal = pullbackLong || crossLong || momentumLong;
  const trendShortSignal = pullbackShort || crossShort || momentumShort;

  const riskCapital = STARTING_BALANCE * MAX_RISK_PER_TRADE;

  let side: 'long' | 'short' | 'none' = 'none';
  let buy = false;
  let sell = false;
  let takeProfitPrice: number | null = null;
  let stopLossPrice: number | null = null;
  let positionSize: number | null = null;
  let quantity: number | null = null;

  const longBreakoutDisplacement = getBreakoutDisplacement({
    side: 'long',
    price,
    bandLevel: lastBb.upper,
    lastAtr
  });
  const shortBreakoutDisplacement = getBreakoutDisplacement({
    side: 'short',
    price,
    bandLevel: lastBb.lower,
    lastAtr
  });
  const longStructureBreak = getStructureBreak({
    side: 'long',
    highs,
    lows,
    price
  });
  const shortStructureBreak = getStructureBreak({
    side: 'short',
    highs,
    lows,
    price
  });
  const volumeSpike = getVolumeSpike(volumes, regimeIndicators.avgVol20);

  const bullishBreakClose =
    prevPrice <= prevBb.upper &&
    price > lastBb.upper &&
    bullishCandle &&
    bodyPctOfRange >= BREAKOUT_MIN_BODY_PCT &&
    lastAtr >= prevAtr * 0.95 &&
    longBreakoutDisplacement.distanceAtr >= BREAKOUT_MIN_ATR_DISPLACEMENT &&
    longStructureBreak.broken &&
    volumeSpike;

  const bearishBreakClose =
    prevPrice >= prevBb.lower &&
    price < lastBb.lower &&
    bearishCandle &&
    bodyPctOfRange >= BREAKOUT_MIN_BODY_PCT &&
    lastAtr >= prevAtr * 0.95 &&
    shortBreakoutDisplacement.distanceAtr >= BREAKOUT_MIN_ATR_DISPLACEMENT &&
    shortStructureBreak.broken &&
    volumeSpike;

  const baseIndicators = {
    macdCrossUp,
    macdCrossDown,
    pullbackLong,
    pullbackShort,
    crossLong,
    crossShort,
    momentumLong,
    momentumShort,
    trendLongSignal,
    trendShortSignal,
    lastRsi,
    prevRsi,
    lastAtr,
    bodyPctOfRange,
    extension,
    bullishBreakClose,
    bearishBreakClose,
    volumeSpike,
    regimeIndicators,
    commissionRate: COMMISSION_RATE
  };

  if (!isTradingHour(last(candles).time)) {
    return {
      price,
      buy: false,
      sell: false,
      side: 'none' as const,
      takeProfitPrice: null,
      stopLossPrice: null,
      positionSize: null,
      quantity: null,
      regime,
      indicators: {
        ...baseIndicators,
        skippedByTimeFilter: true,
        expectedNetMove: { grossMove: 0, netMove: 0, netMoveRate: 0 },
        riskReward: { risk: 0, reward: 0, ratio: 0 },
        ready: true
      }
    };
  }

  if (regime === 'high_volatility') {
    return {
      price,
      buy: false,
      sell: false,
      side: 'none' as const,
      takeProfitPrice: null,
      stopLossPrice: null,
      positionSize: null,
      quantity: null,
      regime,
      indicators: {
        ...baseIndicators,
        skippedByRegimeFilter: true,
        expectedNetMove: { grossMove: 0, netMove: 0, netMoveRate: 0 },
        riskReward: { risk: 0, reward: 0, ratio: 0 },
        ready: true
      }
    };
  }

  // ========== TREND UP ==========
  if (
    regime === 'trend_up' &&
    trendLongSignal &&
    price > regimeIndicators.ema200
  ) {
    side = 'long';
    buy = true;

    stopLossPrice = getStructureStop({
      side,
      highs,
      lows,
      price,
      lastAtr,
      atrStopMultiplier: atrMultipliers.stop
    });

    const atrTarget = price + lastAtr * atrMultipliers.target;
    const structureTarget = getStructureTarget({
      side,
      highs,
      lows,
      price,
      lastAtr,
      atrTargetMultiplier: atrMultipliers.target
    });
    takeProfitPrice = Math.max(atrTarget, structureTarget ?? atrTarget);
  }

  // ========== TREND DOWN ==========
  if (
    regime === 'trend_down' &&
    trendShortSignal &&
    price < regimeIndicators.ema200
  ) {
    side = 'short';
    sell = true;

    stopLossPrice = getStructureStop({
      side,
      highs,
      lows,
      price,
      lastAtr,
      atrStopMultiplier: atrMultipliers.stop
    });

    const atrTarget = price - lastAtr * atrMultipliers.target;
    const structureTarget = getStructureTarget({
      side,
      highs,
      lows,
      price,
      lastAtr,
      atrTargetMultiplier: atrMultipliers.target
    });
    takeProfitPrice = Math.min(atrTarget, structureTarget ?? atrTarget);
  }

  // ========== BREAKOUT (выключен по умолчанию) ==========
  if (ENABLE_BREAKOUT_ENTRIES && regime === 'breakout_watch' && side === 'none') {
    const breakoutUp =
      bullishBreakClose &&
      lastRsi > 52 &&
      lastRsi < 75 &&
      price > ema20 &&
      macdBull;

    const breakoutDown =
      bearishBreakClose &&
      lastRsi < 48 &&
      lastRsi > 25 &&
      price < ema20 &&
      macdBear;

    if (breakoutUp) {
      side = 'long';
      buy = true;
      stopLossPrice = getStructureStop({
        side,
        highs,
        lows,
        price,
        lastAtr,
        atrStopMultiplier: atrMultipliers.stop
      });
      const atrTarget = price + lastAtr * atrMultipliers.target;
      const structureTarget = getStructureTarget({
        side,
        highs,
        lows,
        price,
        lastAtr,
        atrTargetMultiplier: atrMultipliers.target
      });
      takeProfitPrice = Math.max(atrTarget, structureTarget ?? atrTarget);
    } else if (breakoutDown) {
      side = 'short';
      sell = true;
      stopLossPrice = getStructureStop({
        side,
        highs,
        lows,
        price,
        lastAtr,
        atrStopMultiplier: atrMultipliers.stop
      });
      const atrTarget = price - lastAtr * atrMultipliers.target;
      const structureTarget = getStructureTarget({
        side,
        highs,
        lows,
        price,
        lastAtr,
        atrTargetMultiplier: atrMultipliers.target
      });
      takeProfitPrice = Math.min(atrTarget, structureTarget ?? atrTarget);
    }
  }

  void ENABLE_RANGE_ENTRIES;

  ({ stopLossPrice, takeProfitPrice } = validateExitLevels({
    side,
    price,
    stopLossPrice,
    takeProfitPrice,
    lastAtr
  }));

  takeProfitPrice = normalizeTakeProfit({
    side,
    price,
    takeProfitPrice,
    stopLossPrice,
    lastAtr
  });

  const netMoveCheck = expectedNetMove({ side, price, takeProfitPrice });
  const netRR = getNetRiskReward({
    side,
    price,
    stopLossPrice,
    takeProfitPrice
  });

  if (
    side !== 'none' &&
    (netMoveCheck.netMoveRate < MIN_EXPECTED_NET_MOVE_RATE ||
      netRR.ratio < MIN_RISK_REWARD_RATIO ||
      netRR.stopDist < price * MIN_STOP_DISTANCE_RATE ||
      netRR.stopDist > price * MAX_STOP_DISTANCE_RATE)
  ) {
    side = 'none';
    buy = false;
    sell = false;
    takeProfitPrice = null;
    stopLossPrice = null;
  }

  if (side !== 'none' && stopLossPrice != null) {
    const sized = calcPositionSize({
      price,
      stopLossPrice,
      riskCapital,
      balance: STARTING_BALANCE
    });

    if (sized.rejectReason || sized.quantity == null) {
      side = 'none';
      buy = false;
      sell = false;
      takeProfitPrice = null;
      stopLossPrice = null;
      positionSize = null;
      quantity = null;
    } else {
      quantity = sized.quantity;
      positionSize = sized.positionSize;
    }
  }

  return {
    price,
    buy,
    sell,
    side,
    takeProfitPrice,
    stopLossPrice,
    positionSize,
    quantity,
    regime,
    indicators: {
      ...baseIndicators,
      expectedNetMove: netMoveCheck,
      riskReward: netRR,
      riskCapital,
      ready: true
    }
  };
}
