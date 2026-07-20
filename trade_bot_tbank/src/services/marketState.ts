import { ADX, ATR, EMA } from 'technicalindicators';
import { Candle } from './strategy';

export type MarketState = 'resonant' | 'transition' | 'chaotic';
export type MarketBias = 'long' | 'short' | 'neutral';

export interface MarketStateInfo {
  state: MarketState;
  sideBias: MarketBias;
  coherence: number;
  trendScore: number;
  adxScore: number;
  alignmentScore: number;
  noiseScore: number;
  volatilityScore: number;
  volumeScore: number;
  extensionScore: number;
  ready: boolean;
  details: {
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
    adx: number | null;
    plusDI: number | null;
    minusDI: number | null;
    atr: number | null;
    atrPct: number | null;
    alignmentLong: number | null;
    alignmentShort: number | null;
    bodyConsistency: number | null;
    wickNoise: number | null;
    directionFlipRate: number | null;
    extensionPct: number | null;
    avgVolume5: number | null;
    avgVolume20: number | null;
    volumeRatio: number | null;
  };
}

const DEFAULT_LOOKBACK_ALIGNMENT = 10;
const DEFAULT_MIN_CANDLES = 220;

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

function safeNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function scoreLinear(
  value: number,
  bad: number,
  good: number
): number {
  if (!Number.isFinite(value)) return 0;
  if (good === bad) return value >= good ? 1 : 0;
  if (good > bad) {
    return clamp((value - bad) / (good - bad), 0, 1);
  }
  return clamp((bad - value) / (bad - good), 0, 1);
}

function calcDirectionalAlignment(
  candles: Candle[],
  side: 'long' | 'short',
  lookback = DEFAULT_LOOKBACK_ALIGNMENT
): number {
  if (candles.length < lookback + 1) return 0;

  const slice = candles.slice(-lookback);
  let directionalBars = 0;
  let weightedDirectional = 0;
  let totalAbsMove = 0;

  for (const candle of slice) {
    const move = candle.close - candle.open;
    const aligned = side === 'long' ? move > 0 : move < 0;
    if (aligned) directionalBars += 1;

    const absMove = Math.abs(move);
    totalAbsMove += absMove;
    if (aligned) weightedDirectional += absMove;
  }

  const barRatio = directionalBars / slice.length;
  const weightedRatio =
    totalAbsMove > 0 ? weightedDirectional / totalAbsMove : 0;

  return clamp(barRatio * 0.45 + weightedRatio * 0.55, 0, 1);
}

function calcBodyConsistency(
  candles: Candle[],
  lookback = DEFAULT_LOOKBACK_ALIGNMENT
): number {
  if (candles.length < lookback) return 0;

  const slice = candles.slice(-lookback);
  const ratios = slice.map(c => {
    const range = Math.max(c.high - c.low, 1e-9);
    return Math.abs(c.close - c.open) / range;
  });

  return clamp(mean(ratios), 0, 1);
}

function calcWickNoise(
  candles: Candle[],
  lookback = DEFAULT_LOOKBACK_ALIGNMENT
): number {
  if (candles.length < lookback) return 1;

  const slice = candles.slice(-lookback);
  const wickRatios = slice.map(c => {
    const range = Math.max(c.high - c.low, 1e-9);
    const bodyTop = Math.max(c.open, c.close);
    const bodyBottom = Math.min(c.open, c.close);
    const upperWick = c.high - bodyTop;
    const lowerWick = bodyBottom - c.low;
    return (Math.max(0, upperWick) + Math.max(0, lowerWick)) / range;
  });

  return clamp(mean(wickRatios), 0, 1);
}

function calcDirectionFlipRate(
  candles: Candle[],
  lookback = DEFAULT_LOOKBACK_ALIGNMENT
): number {
  if (candles.length < lookback + 1) return 1;

  const slice = candles.slice(-lookback);
  const dirs = slice.map(c => {
    const move = c.close - c.open;
    if (move > 0) return 1;
    if (move < 0) return -1;
    return 0;
  });

  let flips = 0;
  let comparable = 0;

  for (let i = 1; i < dirs.length; i++) {
    if (dirs[i] === 0 || dirs[i - 1] === 0) continue;
    comparable += 1;
    if (dirs[i] !== dirs[i - 1]) flips += 1;
  }

  if (comparable === 0) return 1;
  return clamp(flips / comparable, 0, 1);
}

function calcTrendScore(params: {
  price: number;
  ema20: number;
  ema50: number;
  ema200: number;
  side: 'long' | 'short';
  ema20Prev: number;
  ema50Prev: number;
}): number {
  const { price, ema20, ema50, ema200, side, ema20Prev, ema50Prev } = params;

  const slope20 = ema20 - ema20Prev;
  const slope50 = ema50 - ema50Prev;

  let score = 0;

  if (side === 'long') {
    if (price > ema200) score += 0.22;
    if (ema20 > ema50) score += 0.22;
    if (ema50 > ema200) score += 0.22;
    if (slope20 > 0) score += 0.17;
    if (slope50 > 0) score += 0.17;
  } else {
    if (price < ema200) score += 0.22;
    if (ema20 < ema50) score += 0.22;
    if (ema50 < ema200) score += 0.22;
    if (slope20 < 0) score += 0.17;
    if (slope50 < 0) score += 0.17;
  }

  return clamp(score, 0, 1);
}

function calcAdxScore(
  adx: number,
  adxPrev: number,
  plusDI: number,
  minusDI: number,
  side: 'long' | 'short'
): number {
  const adxLevelScore = scoreLinear(adx, 12, 28);
  const adxSlopeScore = scoreLinear(adx - adxPrev, -2, 2);

  const diAligned =
    side === 'long' ? plusDI > minusDI : minusDI > plusDI;

  const diSpread = Math.abs(plusDI - minusDI);
  const diScore = diAligned ? scoreLinear(diSpread, 2, 12) : 0;

  return clamp(adxLevelScore * 0.5 + adxSlopeScore * 0.2 + diScore * 0.3, 0, 1);
}

function calcVolatilityScore(atrPct: number): number {
  const tooDeadPenalty = scoreLinear(atrPct, 0.002, 0.005);
  const tooWildPenalty = scoreLinear(atrPct, 0.035, 0.02);
  return clamp(Math.min(tooDeadPenalty, tooWildPenalty), 0, 1);
}

function calcVolumeScore(volumeRatio: number): number {
  if (!Number.isFinite(volumeRatio) || volumeRatio <= 0) return 0;
  if (volumeRatio < 0.6) return scoreLinear(volumeRatio, 0.2, 0.6) * 0.6;
  if (volumeRatio <= 1.8) return scoreLinear(volumeRatio, 0.6, 1.2);
  return scoreLinear(volumeRatio, 3.0, 1.8) * 0.85;
}

function calcExtensionScore(extensionPct: number): number {
  return scoreLinear(extensionPct, 0.02, 0.004);
}

function classifyState(
  coherence: number,
  trendScore: number,
  noiseScore: number
): MarketState {
  if (coherence >= 0.67 && trendScore >= 0.58 && noiseScore <= 0.42) {
    return 'resonant';
  }
  if (coherence >= 0.42) {
    return 'transition';
  }
  return 'chaotic';
}

export function computeCoherenceScore(
  candles: Candle[],
  side: 'long' | 'short'
): number {
  const info = detectMarketState(candles);
  if (!info.ready) return 0;

  const aligned = info.sideBias === side;
  const base = info.coherence;

  if (!aligned && info.sideBias !== 'neutral') return round(base * 0.45, 6);
  if (info.sideBias === 'neutral') return round(base * 0.7, 6);
  return round(base, 6);
}

export function detectMarketState(candles: Candle[]): MarketStateInfo {
  if (!Array.isArray(candles) || candles.length < DEFAULT_MIN_CANDLES) {
    return {
      state: 'chaotic',
      sideBias: 'neutral',
      coherence: 0,
      trendScore: 0,
      adxScore: 0,
      alignmentScore: 0,
      noiseScore: 1,
      volatilityScore: 0,
      volumeScore: 0,
      extensionScore: 0,
      ready: false,
      details: {
        ema20: null,
        ema50: null,
        ema200: null,
        adx: null,
        plusDI: null,
        minusDI: null,
        atr: null,
        atrPct: null,
        alignmentLong: null,
        alignmentShort: null,
        bodyConsistency: null,
        wickNoise: null,
        directionFlipRate: null,
        extensionPct: null,
        avgVolume5: null,
        avgVolume20: null,
        volumeRatio: null
      }
    };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });

  if (
    ema20.length < 3 ||
    ema50.length < 3 ||
    ema200.length < 2 ||
    atr.length < 3 ||
    adx.length < 3
  ) {
    return {
      state: 'chaotic',
      sideBias: 'neutral',
      coherence: 0,
      trendScore: 0,
      adxScore: 0,
      alignmentScore: 0,
      noiseScore: 1,
      volatilityScore: 0,
      volumeScore: 0,
      extensionScore: 0,
      ready: false,
      details: {
        ema20: null,
        ema50: null,
        ema200: null,
        adx: null,
        plusDI: null,
        minusDI: null,
        atr: null,
        atrPct: null,
        alignmentLong: null,
        alignmentShort: null,
        bodyConsistency: null,
        wickNoise: null,
        directionFlipRate: null,
        extensionPct: null,
        avgVolume5: null,
        avgVolume20: null,
        volumeRatio: null
      }
    };
  }

  const price = last(closes);
  const lastEma20 = last(ema20);
  const prevEma20 = prev(ema20);
  const lastEma50 = last(ema50);
  const prevEma50 = prev(ema50);
  const lastEma200 = last(ema200);
  const lastAtr = last(atr);
  const lastAdx = last(adx);
  const prevAdx = prev(adx);

  const atrPct = price > 0 ? lastAtr / price : 0;
  const extensionPct = price > 0 ? Math.abs(price - lastEma20) / price : 0;

  const avgVolume5 = mean(volumes.slice(-5));
  const avgVolume20 = mean(volumes.slice(-20));
  const volumeRatio = avgVolume20 > 0 ? avgVolume5 / avgVolume20 : 1;

  const alignmentLong = calcDirectionalAlignment(candles, 'long');
  const alignmentShort = calcDirectionalAlignment(candles, 'short');
  const bodyConsistency = calcBodyConsistency(candles);
  const wickNoise = calcWickNoise(candles);
  const directionFlipRate = calcDirectionFlipRate(candles);

  const longTrendScore = calcTrendScore({
    price,
    ema20: lastEma20,
    ema50: lastEma50,
    ema200: lastEma200,
    side: 'long',
    ema20Prev: prevEma20,
    ema50Prev: prevEma50
  });

  const shortTrendScore = calcTrendScore({
    price,
    ema20: lastEma20,
    ema50: lastEma50,
    ema200: lastEma200,
    side: 'short',
    ema20Prev: prevEma20,
    ema50Prev: prevEma50
  });

  const longAdxScore = calcAdxScore(
    lastAdx.adx,
    prevAdx.adx,
    lastAdx.pdi,
    lastAdx.mdi,
    'long'
  );

  const shortAdxScore = calcAdxScore(
    lastAdx.adx,
    prevAdx.adx,
    lastAdx.pdi,
    lastAdx.mdi,
    'short'
  );

  const volatilityScore = calcVolatilityScore(atrPct);
  const volumeScore = calcVolumeScore(volumeRatio);
  const extensionScore = calcExtensionScore(extensionPct);

  const noiseScore = clamp(
    wickNoise * 0.45 + directionFlipRate * 0.35 + (1 - bodyConsistency) * 0.2,
    0,
    1
  );

  const longAlignmentScore = clamp(
    alignmentLong * 0.72 + bodyConsistency * 0.18 + (1 - directionFlipRate) * 0.1,
    0,
    1
  );

  const shortAlignmentScore = clamp(
    alignmentShort * 0.72 + bodyConsistency * 0.18 + (1 - directionFlipRate) * 0.1,
    0,
    1
  );

  const longCoherence = clamp(
    longTrendScore * 0.28 +
      longAdxScore * 0.2 +
      longAlignmentScore * 0.22 +
      volatilityScore * 0.1 +
      volumeScore * 0.08 +
      extensionScore * 0.07 +
      (1 - noiseScore) * 0.05,
    0,
    1
  );

  const shortCoherence = clamp(
    shortTrendScore * 0.28 +
      shortAdxScore * 0.2 +
      shortAlignmentScore * 0.22 +
      volatilityScore * 0.1 +
      volumeScore * 0.08 +
      extensionScore * 0.07 +
      (1 - noiseScore) * 0.05,
    0,
    1
  );

  let sideBias: MarketBias = 'neutral';
  let trendScore = 0;
  let adxScore = 0;
  let alignmentScore = 0;
  let coherence = 0;

  if (longCoherence > shortCoherence + 0.06) {
    sideBias = 'long';
    trendScore = longTrendScore;
    adxScore = longAdxScore;
    alignmentScore = longAlignmentScore;
    coherence = longCoherence;
  } else if (shortCoherence > longCoherence + 0.06) {
    sideBias = 'short';
    trendScore = shortTrendScore;
    adxScore = shortAdxScore;
    alignmentScore = shortAlignmentScore;
    coherence = shortCoherence;
  } else {
    sideBias = 'neutral';
    trendScore = Math.max(longTrendScore, shortTrendScore) * 0.85;
    adxScore = Math.max(longAdxScore, shortAdxScore) * 0.85;
    alignmentScore = Math.max(longAlignmentScore, shortAlignmentScore) * 0.85;
    coherence = Math.max(longCoherence, shortCoherence) * 0.8;
  }

  const state = classifyState(coherence, trendScore, noiseScore);

  return {
    state,
    sideBias,
    coherence: round(coherence, 6),
    trendScore: round(trendScore, 6),
    adxScore: round(adxScore, 6),
    alignmentScore: round(alignmentScore, 6),
    noiseScore: round(noiseScore, 6),
    volatilityScore: round(volatilityScore, 6),
    volumeScore: round(volumeScore, 6),
    extensionScore: round(extensionScore, 6),
    ready: true,
    details: {
      ema20: safeNumber(round(lastEma20)),
      ema50: safeNumber(round(lastEma50)),
      ema200: safeNumber(round(lastEma200)),
      adx: safeNumber(round(lastAdx.adx, 6)),
      plusDI: safeNumber(round(lastAdx.pdi, 6)),
      minusDI: safeNumber(round(lastAdx.mdi, 6)),
      atr: safeNumber(round(lastAtr)),
      atrPct: safeNumber(round(atrPct, 6)),
      alignmentLong: safeNumber(round(alignmentLong, 6)),
      alignmentShort: safeNumber(round(alignmentShort, 6)),
      bodyConsistency: safeNumber(round(bodyConsistency, 6)),
      wickNoise: safeNumber(round(wickNoise, 6)),
      directionFlipRate: safeNumber(round(directionFlipRate, 6)),
      extensionPct: safeNumber(round(extensionPct, 6)),
      avgVolume5: safeNumber(round(avgVolume5, 4)),
      avgVolume20: safeNumber(round(avgVolume20, 4)),
      volumeRatio: safeNumber(round(volumeRatio, 6))
    }
  };
}
