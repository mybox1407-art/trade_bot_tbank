import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

// ============================================================================
// КАПИТАЛ / РИСК
// ============================================================================
export const STARTING_BALANCE = 50000;
export const MAX_RISK_PER_TRADE = 0.01;

// Тариф «Трейдер» 0.05%. В бэктесте: commissionRate: COMMISSION_RATE
export const COMMISSION_RATE = 0.0005;
export const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2;

const MIN_NET_PROFIT_BUFFER_RATE = 0.0005;
const MIN_EXPECTED_NET_MOVE_RATE = 0.0035;
const MIN_RISK_REWARD_RATIO = 2.0;
const MIN_STOP_DISTANCE_RATE = 0.0045;
const MAX_STOP_DISTANCE_RATE = 0.018;
const MAX_POSITION_FRAC = 0.30;
const MAX_COMMISSION_SHARE_OF_RISK = 0.22;

// ============================================================================
// РЕЖИМЫ
// ============================================================================
const MIN_ADX_TREND = 22;
const BB_SQUEEZE_THRESHOLD = 0.05;

const ENABLE_RANGE_ENTRIES = false;
const ENABLE_BREAKOUT_ENTRIES = true;

const STRUCTURE_LOOKBACK = 16;
const STOP_STRUCTURE_LOOKBACK = 10;
const BREAKOUT_LOOKBACK = 20;
const SWING_LOOKBACK = 8;

// 10:30–17:30 МСК ≈ 07:30–14:30 UTC — режем открытие/закрытие
const TRADING_HOUR_UTC_FROM = 7;
const TRADING_MINUTE_FROM = 30;
const TRADING_HOUR_UTC_TO = 14;
const TRADING_MINUTE_TO = 30;

const VOLUME_SPIKE_MULTIPLIER = 1.35;
const BREAKOUT_MIN_ATR_DISPLACEMENT = 0.55;
const BREAKOUT_MIN_BODY_PCT = 0.6;

// Тренд: не входим если свеча уже улетела от EMA20
const MAX_EXTENSION_FROM_EMA20 = 0.008; // 0.8%
// Минимальный отступ стопа за свинг в долях ATR
const STOP_SWING_PAD_ATR = 0.15;

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
      stop: highVol ? 1.5 : 1.35,
      target: highVol ? 4.2 : 3.8
    };
  }

  if (regime === 'breakout_watch') {
    return {
      stop: highVol ? 1.4 : 1.25,
      target: highVol ? 4.5 : 4.0
    };
  }

  if (regime === 'range') {
    return { stop: 1.0, target: 2.2 };
  }

  return { stop: 0, target: 0 };
}

/** Торговое окно 10:30–17:30 МСК */
function isTradingHour(timestamp: number): boolean {
  const d = new Date(timestamp);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const from = TRADING_HOUR_UTC_FROM * 60 + TRADING_MINUTE_FROM;
  const to = TRADING_HOUR_UTC_TO * 60 + TRADING_MINUTE_TO;
  return minutes >= from && minutes < to;
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

  return { risk, reward, ratio: reward / risk, stopDist, tpDist, commPerShare };
}

/** Простая оценка структуры: higher lows / lower highs */
function getSwingStructure(params: {
  highs: number[];
  lows: number[];
  lookback?: number;
}) {
  const lookback = params.lookback ?? SWING_LOOKBACK;
  const highs = params.highs.slice(-lookback);
  const lows = params.lows.slice(-lookback);
  const mid = Math.floor(highs.length / 2);

  const firstHigh = Math.max(...highs.slice(0, mid));
  const secondHigh = Math.max(...highs.slice(mid));
  const firstLow = Math.min(...lows.slice(0, mid));
  const secondLow = Math.min(...lows.slice(mid));

  return {
    higherHighs: secondHigh > firstHigh,
    higherLows: secondLow > firstLow,
    lowerHighs: secondHigh < firstHigh,
    lowerLows: secondLow < firstLow,
    bullishStructure: secondLow > firstLow && secondHigh >= firstHigh * 0.998,
    bearishStructure: secondHigh < firstHigh && secondLow <= firstLow * 1.002
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
  const atrFloor = lastAtr * Math.max(atrTargetMultiplier, 3.2);

  if (side === 'long') {
    const structure =
      recentHigh > price + lastAtr * 1.0 ? recentHigh : price + atrFloor;
    return Math.max(structure, price + atrFloor);
  }

  const structure =
    recentLow < price - lastAtr * 1.0 ? recentLow : price - atrFloor;
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
  const maxStopDist = Math.min(lastAtr * 2.4, price * MAX_STOP_DISTANCE_RATE);

  if (side === 'long') {
    // Стоп под свинг low с небольшим запасом
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

  const fallbackStop = Math.max(lastAtr * 1.35, price * MIN_STOP_DISTANCE_RATE);
  const fallbackTake = Math.max(
    lastAtr * 3.8,
    2.2 * fallbackStop + price * ROUND_TRIP_COMMISSION_RATE * 3
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
    stopLossPrice != null ? Math.abs(price - stopLossPrice) : lastAtr * 1.35;

  // tpDist >= RR*(stop+comm) + comm
  const minByRR =
    stopDist * MIN_RISK_REWARD_RATIO +
    price * ROUND_TRIP_COMMISSION_RATE * (1 + MIN_RISK_REWARD_RATIO);
  const minByAtr = lastAtr * 3.2;
  const minByComm =
    price *
    (ROUND_TRIP_COMMISSION_RATE + MIN_NET_PROFIT_BUFFER_RATE + MIN_EXPECTED_NET_MOVE_RATE);
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
    adx.length < 3 ||
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
  const prev2Adx = adx[adx.length - 3];
  const lastEma20 = last(ema20);
  const lastEma50 = last(ema50);
  const lastEma200 = last(ema200);
  const lastBb = last(bb);

  const avgVol20 = mean(volumes.slice(-20));
  const bbWidth = (lastBb.upper - lastBb.lower) / lastBb.middle;
  // ADX растёт хотя бы 2 бара или уже сильный
  const adxRising =
    lastAdx.adx > prevAdx.adx && prevAdx.adx >= prev2Adx.adx * 0.98;
  const atrPct = lastAtr / lastClose;
  const compression = bbWidth <= BB_SQUEEZE_THRESHOLD;

  const adxOk =
    lastAdx.adx >= MIN_ADX_TREND && (adxRising || lastAdx.adx >= 28);

  const emaStackUp = lastEma20 > lastEma50 && lastEma50 > lastEma200;
  const emaStackDown = lastEma20 < lastEma50 && lastEma50 < lastEma200;

  const trendUp = lastClose > lastEma200 && emaStackUp && adxOk;
  const trendDown = lastClose < lastEma200 && emaStackDown && adxOk;

  const range = lastAdx.adx < 18 && bbWidth < 0.085;

  const breakoutWatch =
    compression &&
    lastAdx.adx >= 15 &&
    lastAdx.adx <= 28 &&
    getVolumeSpike(volumes, avgVol20);

  const highVolatility = atrPct > 0.025 || bbWidth > 0.12;

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
    rsi.length < 3 ||
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
  const prev2Rsi = rsi[rsi.length - 3];

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
  const swing = getSwingStructure({ highs, lows });

  const macdBull =
    lastMacd.MACD! > lastMacd.signal! &&
    (lastMacd.histogram ?? 0) > (prevMacd.histogram ?? 0);
  const macdBear =
    lastMacd.MACD! < lastMacd.signal! &&
    (lastMacd.histogram ?? 0) < (prevMacd.histogram ?? 0);

  const macdCrossUp =
    prevMacd.MACD! < prevMacd.signal! && lastMacd.MACD! > lastMacd.signal!;
  const macdCrossDown =
    prevMacd.MACD! > prevMacd.signal! && lastMacd.MACD! < lastMacd.signal!;

  // --- Качественный pullback (единственный вход в тренд) ---
  const ema20 = regimeIndicators.ema20;
  const ema50 = regimeIndicators.ema50;
  const extension = (price - ema20) / price;

  // Касание зоны EMA20–EMA50 на текущей или предыдущей свече
  const touchedPullbackZoneLong =
    lastLow <= ema20 * 1.003 ||
    lastLow <= ema50 * 1.006 ||
    prevPrice <= ema20 * 1.004;

  const touchedPullbackZoneShort =
    lastHigh >= ema20 * 0.997 ||
    lastHigh >= ema50 * 0.994 ||
    prevPrice >= ema20 * 0.996;

  // Свеча разворота: закрытие в верхней/нижней половине, тело не доджи
  const candleRange = Math.max(lastHigh - lastLow, 1e-9);
  const bodyPctOfRange = Math.abs(price - lastOpen) / candleRange;
  const closeLocation = (price - lastLow) / candleRange; // 1 = close на high

  const bullishReversalCandle =
    price > lastOpen &&
    bodyPctOfRange >= 0.45 &&
    closeLocation >= 0.6;

  const bearishReversalCandle =
    price < lastOpen &&
    bodyPctOfRange >= 0.45 &&
    closeLocation <= 0.4;

  // RSI: был откат и разворачивается (не вход на перегреве)
  const rsiResetLong =
    lastRsi > 40 &&
    lastRsi < 62 &&
    (prevRsi < lastRsi || prev2Rsi < lastRsi) &&
    prevRsi < 58;

  const rsiResetShort =
    lastRsi < 60 &&
    lastRsi > 38 &&
    (prevRsi > lastRsi || prev2Rsi > lastRsi) &&
    prevRsi > 42;

  // Не гонимся за ценой далеко от EMA20
  const notExtendedLong = extension >= -0.002 && extension <= MAX_EXTENSION_FROM_EMA20;
  const notExtendedShort = extension <= 0.002 && extension >= -MAX_EXTENSION_FROM_EMA20;

  const pullbackLong =
    touchedPullbackZoneLong &&
    bullishReversalCandle &&
    price > ema20 &&
    macdBull &&
    rsiResetLong &&
    notExtendedLong &&
    swing.bullishStructure &&
    regimeIndicators.adxRising;

  const pullbackShort =
    touchedPullbackZoneShort &&
    bearishReversalCandle &&
    price < ema20 &&
    macdBear &&
    rsiResetShort &&
    notExtendedShort &&
    swing.bearishStructure &&
    regimeIndicators.adxRising;

  // Запасной вход: только свежий MACD cross + не extended + структура
  const crossLong =
    macdCrossUp &&
    rsiResetLong &&
    notExtendedLong &&
    price > ema20 &&
    swing.higherLows &&
    bodyPctOfRange >= 0.4;

  const crossShort =
    macdCrossDown &&
    rsiResetShort &&
    notExtendedShort &&
    price < ema20 &&
    swing.lowerHighs &&
    bodyPctOfRange >= 0.4;

  const trendLongSignal = pullbackLong || crossLong;
  const trendShortSignal = pullbackShort || crossShort;

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
  const longStructureBreak = getStructureBreak({ side: 'long', highs, lows, price });
  const shortStructureBreak = getStructureBreak({ side: 'short', highs, lows, price });
  const volumeSpike = getVolumeSpike(volumes, regimeIndicators.avgVol20);

  // Объём текущей свечи не слабее предыдущей (подтверждение)
  const volOk = volumes[volumes.length - 1] >= volumes[volumes.length - 2] * 0.9;

  const bullishBreakClose =
    prevPrice <= prevBb.upper &&
    price > lastBb.upper &&
    bullishReversalCandle &&
    bodyPctOfRange >= BREAKOUT_MIN_BODY_PCT &&
    lastAtr >= prevAtr &&
    longBreakoutDisplacement.distanceAtr >= BREAKOUT_MIN_ATR_DISPLACEMENT &&
    longStructureBreak.broken &&
    volumeSpike &&
    volOk;

  const bearishBreakClose =
    prevPrice >= prevBb.lower &&
    price < lastBb.lower &&
    bearishReversalCandle &&
    bodyPctOfRange >= BREAKOUT_MIN_BODY_PCT &&
    lastAtr >= prevAtr &&
    shortBreakoutDisplacement.distanceAtr >= BREAKOUT_MIN_ATR_DISPLACEMENT &&
    shortStructureBreak.broken &&
    volumeSpike &&
    volOk;

  const baseIndicators = {
    macdCrossUp,
    macdCrossDown,
    pullbackLong,
    pullbackShort,
    crossLong,
    crossShort,
    trendLongSignal,
    trendShortSignal,
    lastRsi,
    prevRsi,
    lastAtr,
    swing,
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

  // ========== BREAKOUT ==========
  if (ENABLE_BREAKOUT_ENTRIES && regime === 'breakout_watch' && side === 'none') {
    const breakoutUp =
      bullishBreakClose &&
      lastRsi > 55 &&
      lastRsi < 72 &&
      price > regimeIndicators.ema20 &&
      macdBull;

    const breakoutDown =
      bearishBreakClose &&
      lastRsi < 45 &&
      lastRsi > 28 &&
      price < regimeIndicators.ema20 &&
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

  // range выключен
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
  const netRR = getNetRiskReward({ side, price, stopLossPrice, takeProfitPrice });

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
