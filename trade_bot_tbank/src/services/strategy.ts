import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

const STARTING_BALANCE = 50000;
const MAX_RISK_PER_TRADE = 0.01;
const MIN_ADX_TREND = 20;
const MIN_ADX_RANGE = 18;
const BB_SQUEEZE_THRESHOLD = 0.05;

const COMMISSION_RATE = 0.003; // 0.3% за сделку
const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2; // вход + выход
const MIN_TP_ATR_MULTIPLIER = 0.5;
const MIN_NET_PROFIT_BUFFER_RATE = 0.001; // 0.1% поверх комиссий как минимальный запас

const STRUCTURE_LOOKBACK = 10;
const MIN_EXPECTED_NET_MOVE_RATE = 0.002; // минимум 0.2% чистого ожидаемого движения после комиссий

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

function last<T>(arr: T[]) {
  return arr[arr.length - 1];
}

function prev<T>(arr: T[]) {
  return arr[arr.length - 2];
}

function mean(values: number[]) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function getVolumeSpike(volumes: number[], avgVol20: number) {
  const v = volumes[volumes.length - 1] ?? 0;
  return v >= avgVol20 * 1.1;
}

function getAtrMultipliers(regime: MarketRegime, atrPct: number) {
  const highVol = atrPct > 0.02;

  if (regime === 'trend_up' || regime === 'trend_down') {
    return { stop: highVol ? 2.5 : 2.0, target: highVol ? 3.8 : 3.2 };
  }

  if (regime === 'range') {
    return { stop: 1.4, target: 1.0 };
  }

  if (regime === 'breakout_watch') {
    return { stop: highVol ? 2.5 : 2.0, target: highVol ? 4.0 : 3.6 };
  }

  return { stop: 0, target: 0 };
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
    side === 'long'
      ? takeProfitPrice - price
      : price - takeProfitPrice;

  const commissionCost = price * ROUND_TRIP_COMMISSION_RATE;
  const netMove = grossMove - commissionCost;
  const netMoveRate = netMove / price;

  return { grossMove, netMove, netMoveRate };
}

function getStructureTarget(params: {
  side: 'long' | 'short' | 'none';
  highs: number[];
  lows: number[];
  price: number;
  lastAtr: number;
}) {
  const { side, highs, lows, price, lastAtr } = params;

  if (side === 'none') return null;

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
  const fallbackTakeDistance = Math.max(lastAtr * 1.5, price * (ROUND_TRIP_COMMISSION_RATE + MIN_NET_PROFIT_BUFFER_RATE));

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
      regime: 'unknown',
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

  const bullishBreakClose =
    prevPrice <= prev(last([lastBb, lastBb])) && // placeholder-safe compatibility
    price > lastBb.upper &&
    price > lastOpen &&
    bodyPctOfRange >= 0.55 &&
    lastAtr >= prevAtr;

  const bearishBreakClose =
    prevPrice >= prev(last([lastBb, lastBb])) &&
    price < lastBb.lower &&
    price < lastOpen &&
    bodyPctOfRange >= 0.55 &&
    lastAtr >= prevAtr;

  if (regime === 'trend_up' && macdCrossUp && rsiBull && price > regimeIndicators.ema200) {
    side = 'long';
    buy = true;
    stopLossPrice = price - lastAtr * atrMultipliers.stop;

    const atrTarget = price + lastAtr * atrMultipliers.target;
    const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });
    takeProfitPrice = Math.max(atrTarget, structureTarget ?? atrTarget);
  }

  if (regime === 'trend_down' && macdCrossDown && rsiBear && price < regimeIndicators.ema200) {
    side = 'short';
    sell = true;
    stopLossPrice = price + lastAtr * atrMultipliers.stop;

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
      const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });
      takeProfitPrice = Math.max(lastBb.middle, structureTarget ?? lastBb.middle);
    } else if (shortSetup) {
      side = 'short';
      sell = true;
      stopLossPrice = price + lastAtr * atrMultipliers.stop;
      const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });
      takeProfitPrice = Math.min(lastBb.middle, structureTarget ?? lastBb.middle);
    }
  }

  if (regime === 'breakout_watch') {
    const breakoutUp =
      bullishBreakClose &&
      lastRsi > 56 &&
      prevRsi <= 60;

    const breakoutDown =
      bearishBreakClose &&
      lastRsi < 44 &&
      prevRsi >= 40;

    if (breakoutUp) {
      side = 'long';
      buy = true;
      stopLossPrice = price - lastAtr * atrMultipliers.stop;

      const atrTarget = price + lastAtr * atrMultipliers.target;
      const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });
      takeProfitPrice = Math.max(atrTarget, structureTarget ?? atrTarget);
    } else if (breakoutDown) {
      side = 'short';
      sell = true;
      stopLossPrice = price + lastAtr * atrMultipliers.stop;

      const atrTarget = price - lastAtr * atrMultipliers.target;
      const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });
      takeProfitPrice = Math.min(atrTarget, structureTarget ?? atrTarget);
    }
  }

  if (regime === 'high_volatility') {
    buy = false;
    sell = false;
    side = 'none';
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

  if (
    side !== 'none' &&
    (
      netMoveCheck.netMove <= 0 ||
      netMoveCheck.netMoveRate < MIN_EXPECTED_NET_MOVE_RATE
    )
  ) {
    side = 'none';
    buy = false;
    sell = false;
    takeProfitPrice = null;
    stopLossPrice = null;
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
      regimeReady: regimeInfo.ready,
      regimeIndicators,
      expectedNetMove: netMoveCheck,
      ready: true
    }
  };
}
