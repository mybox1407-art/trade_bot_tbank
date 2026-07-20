import { EMA, ADX, ATR } from 'technicalindicators';
import {
  Candle,
  MAX_RISK_PER_TRADE,
  STARTING_BALANCE,
  TP1_FRACTION
} from './strategy';
import { detectMarketState } from './marketState';

export type UniverseSignalSide = 'long' | 'short' | 'none';
export type UniverseRejectReason =
  | 'not_ready'
  | 'state_not_ready'
  | 'state_chaotic'
  | 'side_bias_mismatch'
  | 'long_side_bias_short'
  | 'short_side_bias_long'
  | 'price_invalid'
  | 'long_conditions_failed'
  | 'short_conditions_failed'
  | 'long_below_ema200'
  | 'long_stack_not_up'
  | 'long_ema_slope_nonpositive'
  | 'long_adx_too_low'
  | 'long_no_pullback'
  | 'long_too_far_from_ema20'
  | 'short_above_ema200'
  | 'short_stack_not_down'
  | 'short_ema_slope_nonnegative'
  | 'short_adx_too_low'
  | 'short_no_pullback'
  | 'short_too_far_from_ema20'
  | 'atr_too_low'
  | 'atr_too_high'
  | 'extension_too_large'
  | 'risk_multiplier_zero'
  | 'initial_r_invalid'
  | 'risk_invalid'
  | 'min_score'
  | 'no_ranked_candidates';

type UniverseState = 'resonant' | 'transition' | 'chaotic' | 'unknown';
type UniverseSideBias = 'long' | 'short' | 'neutral';

export interface UniverseSignal {
  symbol: string;
  side: UniverseSignalSide;
  regime: string;
  state: UniverseState;
  sideBias: UniverseSideBias;
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
  indicators: Record<string, unknown> & {
    ready?: boolean;
    rejectReason?: UniverseRejectReason;
  };
}

export interface UniverseRankCandidate {
  symbol: string;
  score: number;
  rawScore: number;
  side: 'long' | 'short';
  regime: string;
  state: UniverseState;
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

function buildEmptySignal(
  symbol: string,
  price = 0,
  rejectReason: UniverseRejectReason = 'not_ready',
  extraIndicators: Record<string, unknown> = {},
  ready = false
): UniverseSignal {
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
    indicators: {
      ready,
      rejectReason,
      ...extraIndicators
    }
  };
}

function buildRejectedSignal(params: {
  symbol: string;
  price: number;
  rejectReason: UniverseRejectReason;
  regime: string;
  state: UniverseState;
  sideBias: UniverseSideBias;
  coherence: number;
  score?: number;
  rawScore?: number;
  extraIndicators?: Record<string, unknown>;
}): UniverseSignal {
  const {
    symbol,
    price,
    rejectReason,
    regime,
    state,
    sideBias,
    coherence,
    score = 0,
    rawScore = 0,
    extraIndicators = {}
  } = params;

  return {
    symbol,
    side: 'none',
    regime,
    state,
    sideBias,
    coherence: round(coherence, 6),
    score: round(score, 4),
    rawScore: round(rawScore, 4),
    price: round(price),
    stopLossPrice: null,
    takeProfit1Price: null,
    takeProfit2Price: null,
    takeProfitPrice: null,
    quantity: null,
    positionSize: null,
    tp1Fraction: TP1_FRACTION,
    initialR: null,
    riskMultiplier: 0,
    indicators: {
      ready: true,
      rejectReason,
      ...extraIndicators
    }
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

function pickFirstReason(
  failed: UniverseRejectReason[],
  priority: UniverseRejectReason[],
  fallback: UniverseRejectReason
): UniverseRejectReason {
  for (const reason of priority) {
    if (failed.includes(reason)) return reason;
  }
  return fallback;
}

function resolveLongRejectReason(params: {
  price: number;
  lastEma200: number;
  stackUp: boolean;
  emaSlope20: number;
  adx: number;
  pullbackLong: boolean;
  nearEma20: boolean;
  notTooDead: boolean;
  notTooWild: boolean;
  extension: number;
}): {
  rejectReason: UniverseRejectReason;
  failedConditions: UniverseRejectReason[];
} {
  const {
    price,
    lastEma200,
    stackUp,
    emaSlope20,
    adx,
    pullbackLong,
    nearEma20,
    notTooDead,
    notTooWild,
    extension
  } = params;

  const failed: UniverseRejectReason[] = [];

  if (!notTooDead) failed.push('atr_too_low');
  if (!notTooWild) failed.push('atr_too_high');
  if (price <= lastEma200) failed.push('long_below_ema200');
  if (!stackUp) failed.push('long_stack_not_up');
  if (emaSlope20 <= 0) failed.push('long_ema_slope_nonpositive');
  if (adx < 18) failed.push('long_adx_too_low');
  if (!pullbackLong) failed.push('long_no_pullback');
  if (!nearEma20) failed.push('long_too_far_from_ema20');
  if (extension > 0.018) failed.push('extension_too_large');

  return {
    rejectReason: pickFirstReason(
      failed,
      [
        'atr_too_low',
        'atr_too_high',
        'long_below_ema200',
        'long_stack_not_up',
        'long_ema_slope_nonpositive',
        'long_adx_too_low',
        'long_no_pullback',
        'long_too_far_from_ema20',
        'extension_too_large'
      ],
      'long_conditions_failed'
    ),
    failedConditions: failed.length ? failed : ['long_conditions_failed']
  };
}

function resolveShortRejectReason(params: {
  price: number;
  lastEma200: number;
  stackDown: boolean;
  emaSlope20: number;
  adx: number;
  pullbackShort: boolean;
  nearEma20: boolean;
  notTooDead: boolean;
  notTooWild: boolean;
  extension: number;
}): {
  rejectReason: UniverseRejectReason;
  failedConditions: UniverseRejectReason[];
} {
  const {
    price,
    lastEma200,
    stackDown,
    emaSlope20,
    adx,
    pullbackShort,
    nearEma20,
    notTooDead,
    notTooWild,
    extension
  } = params;

  const failed: UniverseRejectReason[] = [];

  if (!notTooDead) failed.push('atr_too_low');
  if (!notTooWild) failed.push('atr_too_high');
  if (price >= lastEma200) failed.push('short_above_ema200');
  if (!stackDown) failed.push('short_stack_not_down');
  if (emaSlope20 >= 0) failed.push('short_ema_slope_nonnegative');
  if (adx < 18) failed.push('short_adx_too_low');
  if (!pullbackShort) failed.push('short_no_pullback');
  if (!nearEma20) failed.push('short_too_far_from_ema20');
  if (extension > 0.018) failed.push('extension_too_large');

  return {
    rejectReason: pickFirstReason(
      failed,
      [
        'atr_too_low',
        'atr_too_high',
        'short_above_ema200',
        'short_stack_not_down',
        'short_ema_slope_nonnegative',
        'short_adx_too_low',
        'short_no_pullback',
        'short_too_far_from_ema20',
        'extension_too_large'
      ],
      'short_conditions_failed'
    ),
    failedConditions: failed.length ? failed : ['short_conditions_failed']
  };
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
  if (!Number.isFinite(price) || price <= 0) {
    return buildEmptySignal(symbol, price, 'price_invalid');
  }

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
    return buildEmptySignal(symbol, price, 'not_ready', {
      ema20Len: ema20.length,
      ema50Len: ema50.length,
      ema200Len: ema200.length,
      adxLen: adx.length,
      atrLen: atr.length
    });
  }

  const stateInfo = detectMarketState(candles);

  if (!stateInfo.ready) {
    return buildEmptySignal(symbol, price, 'state_not_ready');
  }

  if (stateInfo.state === 'chaotic') {
    return buildRejectedSignal({
      symbol,
      price,
      rejectReason: 'state_chaotic',
      regime: stateInfo.state,
      state: stateInfo.state,
      sideBias: stateInfo.sideBias,
      coherence: stateInfo.coherence ?? 0,
      extraIndicators: {
        requestedSide: side,
        state: stateInfo.state,
        sideBias: stateInfo.sideBias,
        coherence: round(stateInfo.coherence ?? 0, 6)
      }
    });
  }

  if (stateInfo.sideBias !== 'neutral' && stateInfo.sideBias !== side) {
    const rejectReason: UniverseRejectReason =
      side === 'long' ? 'long_side_bias_short' : 'short_side_bias_long';

    return buildRejectedSignal({
      symbol,
      price,
      rejectReason,
      regime: stateInfo.state,
      state: stateInfo.state,
      sideBias: stateInfo.sideBias,
      coherence: stateInfo.coherence ?? 0,
      extraIndicators: {
        requestedSide: side,
        sideBias: stateInfo.sideBias,
        state: stateInfo.state,
        coherence: round(stateInfo.coherence ?? 0, 6)
      }
    });
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

  const commonIndicators = {
    requestedSide: side,
    rs48: round(rs48, 6),
    rs16: round(rs16, 6),
    ema20: round(lastEma20),
    ema50: round(lastEma50),
    ema200: round(lastEma200),
    priceVsEma200: lastEma200 > 0 ? round(price / lastEma200, 6) : 0,
    emaSlope20: round(emaSlope20, 6),
    adx: round(lastAdx.adx, 4),
    adxRising,
    atr: round(lastAtr),
    atrPct: round(atrPct, 6),
    volBoost: round(volBoost, 4),
    extension: round(extension, 6),
    nearEma20,
    notTooDead,
    notTooWild,
    stackUp,
    stackDown,
    pullbackLong,
    pullbackShort,
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
  };

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

    if (!sideOk) {
      const { rejectReason, failedConditions } = resolveLongRejectReason({
        price,
        lastEma200,
        stackUp,
        emaSlope20,
        adx: lastAdx.adx,
        pullbackLong,
        nearEma20,
        notTooDead,
        notTooWild,
        extension
      });

      return buildRejectedSignal({
        symbol,
        price,
        rejectReason,
        regime: stateInfo.state,
        state: stateInfo.state,
        sideBias: stateInfo.sideBias,
        coherence: stateInfo.coherence,
        rawScore,
        extraIndicators: {
          ...commonIndicators,
          rawScore: round(rawScore, 4),
          failedConditions,
          primaryFailedCondition: rejectReason
        }
      });
    }
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

    if (!sideOk) {
      const { rejectReason, failedConditions } = resolveShortRejectReason({
        price,
        lastEma200,
        stackDown,
        emaSlope20,
        adx: lastAdx.adx,
        pullbackShort,
        nearEma20,
        notTooDead,
        notTooWild,
        extension
      });

      return buildRejectedSignal({
        symbol,
        price,
        rejectReason,
        regime: stateInfo.state,
        state: stateInfo.state,
        sideBias: stateInfo.sideBias,
        coherence: stateInfo.coherence,
        rawScore,
        extraIndicators: {
          ...commonIndicators,
          rawScore: round(rawScore, 4),
          failedConditions,
          primaryFailedCondition: rejectReason
        }
      });
    }
  }

  const scoreMultiplier = getStateScoreMultiplier(
    stateInfo.state,
    stateInfo.coherence
  );
  const riskMultiplier = getStateRiskMultiplier(
    stateInfo.state,
    stateInfo.coherence
  );

  if (riskMultiplier <= 0 || scoreMultiplier <= 0) {
    return buildRejectedSignal({
      symbol,
      price,
      rejectReason: 'risk_multiplier_zero',
      regime: stateInfo.state,
      state: stateInfo.state,
      sideBias: stateInfo.sideBias,
      coherence: stateInfo.coherence,
      rawScore,
      extraIndicators: {
        ...commonIndicators,
        rawScore: round(rawScore, 4),
        scoreMultiplier: round(scoreMultiplier, 6),
        riskMultiplier: round(riskMultiplier, 6)
      }
    });
  }

  const adjustedRaw = rawScore + stateInfo.coherence * 1.25;
  const score = adjustedRaw * scoreMultiplier;

  const stopDistance = Math.max(lastAtr * 1.35, price * 0.0045);
  const stopLossPrice =
    side === 'long' ? price - stopDistance : price + stopDistance;
  const initialR = Math.abs(price - stopLossPrice);

  if (!Number.isFinite(initialR) || initialR <= 0) {
    return buildRejectedSignal({
      symbol,
      price,
      rejectReason: 'initial_r_invalid',
      regime: stateInfo.state,
      state: stateInfo.state,
      sideBias: stateInfo.sideBias,
      coherence: stateInfo.coherence,
      score,
      rawScore: adjustedRaw,
      extraIndicators: {
        ...commonIndicators,
        scoreMultiplier: round(scoreMultiplier, 6),
        riskMultiplier: round(riskMultiplier, 6),
        adjustedRaw: round(adjustedRaw, 4),
        stopDistance: round(stopDistance, 8),
        stopLossPrice: round(stopLossPrice, 8),
        initialR
      }
    });
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
      rejectReason: undefined,
      ...commonIndicators,
      scoreMultiplier: round(scoreMultiplier, 6),
      riskMultiplier: round(riskMultiplier, 6),
      rawScore: round(adjustedRaw, 4)
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
    return buildRejectedSignal({
      symbol: signal.symbol,
      price: signal.price,
      rejectReason: 'risk_invalid',
      regime: signal.regime,
      state: signal.state,
      sideBias: signal.sideBias,
      coherence: signal.coherence,
      score: signal.score,
      rawScore: signal.rawScore,
      extraIndicators: {
        ...signal.indicators,
        side: signal.side,
        riskPerTrade,
        riskMultiplier: signal.riskMultiplier,
        effectiveRisk
      }
    });
  }

  const riskCapital = balance * effectiveRisk;
  let quantity = Math.floor(riskCapital / signal.initialR);

  if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;

  const positionSize = quantity * signal.price;

  return {
    ...signal,
    quantity,
    positionSize: round(positionSize, 6),
    indicators: {
      ...signal.indicators,
      riskPerTrade: round(riskPerTrade, 6),
      effectiveRisk: round(effectiveRisk, 6),
      riskCapital: round(riskCapital, 6),
      quantity,
      positionSize: round(positionSize, 6)
    }
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

  if (!best) {
    const fallbackSymbol = Object.keys(candlesBySymbol)[0] ?? 'UNKNOWN';
    const fallbackCandles = candlesBySymbol[fallbackSymbol] ?? [];
    const fallbackPrice =
      fallbackCandles.length > 0
        ? fallbackCandles[fallbackCandles.length - 1].close
        : 0;

    return buildEmptySignal(fallbackSymbol, fallbackPrice, 'no_ranked_candidates', {
      minScore
    });
  }

  if (best.score < minScore) {
    return {
      ...buildRejectedSignal({
        symbol: best.symbol,
        price: best.signal.price,
        rejectReason: 'min_score',
        regime: best.signal.regime,
        state: best.signal.state,
        sideBias: best.signal.sideBias,
        coherence: best.signal.coherence,
        score: best.signal.score,
        rawScore: best.signal.rawScore,
        extraIndicators: {
          minScore,
          bestScore: best.score,
          bestRawScore: best.rawScore,
          bestSide: best.side,
          bestState: best.state,
          bestCoherence: best.coherence
        }
      }),
      symbol: best.symbol,
      regime: best.signal.regime,
      state: best.signal.state,
      sideBias: best.signal.sideBias,
      coherence: best.signal.coherence,
      score: best.signal.score,
      rawScore: best.signal.rawScore,
      price: best.signal.price
    };
  }

  return best.signal;
}
