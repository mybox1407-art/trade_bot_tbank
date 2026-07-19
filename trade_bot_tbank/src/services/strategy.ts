import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

// ============================================================================
// КАПИТАЛ И РИСК
// ============================================================================
const STARTING_BALANCE = 50000;
const MAX_RISK_PER_TRADE = 0.01; // 1% = 500 ₽ риска на сделку

// ============================================================================
// КОМИССИЯ
// На 15m ОБЯЗАТЕЛЬНО тариф «Трейдер» (0.05%), не «Инвестор» (0.3%).
// Round-trip Инвестор = 0.6% — убивает любой скальп/range.
// В бэктесте commissionRate должен совпадать с этим значением!
// ============================================================================
const COMMISSION_RATE = 0.0005; // 0.05% за сторону (Трейдер)
const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2; // 0.1%
const MIN_NET_PROFIT_BUFFER_RATE = 0.0005; // 0.05% запас
const MIN_TP_ATR_MULTIPLIER = 0.8;

// Минимальный ход до TP после комиссии (0.25%)
const MIN_EXPECTED_NET_MOVE_RATE = 0.0025;
const MIN_RISK_REWARD_RATIO = 1.8;

// Стоп не ближе 0.35% цены — иначе комиссия съедает RR
const MIN_STOP_DISTANCE_RATE = 0.0035;

// ============================================================================
// РЕЖИМЫ
// ============================================================================
const MIN_ADX_TREND = 18;
const MIN_ADX_RANGE = 18;
const BB_SQUEEZE_THRESHOLD = 0.06;

// range на 15m + даже 0.05% часто убыточен на SBER — выключаем
const ENABLE_RANGE_ENTRIES = false;
// breakout оставляем, но строгий
const ENABLE_BREAKOUT_ENTRIES = true;

const STRUCTURE_LOOKBACK = 12;
const STOP_STRUCTURE_LOOKBACK = 6;
const BREAKOUT_LOOKBACK = 16;

// 10:00–18:00 МСК = 07:00–15:00 UTC
const TRADING_HOUR_UTC_FROM = 7;
const TRADING_HOUR_UTC_TO = 15;

const VOLUME_SPIKE_MULTIPLIER = 1.25;
const BREAKOUT_MIN_ATR_DISPLACEMENT = 0.4;
const BREAKOUT_MIN_BODY_PCT = 0.5;

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
    // Цель дальше стопа → RR ~ 2.0
    return {
      stop: highVol ? 1.8 : 1.5,
      target: highVol ? 3.6 : 3.2
    };
  }

  if (regime === 'range') {
    return { stop: 1.0, target: 2.0 };
  }

  if (regime === 'breakout_watch') {
    return {
      stop: highVol ? 1.7 : 1.4,
      target: highVol ? 3.8 : 3.4
    };
  }

  return { stop: 0, target: 0 };
}

function isTradingHour(timestamp: number): boolean {
  const hourUtc = new Date(timestamp).getUTCHours();
  return hourUtc >= TRADING_HOUR_UTC_FROM && hourUtc < TRADING_HOUR_UTC_TO;
}

function normalizeTakeProfit(params: {
  side: 'long' | 'short' | 'none';
  price: number;
  takeProfitPrice: number | null;
  lastAtr: number;
}) {
  const { side, price, takeProfitPrice, lastAtr } = params;

  if (side === 'none' || takeProfitPrice == null || lastAtr <= 0) {
    return takeProfitPrice;
  }

  const minAtrDistance = lastAtr * MIN_TP_ATR_MULTIPLIER;
  const minCommissionDistance =
    price * (ROUND_TRIP_COMMISSION_RATE + MIN_NET_PROFIT_BUFFER_RATE);
  const minDistance = Math.max(minAtrDistance, minCommissionDistance);

  if (side === 'long') return Math.max(takeProfitPrice, price + minDistance);
  if (side === 'short') return Math.min(takeProfitPrice, price - minDistance);
  return takeProfitPrice;
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

  return {
    grossMove,
    netMove,
    netMoveRate: netMove / price
  };
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
  const atrFloor = lastAtr * Math.max(atrTargetMultiplier, 1.8);

  if (side === 'long') {
    const structure =
      recentHigh > price + lastAtr * 0.5 ? recentHigh : price + atrFloor;
    return Math.max(structure, price + atrFloor);
  }

  const structure =
    recentLow < price - lastAtr * 0.5 ? recentLow : price - atrFloor;
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

  const minStopDist = Math.max(lastAtr * atrStopMultiplier, price * MIN_STOP_DISTANCE_RATE);
  const maxStopDist = lastAtr * 2.8;

  if (side === 'long') {
    let stop = Math.min(recentLow, price - minStopDist);
    if (price - stop < minStopDist) stop = price - minStopDist;
    if (price - stop > maxStopDist) stop = price - maxStopDist;
    if (stop >= price) stop = price - minStopDist;
    return stop;
  }

  let stop = Math.max(recentHigh, price + minStopDist);
  if (stop - price < minStopDist) stop = price + minStopDist;
  if (stop - price > maxStopDist) stop = price + maxStopDist;
  if (stop <= price) stop = price + minStopDist;
  return stop;
}

function getRiskReward(params: {
  side: 'long' | 'short' | 'none';
  price: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
}) {
  const { side, price, stopLossPrice, takeProfitPrice } = params;

  if (side === 'none' || stopLossPrice == null || takeProfitPrice == null) {
    return { risk: 0, reward: 0, ratio: 0 };
  }

  const risk = side === 'long' ? price - stopLossPrice : stopLossPrice - price;
  const reward = side === 'long' ? takeProfitPrice - price : price - takeProfitPrice;

  if (risk <= 0 || reward <= 0) return { risk, reward, ratio: 0 };
  return { risk, reward, ratio: reward / risk };
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

  const fallbackStop = Math.max(lastAtr * 1.5, price * MIN_STOP_DISTANCE_RATE);
  const fallbackTake = Math.max(
    lastAtr * 2.5,
    price * (ROUND_TRIP_COMMISSION_RATE + MIN_NET_PROFIT_BUFFER_RATE + 0.002)
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

  const strongAdx = lastAdx.adx >= 24;
  const adxOkTrend = lastAdx.adx >= MIN_ADX_TREND && (adxRising || strongAdx);

  // Тренд: цена vs EMA200 + EMA20/50 + ADX
  const trendUp =
    lastClose > lastEma200 &&
    lastEma20 > lastEma50 &&
    lastClose > lastEma20 &&
    adxOkTrend;

  const trendDown =
    lastClose < lastEma200 &&
    lastEma20 < lastEma50 &&
    lastClose < lastEma20 &&
    adxOkTrend;

  const range = lastAdx.adx < MIN_ADX_RANGE && bbWidth < 0.1;

  const breakoutWatch =
    compression &&
    lastAdx.adx >= 12 &&
    lastAdx.adx <= 32 &&
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
    takeProfitPrice: null,
    stopLossPrice: null,
    positionSize: null,
    quantity: null,
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
    candles.length < 2
  ) {
    return empty;
  }

  const price = last(closes);
  const prevPrice = prev(closes);

  const lastMacd = last(macd);
  const prevMacd = prev(macd);
  const prev2Macd = macd[macd.length - 3];

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

  const macdCrossUp =
    prevMacd.MACD! < prevMacd.signal! && lastMacd.MACD! > lastMacd.signal!;
  const macdCrossDown =
    prevMacd.MACD! > prevMacd.signal! && lastMacd.MACD! < lastMacd.signal!;

  // Импульс MACD (не только крест) — больше входов в тренде
  const macdBullMomentum =
    lastMacd.MACD! > lastMacd.signal! &&
    lastMacd.MACD! > prevMacd.MACD! &&
    (lastMacd.histogram ?? 0) > (prevMacd.histogram ?? 0);

  const macdBearMomentum =
    lastMacd.MACD! < lastMacd.signal! &&
    lastMacd.MACD! < prevMacd.MACD! &&
    (lastMacd.histogram ?? 0) < (prevMacd.histogram ?? 0);

  const macdLongSignal = macdCrossUp || macdBullMomentum;
  const macdShortSignal = macdCrossDown || macdBearMomentum;

  // Широкий RSI — не душим тренд
  const rsiBull = lastRsi > 38 && lastRsi < 75;
  const rsiBear = lastRsi < 62 && lastRsi > 25;

  const riskCapital = STARTING_BALANCE * MAX_RISK_PER_TRADE;

  let side: 'long' | 'short' | 'none' = 'none';
  let buy = false;
  let sell = false;
  let takeProfitPrice: number | null = null;
  let stopLossPrice: number | null = null;
  let positionSize: number | null = null;
  let quantity: number | null = null;

  const candleBody = Math.abs(price - lastOpen);
  const candleRange = Math.max(lastHigh - lastLow, 1e-9);
  const bodyPctOfRange = candleBody / candleRange;

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
  const longStructureBreak = getStructureBreak({ side: 'long', highs, lows, price });
  const shortStructureBreak = getStructureBreak({ side: 'short', highs, lows, price });
  const volumeSpike = getVolumeSpike(volumes, regimeIndicators.avgVol20);

  const bullishBreakClose =
    prevPrice <= prevBb.upper &&
    price > lastBb.upper &&
    price > lastOpen &&
    bodyPctOfRange >= BREAKOUT_MIN_BODY_PCT &&
    lastAtr >= prevAtr * 0.9 &&
    longBreakoutDisplacement.distanceAtr >= BREAKOUT_MIN_ATR_DISPLACEMENT &&
    longStructureBreak.broken &&
    volumeSpike;

  const bearishBreakClose =
    prevPrice >= prevBb.lower &&
    price < lastBb.lower &&
    price < lastOpen &&
    bodyPctOfRange >= BREAKOUT_MIN_BODY_PCT &&
    lastAtr >= prevAtr * 0.9 &&
    shortBreakoutDisplacement.distanceAtr >= BREAKOUT_MIN_ATR_DISPLACEMENT &&
    shortStructureBreak.broken &&
    volumeSpike;

  const baseIndicators = {
    macdCrossUp,
    macdCrossDown,
    macdLongSignal,
    macdShortSignal,
    lastRsi,
    prevRsi,
    lastAtr,
    prevAtr,
    rsiBull,
    rsiBear,
    bbUpper: lastBb.upper,
    bbMiddle: lastBb.middle,
    bbLower: lastBb.lower,
    bodyPctOfRange,
    bullishBreakClose,
    bearishBreakClose,
    volumeSpike,
    longBreakoutDisplacement,
    shortBreakoutDisplacement,
    longStructureBreak,
    shortStructureBreak,
    regimeReady: regimeInfo.ready,
    regimeIndicators
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
    macdLongSignal &&
    rsiBull &&
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
    macdShortSignal &&
    rsiBear &&
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

  // ========== RANGE (по умолчанию выключен на 15m) ==========
  if (ENABLE_RANGE_ENTRIES && regime === 'range' && side === 'none') {
    const longReversal =
      price <= lastBb.lower && lastRsi <= 35 && lastRsi > prevRsi;
    const shortReversal =
      price >= lastBb.upper && lastRsi >= 65 && lastRsi < prevRsi;

    if (longReversal) {
      side = 'long';
      buy = true;
      stopLossPrice = price - Math.max(lastAtr * atrMultipliers.stop, price * MIN_STOP_DISTANCE_RATE);
      takeProfitPrice = Math.max(lastBb.middle, price + lastAtr * atrMultipliers.target);
    } else if (shortReversal) {
      side = 'short';
      sell = true;
      stopLossPrice = price + Math.max(lastAtr * atrMultipliers.stop, price * MIN_STOP_DISTANCE_RATE);
      takeProfitPrice = Math.min(lastBb.middle, price - lastAtr * atrMultipliers.target);
    }
  }

  // ========== BREAKOUT ==========
  if (ENABLE_BREAKOUT_ENTRIES && regime === 'breakout_watch' && side === 'none') {
    const breakoutUp =
      bullishBreakClose && lastRsi > 50 && lastRsi < 80 && price > regimeIndicators.ema20;
    const breakoutDown =
      bearishBreakClose && lastRsi < 50 && lastRsi > 20 && price < regimeIndicators.ema20;

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

  takeProfitPrice = normalizeTakeProfit({ side, price, takeProfitPrice, lastAtr });
  ({ stopLossPrice, takeProfitPrice } = validateExitLevels({
    side,
    price,
    stopLossPrice,
    takeProfitPrice,
    lastAtr
  }));

  const netMoveCheck = expectedNetMove({ side, price, takeProfitPrice });
  const riskReward = getRiskReward({ side, price, stopLossPrice, takeProfitPrice });

  // Отсекаем сделки без экономического смысла
  if (
    side !== 'none' &&
    (netMoveCheck.netMove <= 0 ||
      netMoveCheck.netMoveRate < MIN_EXPECTED_NET_MOVE_RATE ||
      riskReward.ratio < MIN_RISK_REWARD_RATIO ||
      riskReward.risk < price * MIN_STOP_DISTANCE_RATE)
  ) {
    side = 'none';
    buy = false;
    sell = false;
    takeProfitPrice = null;
    stopLossPrice = null;
  }

  // ========================================================================
  // САЙЗИНГ — ИСПРАВЛЕННЫЙ БАГ
  // quantity = riskCapital / |price - stop|   (акции)
  // positionSize = quantity * price           (номинал в ₽)
  // Раньше было лишнее / price → 3 акции вместо ~1000
  // ========================================================================
  if (side !== 'none' && stopLossPrice != null) {
    const riskPerShare = Math.abs(price - stopLossPrice);

    if (riskPerShare > 0) {
      const rawQty = riskCapital / riskPerShare;
      quantity = Math.floor(rawQty);

      // Не больше чем позволяет баланс (грубый cap 95% депозита)
      const maxQtyByBalance = Math.floor((STARTING_BALANCE * 0.95) / price);
      quantity = Math.min(quantity, maxQtyByBalance);

      if (quantity < MIN_QUANTITY) {
        side = 'none';
        buy = false;
        sell = false;
        takeProfitPrice = null;
        stopLossPrice = null;
        positionSize = null;
        quantity = null;
      } else {
        positionSize = quantity * price; // номинал позиции в ₽
      }
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
      riskReward,
      riskCapital,
      ready: true
    }
  };
}
