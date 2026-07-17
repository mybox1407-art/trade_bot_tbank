import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

const STARTING_BALANCE = 500;
const MAX_RISK_PER_TRADE = 0.01;
const MIN_ADX_TREND = 20;
const MIN_ADX_RANGE = 18;
const BB_SQUEEZE_THRESHOLD = 0.05;

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MarketRegime = 'trend_up' | 'trend_down' | 'range' | 'breakout_watch' | 'high_volatility' | 'unknown';

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

function mean(values: number[]) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function getVolumeSpike(volumes: number[], avgVol20: number) {
  const v = volumes[volumes.length - 1] ?? 0;
  return v >= avgVol20 * 1.1;
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

  if (atr.length < 2 || adx.length < 2 || ema20.length < 1 || ema50.length < 1 || ema200.length < 1 || bb.length < 1) {
    return { regime: 'unknown' as MarketRegime, ready: false, indicators: null as RegimeIndicators | null };
  }

  const lastClose = last(closes);
  const lastAtr = last(atr);
  const lastAdx = last(adx);
  const prevAdx = adx[adx.length - 2];
  const lastEma20 = last(ema20);
  const lastEma50 = last(ema50);
  const lastEma200 = last(ema200);
  const lastBb = last(bb);
  const avgVol20 = mean(volumes.slice(-20));
  const bbWidth = (lastBb.upper - lastBb.lower) / lastBb.middle;
  const adxRising = lastAdx.adx > prevAdx.adx;
  const atrPct = lastAtr / lastClose;
  const compression = bbWidth <= BB_SQUEEZE_THRESHOLD;

  const strongTrendUp =
    lastClose > lastEma200 &&
    lastEma20 > lastEma50 &&
    lastEma50 > lastEma200 &&
    lastAdx.adx >= MIN_ADX_TREND &&
    adxRising;

  const strongTrendDown =
    lastClose < lastEma200 &&
    lastEma20 < lastEma50 &&
    lastEma50 < lastEma200 &&
    lastAdx.adx >= MIN_ADX_TREND &&
    adxRising;

  const range = lastAdx.adx < MIN_ADX_RANGE && bbWidth < 0.08;
  const breakoutWatch = compression && lastAdx.adx >= 15 && lastAdx.adx <= 28 && getVolumeSpike(volumes, avgVol20);
  const highVolatility = atrPct > 0.025 || bbWidth > 0.12;

  let regime: MarketRegime = 'range';
  if (highVolatility) regime = 'high_volatility';
  else if (strongTrendUp) regime = 'trend_up';
  else if (strongTrendDown) regime = 'trend_down';
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

  const regimeInfo = detectMarketRegime(candles);
  const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const rsi = RSI.calculate({ period: 14, values: closes });
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });

  if (!regimeInfo.ready || !regimeInfo.indicators || macd.length < 2 || rsi.length < 1 || atr.length < 1 || bb.length < 1) {
    return {
      price: closes[closes.length - 1],
      buy: false,
      sell: false,
      side: 'none' as 'long' | 'short' | 'none',
      takeProfitPrice: null,
      stopLossPrice: null,
      positionSize: null,
      regime: 'unknown',
      indicators: { ready: false }
    };
  }

  const price = last(closes);
  const lastMacd = last(macd);
  const prevMacd = macd[macd.length - 2];
  const lastRsi = last(rsi);
  const lastAtr = last(atr);
  const lastBb = last(bb);
  const regimeIndicators = regimeInfo.indicators;

  const macdCrossUp = prevMacd.MACD! < prevMacd.signal! && lastMacd.MACD! > lastMacd.signal!;
  const macdCrossDown = prevMacd.MACD! > prevMacd.signal! && lastMacd.MACD! < lastMacd.signal!;
  const rsiBull = lastRsi > 40 && lastRsi < 65;
  const rsiBear = lastRsi < 60 && lastRsi > 35;

  const riskCapital = STARTING_BALANCE * MAX_RISK_PER_TRADE;
  const regime = regimeInfo.regime;
  let side: 'long' | 'short' | 'none' = 'none';
  let buy = false;
  let sell = false;
  let takeProfitPrice: number | null = null;
  let stopLossPrice: number | null = null;
  let positionSize: number | null = null;

  if (regime === 'trend_up' && macdCrossUp && rsiBull && price > regimeIndicators.ema200) {
    side = 'long';
    buy = true;
    stopLossPrice = price - lastAtr * 1.4;
    takeProfitPrice = price + lastAtr * 2.8;
  }

  if (regime === 'trend_down' && macdCrossDown && rsiBear && price < regimeIndicators.ema200) {
    side = 'short';
    sell = true;
    stopLossPrice = price + lastAtr * 1.4;
    takeProfitPrice = price - lastAtr * 2.8;
  }

  if (regime === 'range') {
    const longSetup = price <= lastBb.lower && lastRsi <= 30;
    const shortSetup = price >= lastBb.upper && lastRsi >= 70;
    if (longSetup) {
      side = 'long';
      buy = true;
      stopLossPrice = price - lastAtr * 1.2;
      takeProfitPrice = lastBb.middle;
    } else if (shortSetup) {
      side = 'short';
      sell = true;
      stopLossPrice = price + lastAtr * 1.2;
      takeProfitPrice = lastBb.middle;
    }
  }

  if (regime === 'breakout_watch') {
    const breakoutUp = price > lastBb.upper && lastRsi > 55;
    const breakoutDown = price < lastBb.lower && lastRsi < 45;
    if (breakoutUp) {
      side = 'long';
      buy = true;
      stopLossPrice = price - lastAtr * 1.3;
      takeProfitPrice = price + lastAtr * 3.0;
    } else if (breakoutDown) {
      side = 'short';
      sell = true;
      stopLossPrice = price + lastAtr * 1.3;
      takeProfitPrice = price - lastAtr * 3.0;
    }
  }

  if (regime === 'high_volatility') {
    buy = false;
    sell = false;
    side = 'none';
  }

  if (side !== 'none' && stopLossPrice != null) {
    const riskPerUnit = Math.abs(price - stopLossPrice);
    positionSize = riskPerUnit > 0 ? riskCapital / riskPerUnit : null;
  }

  return {
    price,
    buy,
    sell,
    side,
    takeProfitPrice,
    stopLossPrice,
    positionSize,
    regime,
    indicators: {
      macdCrossUp,
      macdCrossDown,
      lastRsi,
      lastAtr,
      rsiBull,
      rsiBear,
      bbUpper: lastBb.upper,
      bbMiddle: lastBb.middle,
      bbLower: lastBb.lower,
      regimeReady: regimeInfo.ready,
      regimeIndicators,
      ready: true
    }
  };
}
