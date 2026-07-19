import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

const STARTING_BALANCE = 50000;
const MAX_RISK_PER_TRADE = 0.01;

const MIN_ADX_TREND = 20;
const MIN_ADX_RANGE = 18;
const BB_SQUEEZE_THRESHOLD = 0.05;

const COMMISSION_RATE = 0.003; // 0.3% за одну сторону сделки
const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2; // вход + выход
const MIN_NET_PROFIT_BUFFER_RATE = 0.001; // 0.1% запас поверх round-trip комиссии
const MIN_TP_ATR_MULTIPLIER = 0.5;

const STRUCTURE_LOOKBACK = 10;
const STOP_STRUCTURE_LOOKBACK = 5;
const BREAKOUT_LOOKBACK = 20;

const MIN_EXPECTED_NET_MOVE_RATE = 0.002; // минимум 0.2% чистого движения после комиссии
const MIN_RISK_REWARD_RATIO = 1.5;

// Фильтр торговых часов:
// 10:00–18:00 МСК = 07:00–15:00 UTC
const TRADING_HOUR_UTC_FROM = 7;
const TRADING_HOUR_UTC_TO = 15;

// Более строгий фильтр объема для breakout
const VOLUME_SPIKE_MULTIPLIER = 1.35;

// Минимальное смещение пробоя за уровень в долях ATR,
// чтобы не ловить мелкий шум вокруг полос Боллинджера
const BREAKOUT_MIN_ATR_DISPLACEMENT = 0.5;

// Дополнительный фильтр тела свечи для breakout
const BREAKOUT_MIN_BODY_PCT = 0.6;

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
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function getVolumeSpike(volumes: number[], avgVol20: number): boolean {
  const v = volumes[volumes.length - 1] ?? 0;
  return v >= avgVol20 * VOLUME_SPIKE_MULTIPLIER;
}

/**
 * ATR-множители под режим рынка.
 * Для breakout целимся дальше, потому что идея режима —
 * поймать расширение волатильности после сжатия.
 */
function getAtrMultipliers(regime: MarketRegime, atrPct: number) {
  const highVol = atrPct > 0.02;

  if (regime === 'trend_up' || regime === 'trend_down') {
    return { stop: highVol ? 2.3 : 2.0, target: highVol ? 3.8 : 3.2 };
  }

  if (regime === 'range') {
    return { stop: 1.4, target: 1.1 };
  }

  if (regime === 'breakout_watch') {
    return { stop: highVol ? 2.0 : 1.8, target: highVol ? 4.2 : 3.6 };
  }

  return { stop: 0, target: 0 };
}

/**
 * Фильтр времени по UTC.
 */
function isTradingHour(timestamp: number): boolean {
  const hourUtc = new Date(timestamp).getUTCHours();
  return hourUtc >= TRADING_HOUR_UTC_FROM && hourUtc < TRADING_HOUR_UTC_TO;
}

/**
 * Минимально допустимый тейк:
 * 1) не ближе заданной доли ATR,
 * 2) не ближе, чем требуется для покрытия комиссий и небольшого запаса.
 */
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
  const minCommissionDistance = price * (ROUND_TRIP_COMMISSION_RATE + MIN_NET_PROFIT_BUFFER_RATE);
  const minDistance = Math.max(minAtrDistance, minCommissionDistance);

  if (side === 'long') {
    return Math.max(takeProfitPrice, price + minDistance);
  }

  if (side === 'short') {
    return Math.min(takeProfitPrice, price - minDistance);
  }

  return takeProfitPrice;
}

/**
 * Считает ожидаемое движение до тейка после вычета round-trip комиссии.
 */
function expectedNetMove(params: {
  side: 'long' | 'short' | 'none';
  price: number;
  takeProfitPrice: number | null;
}) {
  const { side, price, takeProfitPrice } = params;

  if (side === 'none' || takeProfitPrice == null || price <= 0) {
    return {
      grossMove: 0,
      netMove: 0,
      netMoveRate: 0
    };
  }

  const grossMove =
    side === 'long'
      ? takeProfitPrice - price
      : price - takeProfitPrice;

  const commissionCost = price * ROUND_TRIP_COMMISSION_RATE;
  const netMove = grossMove - commissionCost;
  const netMoveRate = netMove / price;

  return {
    grossMove,
    netMove,
    netMoveRate
  };
}

/**
 * Структурная цель по ближайшей локальной структуре.
 */
function getStructureTarget(params: {
  side: 'long' | 'short' | 'none';
  highs: number[];
  lows: number[];
  price: number;
  lastAtr: number;
}) {
  const { side, highs, lows, price, lastAtr } = params;

  if (side === 'none') {
    return null;
  }

  const recentHigh = Math.max(...highs.slice(-STRUCTURE_LOOKBACK));
  const recentLow = Math.min(...lows.slice(-STRUCTURE_LOOKBACK));

  if (side === 'long') {
    return Math.max(recentHigh, price + lastAtr * 1.5);
  }

  if (side === 'short') {
    return Math.min(recentLow, price - lastAtr * 1.5);
  }

  return null;
}

/**
 * Структурный стоп по локальному экстремуму.
 * Если структура слишком близко или "ломается", используем fallback через ATR.
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

  if (side === 'none') {
    return null;
  }

  const recentHigh = Math.max(...highs.slice(-STOP_STRUCTURE_LOOKBACK));
  const recentLow = Math.min(...lows.slice(-STOP_STRUCTURE_LOOKBACK));

  const fallbackLong = price - lastAtr * atrStopMultiplier;
  const fallbackShort = price + lastAtr * atrStopMultiplier;

  if (side === 'long') {
    return Math.min(recentLow, fallbackLong);
  }

  if (side === 'short') {
    return Math.max(recentHigh, fallbackShort);
  }

  return null;
}

/**
 * Проверка минимального отношения прибыль/риск.
 */
function getRiskReward(params: {
  side: 'long' | 'short' | 'none';
  price: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
}) {
  const { side, price, stopLossPrice, takeProfitPrice } = params;

  if (
    side === 'none' ||
    stopLossPrice == null ||
    takeProfitPrice == null
  ) {
    return {
      risk: 0,
      reward: 0,
      ratio: 0
    };
  }

  const risk =
    side === 'long'
      ? price - stopLossPrice
      : stopLossPrice - price;

  const reward =
    side === 'long'
      ? takeProfitPrice - price
      : price - takeProfitPrice;

  if (risk <= 0 || reward <= 0) {
    return {
      risk,
      reward,
      ratio: 0
    };
  }

  return {
    risk,
    reward,
    ratio: reward / risk
  };
}

/**
 * Проверяем, что пробой действительно вышел за границу
 * не только на "копейки", а хотя бы на разумную долю ATR.
 */
function getBreakoutDisplacement(params: {
  side: 'long' | 'short';
  price: number;
  bandLevel: number;
  lastAtr: number;
}) {
  const { side, price, bandLevel, lastAtr } = params;

  if (lastAtr <= 0) {
    return {
      distance: 0,
      distanceAtr: 0
    };
  }

  const distance =
    side === 'long'
      ? price - bandLevel
      : bandLevel - price;

  return {
    distance,
    distanceAtr: distance / lastAtr
  };
}

/**
 * Проверяем пробой локальной структуры последних N свечей.
 * Это помогает отсекать ложные выходы только за Bollinger Bands.
 */
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
    return {
      level: recentHigh,
      broken: price > recentHigh
    };
  }

  return {
    level: recentLow,
    broken: price < recentLow
  };
}

/**
 * Защитная проверка, чтобы уровни выхода не оказались
 * "перевернутыми" относительно цены входа.
 */
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
    lastAtr * 1.5,
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

  const trendUp =
    lastClose > lastEma200 &&
    lastEma20 > lastEma50 &&
    lastAdx.adx >= MIN_ADX_TREND &&
    adxRising;

  const trendDown =
    lastClose < lastEma200 &&
    lastEma20 < lastEma50 &&
    lastAdx.adx >= MIN_ADX_TREND &&
    adxRising;

  const range = lastAdx.adx < MIN_ADX_RANGE && bbWidth < 0.08;

  const breakoutWatch =
    compression &&
    lastAdx.adx >= 15 &&
    lastAdx.adx <= 28 &&
    getVolumeSpike(volumes, avgVol20);

  const highVolatility = atrPct > 0.025 || bbWidth > 0.12;

  let regime: MarketRegime = 'range';

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

  if (
    !regimeInfo.ready ||
    !regimeInfo.indicators ||
    macd.length < 2 ||
    rsi.length < 2 ||
    atr.length < 2 ||
    bb.length < 2 ||
    candles.length < 2
  ) {
    return {
      price: closes[closes.length - 1],
      buy: false,
      sell: false,
      side: 'none' as 'long' | 'short' | 'none',
      takeProfitPrice: null,
      stopLossPrice: null,
      positionSize: null,
      quantity: null,
      regime: 'unknown' as MarketRegime,
      indicators: { ready: false }
    };
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

  const macdCrossUp =
    prevMacd.MACD! < prevMacd.signal! && lastMacd.MACD! > lastMacd.signal!;
  const macdCrossDown =
    prevMacd.MACD! > prevMacd.signal! && lastMacd.MACD! < lastMacd.signal!;

  const rsiBull = lastRsi > 42 && lastRsi < 68;
  const rsiBear = lastRsi < 58 && lastRsi > 32;

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
    lastAtr >= prevAtr &&
    longBreakoutDisplacement.distanceAtr >= BREAKOUT_MIN_ATR_DISPLACEMENT &&
    longStructureBreak.broken &&
    volumeSpike;

  const bearishBreakClose =
    prevPrice >= prevBb.lower &&
    price < lastBb.lower &&
    price < lastOpen &&
    bodyPctOfRange >= BREAKOUT_MIN_BODY_PCT &&
    lastAtr >= prevAtr &&
    shortBreakoutDisplacement.distanceAtr >= BREAKOUT_MIN_ATR_DISPLACEMENT &&
    shortStructureBreak.broken &&
    volumeSpike;

  if (!isTradingHour(last(candles).time)) {
    return {
      price,
      buy: false,
      sell: false,
      side: 'none' as 'long' | 'short' | 'none',
      takeProfitPrice: null,
      stopLossPrice: null,
      positionSize: null,
      quantity: null,
      regime,
      indicators: {
        macdCrossUp,
        macdCrossDown,
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
        expectedNetMove: {
          grossMove: 0,
          netMove: 0,
          netMoveRate: 0
        },
        riskReward: {
          risk: 0,
          reward: 0,
          ratio: 0
        },
        ready: true
      }
    };
  }

  if (regime === 'trend_up' && macdCrossUp && rsiBull && price > regimeIndicators.ema200) {
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
    const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });

    takeProfitPrice = Math.max(atrTarget, structureTarget ?? atrTarget);
  }

  if (regime === 'trend_down' && macdCrossDown && rsiBear && price < regimeIndicators.ema200) {
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
    const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });

    takeProfitPrice = Math.min(atrTarget, structureTarget ?? atrTarget);
  }

  if (regime === 'range') {
    const longSetup = price <= lastBb.lower && lastRsi <= 30;
    const shortSetup = price >= lastBb.upper && lastRsi >= 70;

    if (longSetup) {
      side = 'long';
      buy = true;

      stopLossPrice = price - lastAtr * atrMultipliers.stop;
      takeProfitPrice = Math.max(lastBb.middle, price + lastAtr * atrMultipliers.target);
    } else if (shortSetup) {
      side = 'short';
      sell = true;

      stopLossPrice = price + lastAtr * atrMultipliers.stop;
      takeProfitPrice = Math.min(lastBb.middle, price - lastAtr * atrMultipliers.target);
    }
  }

  // breakout_watch НЕ выключаем.
  // Вместо этого даем вход только при более качественном подтверждении:
  // объем, вынос за Bollinger минимум на 0.5 ATR, пробой локальной структуры и сильное тело свечи.
  if (regime === 'breakout_watch') {
    const breakoutUp =
      bullishBreakClose &&
      lastRsi > 56 &&
      prevRsi <= 60 &&
      price > regimeIndicators.ema20;

    const breakoutDown =
      bearishBreakClose &&
      lastRsi < 44 &&
      prevRsi >= 40 &&
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
      const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });

      // Для breakout берем более дальнюю цель,
      // т.к. смысл режима — ловить импульс после сжатия
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
      const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });

      takeProfitPrice = Math.min(atrTarget, structureTarget ?? atrTarget);
    }
  }

  if (regime === 'high_volatility') {
    buy = false;
    sell = false;
    side = 'none';
    takeProfitPrice = null;
    stopLossPrice = null;
  }

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

  if (side !== 'none' && stopLossPrice != null) {
    const riskPerUnit = Math.abs(price - stopLossPrice);
    positionSize = riskPerUnit > 0 ? riskCapital / riskPerUnit : null;
    quantity = positionSize != null ? positionSize / price : null;
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
