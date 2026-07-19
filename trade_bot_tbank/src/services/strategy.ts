import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

// ============================================================================
// КАПИТАЛ / РИСК
// ============================================================================
export const STARTING_BALANCE = 50000;
export const MAX_RISK_PER_TRADE = 0.01; // 1% = 500 ₽ на сделку ВКЛЮЧАЯ комиссию

// ============================================================================
// КОМИССИЯ — тариф «Трейдер» 0.05% (не Инвестор 0.3%!)
// В runBacktest / strategyBacktest ДОЛЖНО быть то же значение:
//   commissionRate: COMMISSION_RATE
// ============================================================================
export const COMMISSION_RATE = 0.0005;
export const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2; // 0.1%

const MIN_NET_PROFIT_BUFFER_RATE = 0.0005;
const MIN_EXPECTED_NET_MOVE_RATE = 0.003; // 0.3% чистого хода до TP
const MIN_RISK_REWARD_RATIO = 2.0; // net RR после комиссии
const MIN_STOP_DISTANCE_RATE = 0.004; // стоп ≥ 0.4% цены
const MAX_STOP_DISTANCE_RATE = 0.02; // стоп ≤ 2%
const MAX_POSITION_FRAC = 0.35; // не более 35% депозита в одной сделке
// Комиссия не должна съедать больше 25% бюджета риска
const MAX_COMMISSION_SHARE_OF_RISK = 0.25;

// ============================================================================
// РЕЖИМЫ
// ============================================================================
const MIN_ADX_TREND = 20;
const BB_SQUEEZE_THRESHOLD = 0.055;

// range на 15m — выключен (mean-reversion + комиссия = яд)
const ENABLE_RANGE_ENTRIES = false;
const ENABLE_BREAKOUT_ENTRIES = true;

const STRUCTURE_LOOKBACK = 14;
const STOP_STRUCTURE_LOOKBACK = 8;
const BREAKOUT_LOOKBACK = 16;

// 10:00–18:00 МСК = 07:00–15:00 UTC
const TRADING_HOUR_UTC_FROM = 7;
const TRADING_HOUR_UTC_TO = 15;

const VOLUME_SPIKE_MULTIPLIER = 1.3;
const BREAKOUT_MIN_ATR_DISPLACEMENT = 0.5;
const BREAKOUT_MIN_BODY_PCT = 0.55;

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

/**
 * Множители ATR.
 * target/stop задаёт ГРУБЫЙ RR до комиссии; финальный net RR режется фильтром.
 */
function getAtrMultipliers(regime: MarketRegime, atrPct: number) {
  const highVol = atrPct > 0.015;

  if (regime === 'trend_up' || regime === 'trend_down') {
    return {
      stop: highVol ? 1.6 : 1.4,
      target: highVol ? 4.0 : 3.5 // ~2.5R до комиссии
    };
  }

  if (regime === 'range') {
    return { stop: 1.0, target: 2.2 };
  }

  if (regime === 'breakout_watch') {
    return {
      stop: highVol ? 1.5 : 1.3,
      target: highVol ? 4.2 : 3.8
    };
  }

  return { stop: 0, target: 0 };
}

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

  return {
    grossMove,
    netMove,
    netMoveRate: netMove / price
  };
}

/**
 * Net RR с учётом round-trip комиссии на акцию.
 * riskNet  = stopDist + price * rtComm
 * rewardNet = tpDist  - price * rtComm
 */
function getNetRiskReward(params: {
  side: 'long' | 'short' | 'none';
  price: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
}) {
  const { side, price, stopLossPrice, takeProfitPrice } = params;

  if (side === 'none' || stopLossPrice == null || takeProfitPrice == null || price <= 0) {
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

  return {
    risk,
    reward,
    ratio: reward / risk,
    stopDist,
    tpDist,
    commPerShare
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
  const atrFloor = lastAtr * Math.max(atrTargetMultiplier, 2.5);

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

  const minStopDist = Math.max(
    lastAtr * atrStopMultiplier,
    price * MIN_STOP_DISTANCE_RATE
  );
  const maxStopDist = Math.min(lastAtr * 2.5, price * MAX_STOP_DISTANCE_RATE);

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
  // TP минимум: покрыть комиссию + buffer + 2 * min stop (чтобы RR≈2)
  const fallbackTake = Math.max(
    lastAtr * 3.5,
    price * (ROUND_TRIP_COMMISSION_RATE + MIN_NET_PROFIT_BUFFER_RATE) +
      2 * fallbackStop
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
    stopLossPrice != null
      ? Math.abs(price - stopLossPrice)
      : lastAtr * 1.4;

  const minByRR =
    stopDist * MIN_RISK_REWARD_RATIO +
    price * ROUND_TRIP_COMMISSION_RATE * (1 + MIN_RISK_REWARD_RATIO);
  // reward - comm >= RR * (stop + comm)
  // tpDist >= RR*(stop+comm) + comm

  const minByAtr = lastAtr * 2.5;
  const minByComm =
    price * (ROUND_TRIP_COMMISSION_RATE + MIN_NET_PROFIT_BUFFER_RATE + MIN_EXPECTED_NET_MOVE_RATE);
  const minDist = Math.max(minByRR, minByAtr, minByComm);

  if (side === 'long') return Math.max(takeProfitPrice, price + minDist);
  return Math.min(takeProfitPrice, price - minDist);
}

/**
 * Размер позиции:
 * qty = riskCapital / (stopDist + price * roundTripComm)
 *
 * Тогда убыток на SL ≈ riskCapital (цена + комиссия).
 * Без этого при узком стопе qty взлетает, notional = весь депозит,
 * комиссия > риска — как в твоём последнем прогоне.
 */
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

  // Доля комиссии в бюджете риска
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

  const strongAdx = lastAdx.adx >= 25;
  const adxOk = lastAdx.adx >= MIN_ADX_TREND && (adxRising || strongAdx);

  const trendUp =
    lastClose > lastEma200 &&
    lastEma20 > lastEma50 &&
    lastEma50 > lastEma200 * 0.98 &&
    adxOk;

  const trendDown =
    lastClose < lastEma200 &&
    lastEma20 < lastEma50 &&
    lastEma50 < lastEma200 * 1.02 &&
    adxOk;

  const range = lastAdx.adx < 18 && bbWidth < 0.09;

  const breakoutWatch =
    compression &&
    lastAdx.adx >= 14 &&
    lastAdx.adx <= 30 &&
    getVolumeSpike(volumes, avgVol20);

  const highVolatility = atrPct > 0.028 || bbWidth > 0.13;

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
    candles.length < 3
  ) {
    return empty;
  }

  const price = last(closes);
  const prevPrice = prev(closes);
  const prev2Price = closes[closes.length - 3];

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

  const macdCrossUp =
    prevMacd.MACD! < prevMacd.signal! && lastMacd.MACD! > lastMacd.signal!;
  const macdCrossDown =
    prevMacd.MACD! > prevMacd.signal! && lastMacd.MACD! < lastMacd.signal!;

  const macdBull =
    lastMacd.MACD! > lastMacd.signal! &&
    (lastMacd.histogram ?? 0) > (prevMacd.histogram ?? 0);
  const macdBear =
    lastMacd.MACD! < lastMacd.signal! &&
    (lastMacd.histogram ?? 0) < (prevMacd.histogram ?? 0);

  // --- Pullback в тренде (не ловим хай/лоу) ---
  // long: цена касалась зоны EMA20..EMA50 и закрылась выше EMA20, MACD+
  const distEma20 = (price - regimeIndicators.ema20) / price;
  const touchedEmaZoneLong =
    lastLow <= regimeIndicators.ema20 * 1.002 ||
    lastLow <= regimeIndicators.ema50 * 1.005 ||
    prevPrice <= regimeIndicators.ema20 * 1.005;
  const pullbackLong =
    touchedEmaZoneLong &&
    price > regimeIndicators.ema20 &&
    price > lastOpen &&
    distEma20 < 0.012 && // не далеко от EMA20 (не погоня)
    macdBull &&
    lastRsi > 42 &&
    lastRsi < 68;

  const touchedEmaZoneShort =
    lastHigh >= regimeIndicators.ema20 * 0.998 ||
    lastHigh >= regimeIndicators.ema50 * 0.995 ||
    prevPrice >= regimeIndicators.ema20 * 0.995;
  const pullbackShort =
    touchedEmaZoneShort &&
    price < regimeIndicators.ema20 &&
    price < lastOpen &&
    distEma20 > -0.012 &&
    macdBear &&
    lastRsi < 58 &&
    lastRsi > 32;

  // Альтернатива: свежий MACD cross в сторону тренда
  const trendLongSignal = pullbackLong || (macdCrossUp && lastRsi > 45 && lastRsi < 70);
  const trendShortSignal = pullbackShort || (macdCrossDown && lastRsi < 55 && lastRsi > 30);

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
    lastAtr >= prevAtr * 0.95 &&
    longBreakoutDisplacement.distanceAtr >= BREAKOUT_MIN_ATR_DISPLACEMENT &&
    longStructureBreak.broken &&
    volumeSpike;

  const bearishBreakClose =
    prevPrice >= prevBb.lower &&
    price < lastBb.lower &&
    price < lastOpen &&
    bodyPctOfRange >= BREAKOUT_MIN_BODY_PCT &&
    lastAtr >= prevAtr * 0.95 &&
    shortBreakoutDisplacement.distanceAtr >= BREAKOUT_MIN_ATR_DISPLACEMENT &&
    shortStructureBreak.broken &&
    volumeSpike;

  const baseIndicators = {
    macdCrossUp,
    macdCrossDown,
    trendLongSignal,
    trendShortSignal,
    pullbackLong,
    pullbackShort,
    lastRsi,
    prevRsi,
    lastAtr,
    prevAtr,
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
    regimeReady: true,
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

  // ========== TREND UP — pullback / MACD cross ==========
  if (regime === 'trend_up' && trendLongSignal && price > regimeIndicators.ema200) {
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
  if (regime === 'trend_down' && trendShortSignal && price < regimeIndicators.ema200) {
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

  // ========== RANGE — выключен ==========
  if (ENABLE_RANGE_ENTRIES && regime === 'range' && side === 'none') {
    const longReversal = price <= lastBb.lower && lastRsi <= 32 && lastRsi > prevRsi;
    const shortReversal = price >= lastBb.upper && lastRsi >= 68 && lastRsi < prevRsi;

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
      bullishBreakClose && lastRsi > 52 && lastRsi < 75 && price > regimeIndicators.ema20;
    const breakoutDown =
      bearishBreakClose && lastRsi < 48 && lastRsi > 25 && price < regimeIndicators.ema20;

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
  const netRR = getNetRiskReward({ side, price, stopLossPrice, takeProfitPrice });

  // Жёсткий фильтр: net RR и минимальный ход
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

  // --- Сайзинг с комиссией ---
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
