import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

const STARTING_BALANCE = 50000;
const MAX_RISK_PER_TRADE = 0.01;

// --- Режимы рынка ---
const MIN_ADX_TREND = 18;          // было 20 — чуть мягче, больше трендовых входов
const MIN_ADX_RANGE = 20;          // было 18 — range только при реально слабом ADX
const BB_SQUEEZE_THRESHOLD = 0.055; // было 0.05 — чуть шире сжатие

// --- Комиссии (тариф «Инвестор» Т-Банка: 0.3% за сторону) ---
const COMMISSION_RATE = 0.003;
const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2;
const MIN_NET_PROFIT_BUFFER_RATE = 0.001;
const MIN_TP_ATR_MULTIPLIER = 0.6; // было 0.5 — TP чуть дальше минимума

// --- Структура ---
const STRUCTURE_LOOKBACK = 12;     // было 10
const STOP_STRUCTURE_LOOKBACK = 6; // было 5
const BREAKOUT_LOOKBACK = 20;

// --- Фильтры качества сделки ---
const MIN_EXPECTED_NET_MOVE_RATE = 0.0025; // 0.25% чистого хода после комиссии
const MIN_RISK_REWARD_RATIO = 1.6;          // было 1.5

// Торговые часы: 10:00–18:00 МСК = 07:00–15:00 UTC
const TRADING_HOUR_UTC_FROM = 7;
const TRADING_HOUR_UTC_TO = 15;

// Breakout
const VOLUME_SPIKE_MULTIPLIER = 1.3;       // было 1.35 — чуть мягче
const BREAKOUT_MIN_ATR_DISPLACEMENT = 0.45; // было 0.5
const BREAKOUT_MIN_BODY_PCT = 0.55;         // было 0.6

// Минимальный размер позиции в акциях (SBER lot = 1 с 01.08.2025)
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
 * ATR-множители под режим.
 * Важно: target должен давать RR >= MIN_RISK_REWARD_RATIO
 * с учётом того, что стоп может быть структурным.
 */
function getAtrMultipliers(regime: MarketRegime, atrPct: number) {
  const highVol = atrPct > 0.02;

  if (regime === 'trend_up' || regime === 'trend_down') {
    // RR ≈ 1.7–1.8 до комиссий
    return {
      stop: highVol ? 2.0 : 1.7,
      target: highVol ? 3.6 : 3.0
    };
  }

  if (regime === 'range') {
    // БЫЛО stop:1.4 target:1.1 — инверсия, RR < 1
    // ТЕПЕРЬ: короткий стоп, цель к середине BB / 1.8 ATR
    return { stop: 1.0, target: 1.8 };
  }

  if (regime === 'breakout_watch') {
    return {
      stop: highVol ? 1.9 : 1.6,
      target: highVol ? 3.8 : 3.2
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

  if (side === 'long') {
    return Math.max(takeProfitPrice, price + minDistance);
  }

  if (side === 'short') {
    return Math.min(takeProfitPrice, price - minDistance);
  }

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
  const netMoveRate = netMove / price;

  return { grossMove, netMove, netMoveRate };
}

/**
 * Структурная цель: ближайший экстремум, но не ближе ATR*min.
 * Если структура «за спиной» — берём ATR-цель.
 */
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
  const atrFloor = lastAtr * Math.max(atrTargetMultiplier, 1.5);

  if (side === 'long') {
    // Берём структуру только если она ВПЕРЕДИ цены
    const structure = recentHigh > price + lastAtr * 0.3 ? recentHigh : price + atrFloor;
    return Math.max(structure, price + atrFloor);
  }

  if (side === 'short') {
    const structure = recentLow < price - lastAtr * 0.3 ? recentLow : price - atrFloor;
    return Math.min(structure, price - atrFloor);
  }

  return null;
}

/**
 * Структурный стоп: за локальный экстремум.
 * Fallback — ATR. Не даём стопу быть слишком далеко (> 2.5 ATR).
 */
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

  const maxStopDist = lastAtr * 2.5;
  const atrStopLong = price - lastAtr * atrStopMultiplier;
  const atrStopShort = price + lastAtr * atrStopMultiplier;

  if (side === 'long') {
    // Стоп под минимум, но не дальше maxStopDist
    let stop = Math.min(recentLow, atrStopLong);
    if (price - stop > maxStopDist) {
      stop = price - maxStopDist;
    }
    // Стоп не может быть выше/равен цене
    if (stop >= price) {
      stop = atrStopLong;
    }
    return stop;
  }

  if (side === 'short') {
    let stop = Math.max(recentHigh, atrStopShort);
    if (stop - price > maxStopDist) {
      stop = price + maxStopDist;
    }
    if (stop <= price) {
      stop = atrStopShort;
    }
    return stop;
  }

  return null;
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

  if (risk <= 0 || reward <= 0) {
    return { risk, reward, ratio: 0 };
  }

  return { risk, reward, ratio: reward / risk };
}

function getBreakoutDisplacement(params: {
  side: 'long' | 'short';
  price: number;
  bandLevel: number;
  lastAtr: number;
}) {
  const { side, price, bandLevel, lastAtr } = params;

  if (lastAtr <= 0) {
    return { distance: 0, distanceAtr: 0 };
  }

  const distance = side === 'long' ? price - bandLevel : bandLevel - price;

  return {
    distance,
    distanceAtr: distance / lastAtr
  };
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

  if (side === 'long') {
    return { level: recentHigh, broken: price > recentHigh };
  }

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

  const fallbackStopDistance = Math.max(lastAtr, price * 0.003);
  const fallbackTakeDistance = Math.max(
    lastAtr * 1.8,
    price * (ROUND_TRIP_COMMISSION_RATE + MIN_NET_PROFIT_BUFFER_RATE)
  );

  if (side === 'long') {
    if (stopLossPrice == null || stopLossPrice >= price) {
      stopLossPrice = price - fallbackStopDistance;
    }
    if (takeProfitPrice == null || takeProfitPrice <= price) {
      takeProfitPrice = price + fallbackTakeDistance;
    }
  }

  if (side === 'short') {
    if (stopLossPrice == null || stopLossPrice <= price) {
      stopLossPrice = price + fallbackStopDistance;
    }
    if (takeProfitPrice == null || takeProfitPrice >= price) {
      takeProfitPrice = price - fallbackTakeDistance;
    }
  }

  return { stopLossPrice, takeProfitPrice };
}

/**
 * Пустой результат без входа (для early-return).
 */
function noTradeResult(
  price: number,
  regime: MarketRegime,
  indicatorsExtra: Record<string, unknown> = {}
) {
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
      ready: false,
      ...indicatorsExtra
    }
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

  // Тренд: ADX + выравнивание EMA, rising ADX желателен, но не обязателен
  // если ADX уже достаточно сильный (>= 25)
  const strongAdx = lastAdx.adx >= 25;
  const adxOkTrend = lastAdx.adx >= MIN_ADX_TREND && (adxRising || strongAdx);

  const trendUp =
    lastClose > lastEma200 &&
    lastEma20 > lastEma50 &&
    adxOkTrend;

  const trendDown =
    lastClose < lastEma200 &&
    lastEma20 < lastEma50 &&
    adxOkTrend;

  // Range: слабый ADX + относительно узкие полосы
  const range = lastAdx.adx < MIN_ADX_RANGE && bbWidth < 0.09;

  // Breakout watch: сжатие + умеренный ADX + всплеск объёма
  const breakoutWatch =
    compression &&
    lastAdx.adx >= 14 &&
    lastAdx.adx <= 30 &&
    getVolumeSpike(volumes, avgVol20);

  const highVolatility = atrPct > 0.028 || bbWidth > 0.13;

  let regime: MarketRegime = 'range';

  // Приоритет: high_vol > trend > breakout > range
  if (highVolatility) regime = 'high_volatility';
  else if (trendUp) regime = 'trend_up';
  else if (trendDown) regime = 'trend_down';
  else if (breakoutWatch) regime = 'breakout_watch';
  else if (range) regime = 'range';
  else regime = 'unknown';

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

  if (
    !regimeInfo.ready ||
    !regimeInfo.indicators ||
    macd.length < 3 ||
    rsi.length < 2 ||
    atr.length < 2 ||
    bb.length < 2 ||
    candles.length < 2
  ) {
    return noTradeResult(closes[closes.length - 1] ?? 0, 'unknown');
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

  // --- MACD сигналы ---
  // 1) Классический кросс
  const macdCrossUp =
    prevMacd.MACD! < prevMacd.signal! && lastMacd.MACD! > lastMacd.signal!;
  const macdCrossDown =
    prevMacd.MACD! > prevMacd.signal! && lastMacd.MACD! < lastMacd.signal!;

  // 2) Импульс: MACD над signal и растёт 2 свечи подряд (не только момент кросса)
  const macdBullMomentum =
    lastMacd.MACD! > lastMacd.signal! &&
    lastMacd.MACD! > prevMacd.MACD! &&
    prevMacd.MACD! >= prev2Macd.MACD! &&
    (lastMacd.histogram ?? 0) > 0;

  const macdBearMomentum =
    lastMacd.MACD! < lastMacd.signal! &&
    lastMacd.MACD! < prevMacd.MACD! &&
    prevMacd.MACD! <= prev2Macd.MACD! &&
    (lastMacd.histogram ?? 0) < 0;

  // Вход в тренд: кросс ИЛИ свежий импульс
  const macdLongSignal = macdCrossUp || macdBullMomentum;
  const macdShortSignal = macdCrossDown || macdBearMomentum;

  // RSI: расширенные зоны (было 42–68 / 32–58)
  const rsiBull = lastRsi > 40 && lastRsi < 72;
  const rsiBear = lastRsi < 60 && lastRsi > 28;

  // Цена относительно EMA50 как доп. фильтр направления
  const aboveEma50 = price > regimeIndicators.ema50;
  const belowEma50 = price < regimeIndicators.ema50;

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
    price > lastOpen &&
    bodyPctOfRange >= BREAKOUT_MIN_BODY_PCT &&
    lastAtr >= prevAtr * 0.95 && // ATR не сжимается резко
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

  // --- Вне торговых часов — только наблюдение ---
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
        regimeIndicators,
        skippedByTimeFilter: true,
        expectedNetMove: { grossMove: 0, netMove: 0, netMoveRate: 0 },
        riskReward: { risk: 0, reward: 0, ratio: 0 },
        ready: true
      }
    };
  }

  // ========== HIGH VOLATILITY — не торгуем ==========
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
        skippedByRegimeFilter: true,
        regimeReady: regimeInfo.ready,
        regimeIndicators,
        ready: true
      }
    };
  }

  // ========== TREND UP ==========
  if (
    regime === 'trend_up' &&
    macdLongSignal &&
    rsiBull &&
    price > regimeIndicators.ema200 &&
    aboveEma50
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
    price < regimeIndicators.ema200 &&
    belowEma50
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

  // ========== RANGE (mean-reversion) ==========
  if (regime === 'range' && side === 'none') {
    // Мягче RSI: 35/65 вместо 30/70
    const longSetup =
      price <= lastBb.lower * 1.002 && // небольшой допуск
      lastRsi <= 35 &&
      lastRsi < prevRsi; // RSI ещё падает или разворачивается снизу — берём отскок при развороте

    const shortSetup =
      price >= lastBb.upper * 0.998 &&
      lastRsi >= 65 &&
      lastRsi > prevRsi;

    // Предпочитаем разворот RSI (prev экстремальнее)
    const longReversal = price <= lastBb.lower && lastRsi <= 38 && prevRsi <= 35 && lastRsi > prevRsi;
    const shortReversal = price >= lastBb.upper && lastRsi >= 62 && prevRsi >= 65 && lastRsi < prevRsi;

    if (longReversal || longSetup) {
      side = 'long';
      buy = true;

      stopLossPrice = price - lastAtr * atrMultipliers.stop;
      // Цель: середина BB, но не ближе min ATR target
      const midTarget = lastBb.middle;
      const atrTarget = price + lastAtr * atrMultipliers.target;
      takeProfitPrice = Math.max(Math.min(midTarget, atrTarget * 1.2), atrTarget * 0.85);
      // Если mid очень близко — тянем к atrTarget
      if (takeProfitPrice <= price) {
        takeProfitPrice = atrTarget;
      }
    } else if (shortReversal || shortSetup) {
      side = 'short';
      sell = true;

      stopLossPrice = price + lastAtr * atrMultipliers.stop;
      const midTarget = lastBb.middle;
      const atrTarget = price - lastAtr * atrMultipliers.target;
      takeProfitPrice = Math.min(Math.max(midTarget, atrTarget * 1.2), atrTarget * 0.85);
      if (takeProfitPrice >= price) {
        takeProfitPrice = atrTarget;
      }
    }
  }

  // ========== BREAKOUT WATCH (не выключаем) ==========
  if (regime === 'breakout_watch' && side === 'none') {
    const breakoutUp =
      bullishBreakClose &&
      lastRsi > 52 &&
      lastRsi < 78 &&
      price > regimeIndicators.ema20;

    const breakoutDown =
      bearishBreakClose &&
      lastRsi < 48 &&
      lastRsi > 22 &&
      price < regimeIndicators.ema20;

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

  // --- Нормализация уровней ---
  takeProfitPrice = normalizeTakeProfit({
    side,
    price,
    takeProfitPrice,
    lastAtr
  });

  ({ stopLossPrice, takeProfitPrice } = validateExitLevels({
    side,
    price,
    stopLossPrice,
    takeProfitPrice,
    lastAtr
  }));

  const netMoveCheck = expectedNetMove({
    side,
    price,
    takeProfitPrice
  });

  const riskReward = getRiskReward({
    side,
    price,
    stopLossPrice,
    takeProfitPrice
  });

  // Фильтр: нет смысла в сделке без net edge и RR
  if (
    side !== 'none' &&
    (
      netMoveCheck.netMove <= 0 ||
      netMoveCheck.netMoveRate < MIN_EXPECTED_NET_MOVE_RATE ||
      riskReward.ratio < MIN_RISK_REWARD_RATIO
    )
  ) {
    side = 'none';
    buy = false;
    sell = false;
    takeProfitPrice = null;
    stopLossPrice = null;
    positionSize = null;
    quantity = null;
  }

  // --- Размер позиции ---
  if (side !== 'none' && stopLossPrice != null) {
    const riskPerUnit = Math.abs(price - stopLossPrice);
    if (riskPerUnit > 0) {
      positionSize = riskCapital / riskPerUnit; // в рублях на риск
      // quantity в акциях; SBER lot = 1
      const rawQty = positionSize / price;
      quantity = Math.floor(rawQty);

      // Если меньше 1 акции — сделку не открываем
      if (quantity < MIN_QUANTITY) {
        side = 'none';
        buy = false;
        sell = false;
        takeProfitPrice = null;
        stopLossPrice = null;
        positionSize = null;
        quantity = null;
      } else {
        // Пересчитываем positionSize под целое число акций
        positionSize = quantity * price;
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
      regimeIndicators,
      expectedNetMove: netMoveCheck,
      riskReward,
      ready: true
    }
  };
}
