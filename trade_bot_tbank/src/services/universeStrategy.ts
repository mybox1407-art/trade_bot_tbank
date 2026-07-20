import { EMA, ADX, ATR } from 'technicalindicators';
import {
  Candle,
  MAX_RISK_PER_TRADE,
  STARTING_BALANCE,
  TP1_FRACTION
} from './strategy';
import { detectMarketState } from './marketState';

export type UniverseSignalSide = 'long' | 'short' | 'none';

export interface UniverseSignal {
  symbol: string;
  side: UniverseSignalSide;
  regime: string;
  state: 'resonant' | 'transition' | 'chaotic' | 'unknown';
  sideBias: 'long' | 'short' | 'neutral';
  coherence: number;
  score: number;
  rawScore: number;
  price: number;
  stopLossPrice: number | null;
  takeProfit1Price: number | null;
  takeProfit2Price: number | null;
  takeProfitPrice: number | null;
  quantity: number | null;
  positionSize: number | null;
  tp1Fraction: number;
  initialR: number | null;
  riskMultiplier: number;
  indicators: Record<string, unknown>;
}

export interface UniverseRankCandidate {
  symbol: string;
  score: number;
  rawScore: number;
  side: 'long' | 'short';
  regime: string;
  state: 'resonant' | 'transition' | 'chaotic' | 'unknown';
  coherence: number;
  signal: UniverseSignal;
}

export interface UniverseStrategyOptions {
  riskPerTrade?: number;
  minScore?: number;
  warmupCandles?: number;
}

const DEFAULT_MIN_SCORE = 4.0;
const DEFAULT_WARMUP = 250;

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function prev<T>(arr: T[]): T {
  return arr[arr.length - 2];
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildEmptySignal(symbol: string, price = 0): UniverseSignal {
  return {
    symbol,
    side: 'none',
    regime: 'unknown',
    state: 'unknown',
    sideBias: 'neutral',
    coherence: 0,
    score: 0,
    rawScore: 0,
    price,
    stopLossPrice: null,
    takeProfit1Price: null,
    takeProfit2Price: null,
    takeProfitPrice: null,
    quantity: null,
    positionSize: null,
    tp1Fraction: TP1_FRACTION,
    initialR: null,
    riskMultiplier: 0,
    indicators: { ready: false }
  };
}

function calcRelativeStrength(closes: number[], lookback: number): number {
  if (closes.length < lookback + 1) return 0;
  const from = closes[closes.length - 1 - lookback];
  const to = closes[closes.length - 1];
  if (!Number.isFinite(from) || from <= 0) return 0;
  return (to - from) / from;
}

function getStateScoreMultiplier(
  state: 'resonant' | 'transition' | 'chaotic',
  coherence: number
): number {
  if (state === 'chaotic') return 0;
  if (state === 'transition') {
    return clamp(0.35 + coherence * 0.35, 0.35, 0.7);
  }
  return clamp(0.85 + coherence * 0.25, 0.85, 1.1);
}

function getStateRiskMultiplier(
  state: 'resonant' | 'transition' | 'chaotic',
  coherence: number
): number {
  if (state === 'chaotic') return 0;
  if (state === 'transition') {
    return clamp(0.25 + coherence * 0.35, 0.25, 0.5);
  }
  return clamp(0.75 + coherence * 0.35, 0.75, 1.0);
}

function calcScoreForSide(params: {
  side: 'long' | 'short';
  candles: Candle[];
  symbol: string;
}): UniverseSignal {
  const { side, candles, symbol } = params;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const price = last(closes) ?? 0;
  if (!Number.isFinite(price) || price <= 0) return buildEmptySignal(symbol, price);

  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

  if (
    ema20.length < 3 ||
    ema50.length < 3 ||
    ema200.length < 2 ||
    adx.length < 3 ||
    atr.length < 3
  ) {
    return buildEmptySignal(symbol, price);
  }

  const stateInfo = detectMarketState(candles);
  if (!stateInfo.ready) return buildEmptySignal(symbol, price);
  if (stateInfo.state === 'chaotic') return buildEmptySignal(symbol, price);
  if (stateInfo.sideBias !== 'neutral' && stateInfo.sideBias !== side) {
    return buildEmptySignal(symbol, price);
  }

  const lastEma20 = last(ema20);
  const prevEma20 = prev(ema20);
  const lastEma50 = last(ema50);
  const lastEma200 = last(ema200);
  const lastAdx = last(adx);
  const prevAdx = prev(adx);
  const lastAtr = last(atr);

  const rs48 = calcRelativeStrength(closes, 48);
  const rs16 = calcRelativeStrength(closes, 16);
  const avgVol20 = mean(volumes.slice(-20));
  const avgVol5 = mean(volumes.slice(-5));
  const volBoost = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;

  const emaSlope20 = lastEma20 - prevEma20;
  const atrPct = price > 0 ? lastAtr / price : 0;
  const extension = price > 0 ? Math.abs(price - lastEma20) / price : 0;
  const adxRising = lastAdx.adx > prevAdx.adx;

  const stackUp = lastEma20 > lastEma50 && lastEma50 > lastEma200;
  const stackDown = lastEma20 < lastEma50 && lastEma50 < lastEma200;
  const nearEma20 = extension <= 0.012;
  const notTooDead = atrPct >= 0.0035;
  const notTooWild = atrPct <= 0.03;
  const pullbackLong = price >= lastEma20 * 0.997 && price <= lastEma20 * 1.01;
  const pullbackShort = price <= lastEma20 * 1.003 && price >= lastEma20 * 0.99;

  let rawScore = 0;
  let sideOk = false;

  if (side === 'long') {
    if (price > lastEma200) rawScore += 1.2;
    if (stackUp) rawScore += 1.4;
    if (emaSlope20 > 0) rawScore += 0.8;
    if (rs48 > 0.02) rawScore += clamp(rs48 * 30, 0, 2.2);
    if (rs16 > 0.005) rawScore += clamp(rs16 * 40, 0, 1.2);
    if (lastAdx.adx >= 18) rawScore += 1.0;
    if (adxRising) rawScore += 0.6;
    if (pullbackLong) rawScore += 0.8;
    if (nearEma20) rawScore += 0.5;
    if (volBoost >= 0.9 && volBoost <= 1.8) rawScore += 0.4;
    if (!notTooDead) rawScore -= 1.0;
    if (!notTooWild) rawScore -= 1.2;
    if (extension > 0.018) rawScore -= 1.5;

    sideOk =
      price > lastEma200 &&
      stackUp &&
      emaSlope20 > 0 &&
      lastAdx.adx >= 18 &&
      pullbackLong &&
      nearEma20 &&
      notTooDead &&
      notTooWild;
  } else {
    if (price < lastEma200) rawScore += 1.2;
    if (stackDown) rawScore += 1.4;
    if (emaSlope20 < 0) rawScore += 0.8;
    if (rs48 < -0.02) rawScore += clamp(Math.abs(rs48) * 30, 0, 2.2);
    if (rs16 < -0.005) rawScore += clamp(Math.abs(rs16) * 40, 0, 1.2);
    if (lastAdx.adx >= 18) rawScore += 1.0;
    if (adxRising) rawScore += 0.6;
    if (pullbackShort) rawScore += 0.8;
    if (nearEma20) rawScore += 0.5;
    if (volBoost >= 0.9 && volBoost <= 1.8) rawScore += 0.4;
    if (!notTooDead) rawScore -= 1.0;
    if (!notTooWild) rawScore -= 1.2;
    if (extension > 0.018) rawScore -= 1.5;

    sideOk =
      price < lastEma200 &&
      stackDown &&
      emaSlope20 < 0 &&
      lastAdx.adx >= 18 &&
      pullbackShort &&
      nearEma20 &&
      notTooDead &&
      notTooWild;
  }

  if (!sideOk) return buildEmptySignal(symbol, price);

  const scoreMultiplier = getStateScoreMultiplier(
    stateInfo.state,
    stateInfo.coherence
  );
  const riskMultiplier = getStateRiskMultiplier(
    stateInfo.state,
    stateInfo.coherence
  );

  if (riskMultiplier <= 0 || scoreMultiplier <= 0) {
    return buildEmptySignal(symbol, price);
  }

  const adjustedRaw = rawScore + stateInfo.coherence * 1.25;
  const score = adjustedRaw * scoreMultiplier;

  const stopDistance = Math.max(lastAtr * 1.35, price * 0.0045);
  const stopLossPrice =
    side === 'long' ? price - stopDistance : price + stopDistance;
  const initialR = Math.abs(price - stopLossPrice);

  if (!Number.isFinite(initialR) || initialR <= 0) {
    return buildEmptySignal(symbol, price);
  }

  const takeProfit1Price =
    side === 'long' ? price + 1.5 * initialR : price - 1.5 * initialR;
  const takeProfit2Price =
    side === 'long' ? price + 2.2 * initialR : price - 2.2 * initialR;

  return {
    symbol,
    side,
    regime: stateInfo.state,
    state: stateInfo.state,
    sideBias: stateInfo.sideBias,
    coherence: round(stateInfo.coherence, 6),
    score: round(score, 4),
    rawScore: round(adjustedRaw, 4),
    price: round(price),
    stopLossPrice: round(stopLossPrice),
    takeProfit1Price: round(takeProfit1Price),
    takeProfit2Price: round(takeProfit2Price),
    takeProfitPrice: round(takeProfit2Price),
    quantity: null,
    positionSize: null,
    tp1Fraction: TP1_FRACTION,
    initialR: round(initialR),
    riskMultiplier: round(riskMultiplier, 6),
    indicators: {
      ready: true,
      rs48: round(rs48, 6),
      rs16: round(rs16, 6),
      ema20: round(lastEma20),
      ema50: round(lastEma50),
      ema200: round(lastEma200),
      emaSlope20: round(emaSlope20, 6),
      adx: round(lastAdx.adx, 4),
      adxRising,
      atr: round(lastAtr),
      atrPct: round(atrPct, 6),
      volBoost: round(volBoost, 4),
      extension: round(extension, 6),
      state: stateInfo.state,
      sideBias: stateInfo.sideBias,
      coherence: round(stateInfo.coherence, 6),
      trendScore: stateInfo.trendScore,
      adxScore: stateInfo.adxScore,
      alignmentScore: stateInfo.alignmentScore,
      noiseScore: stateInfo.noiseScore,
      volatilityScore: stateInfo.volatilityScore,
      volumeScore: stateInfo.volumeScore,
      extensionScore: stateInfo.extensionScore,
      stateDetails: stateInfo.details
    }
  };
}

function applyRiskToSignal(
  signal: UniverseSignal,
  balance: number,
  riskPerTrade: number
): UniverseSignal {
  if (
    signal.side === 'none' ||
    signal.stopLossPrice == null ||
    signal.initialR == null ||
    signal.initialR <= 0 ||
    signal.price <= 0
  ) {
    return signal;
  }

  const effectiveRisk = riskPerTrade * signal.riskMultiplier;
  if (!Number.isFinite(effectiveRisk) || effectiveRisk <= 0) {
    return buildEmptySignal(signal.symbol, signal.price);
  }

  const riskCapital = balance * effectiveRisk;
  let quantity = Math.floor(riskCapital / signal.initialR);

  if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;

  const positionSize = quantity * signal.price;

  return {
    ...signal,
    quantity,
    positionSize: round(positionSize, 6)
  };
}

export function rankUniverseCandidates(
  candlesBySymbol: Record<string, Candle[]>,
  balance: number = STARTING_BALANCE,
  options: UniverseStrategyOptions = {}
): UniverseRankCandidate[] {
  const riskPerTrade = options.riskPerTrade ?? MAX_RISK_PER_TRADE;
  const warmupCandles = options.warmupCandles ?? DEFAULT_WARMUP;
  const ranked: UniverseRankCandidate[] = [];

  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    if (!Array.isArray(candles) || candles.length < warmupCandles) continue;

    const longSignal = applyRiskToSignal(
      calcScoreForSide({ side: 'long', candles, symbol }),
      balance,
      riskPerTrade
    );

    const shortSignal = applyRiskToSignal(
      calcScoreForSide({ side: 'short', candles, symbol }),
      balance,
      riskPerTrade
    );

    const best =
      longSignal.score >= shortSignal.score ? longSignal : shortSignal;

    if (best.side !== 'none') {
      ranked.push({
        symbol,
        score: best.score,
        rawScore: best.rawScore,
        side: best.side as 'long' | 'short',
        regime: best.regime,
        state: best.state,
        coherence: best.coherence,
        signal: best
      });
    }
  }

  return ranked.sort((a, b) => b.score - a.score);
}

export function pickBestUniverseSignal(
  candlesBySymbol: Record<string, Candle[]>,
  balance: number = STARTING_BALANCE,
  options: UniverseStrategyOptions = {}
): UniverseSignal {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const ranked = rankUniverseCandidates(candlesBySymbol, balance, options);
  const best = ranked[0];

  if (!best || best.score < minScore) {
    const fallbackSymbol = Object.keys(candlesBySymbol)[0] ?? 'UNKNOWN';
    return buildEmptySignal(fallbackSymbol, 0);
  }

  return best.signal;
}
