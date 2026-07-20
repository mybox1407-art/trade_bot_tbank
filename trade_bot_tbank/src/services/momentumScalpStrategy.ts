import { ATR, EMA, SMA } from 'technicalindicators';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ScalpSide = 'long' | 'short';

export type EntryRejectReason =
  | 'outside_session'
  | 'not_enough_history'
  | 'missing_context'
  | 'trend_not_aligned'
  | 'atr_not_expanding'
  | 'volume_too_small'
  | 'pullback_too_small'
  | 'breakout_missing'
  | 'impulse_too_small'
  | 'target_too_small_for_costs'
  | 'too_far_from_vwap'
  | 'no_signal';

export interface ScalpParams {
  riskPerTrade: number;
  maxRiskPerTrade: number;
  commissionRate: number;
  slippageRate: number;

  atrPeriod1m: number;
  atrPeriod5m: number;
  emaFastPeriod5m: number;
  emaSlowPeriod5m: number;
  vwapPeriod1m: number;
  volumeLookback1m: number;

  trendAtrLookback5m: number;
  trendAtrExpandRatio5m: number;

  pullbackLookback1m: number;
  breakoutBufferPct: number;
  minPullbackPct: number;
  minImpulseBodyPct: number;
  volumeMinRatio1m: number;

  atrSlMult: number;
  atrTpMult: number;
  timeStopBars: number;
  cooldownBars: number;

  minTargetMovePct: number;
  minCostCoverage: number;
  maxEntryDistanceFromVwapPct: number;
  maxPositionNotionalPct: number;

  sessionStartHour: number;
  sessionEndHour: number;
}

export interface ScalpSignal {
  side: ScalpSide;
  signalIndex: number;
  entryIndex: number;
  signalTime: number;
  entryTime: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  riskDistance: number;
  atr1m: number;
  atr5m: number;
  vwap1m: number;
  impulseBodyPct: number;
  pullbackPct: number;
  volumeRatio: number;
}

export interface EntryDecision {
  accepted: boolean;
  reason?: EntryRejectReason;
  signal?: ScalpSignal;
}

export interface BarIndicators1m {
  atr1m: number | null;
  vwap1m: number | null;
  volumeSma1m: number | null;
}

export interface BarIndicators5m {
  atr5m: number | null;
  atr5mSma: number | null;
  emaFast5m: number | null;
  emaSlow5m: number | null;
  close5m: number | null;
}

export const DEFAULT_SCALP_PARAMS: ScalpParams = {
  riskPerTrade: 0.005,
  maxRiskPerTrade: 0.005,
  commissionRate: 0.0002,
  slippageRate: 0.00015,

  atrPeriod1m: 14,
  atrPeriod5m: 14,
  emaFastPeriod5m: 9,
  emaSlowPeriod5m: 20,
  vwapPeriod1m: 60,
  volumeLookback1m: 60,

  trendAtrLookback5m: 20,
  trendAtrExpandRatio5m: 1.1,

  pullbackLookback1m: 6,
  breakoutBufferPct: 0.00015,
  minPullbackPct: 0.0006,
  minImpulseBodyPct: 0.0008,
  volumeMinRatio1m: 1.1,

  atrSlMult: 1.15,
  atrTpMult: 2.0,
  timeStopBars: 16,
  cooldownBars: 4,

  minTargetMovePct: 0.0020,
  minCostCoverage: 2.0,
  maxEntryDistanceFromVwapPct: 0.006,
  maxPositionNotionalPct: 0.2,

  sessionStartHour: 10,
  sessionEndHour: 18.75
};

function padSeries(values: number[], totalLength: number): Array<number | null> {
  const missing = totalLength - values.length;
  const result: Array<number | null> = [];

  for (let i = 0; i < missing; i++) result.push(null);
  for (const v of values) result.push(v);

  return result;
}

function mergeBucket(bucket: Candle[], bucketStart: number): Candle {
  const open = bucket[0].open;
  const close = bucket[bucket.length - 1].close;
  let high = bucket[0].high;
  let low = bucket[0].low;
  let volume = 0;

  for (const c of bucket) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    volume += c.volume;
  }

  return {
    time: bucketStart,
    open,
    high,
    low,
    close,
    volume
  };
}

export function aggregateCandlesTo5m(candles: Candle[]): Candle[] {
  const result: Candle[] = [];
  if (candles.length === 0) return result;

  let bucket: Candle[] = [];
  let currentBucketStart: number | null = null;

  for (const candle of candles) {
    const bucketStart = Math.floor(candle.time / (5 * 60 * 1000)) * (5 * 60 * 1000);

    if (currentBucketStart === null || bucketStart !== currentBucketStart) {
      if (bucket.length > 0) {
        result.push(mergeBucket(bucket, currentBucketStart));
      }
      bucket = [candle];
      currentBucketStart = bucketStart;
    } else {
      bucket.push(candle);
    }
  }

  if (bucket.length > 0 && currentBucketStart !== null) {
    result.push(mergeBucket(bucket, currentBucketStart));
  }

  return result;
}

export function build1mIndicators(
  candles: Candle[],
  params: ScalpParams = DEFAULT_SCALP_PARAMS
): BarIndicators1m[] {
  const atrRaw = ATR.calculate({
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
    period: params.atrPeriod1m
  });

  const volumeSmaRaw = SMA.calculate({
    period: params.volumeLookback1m,
    values: candles.map(c => c.volume)
  });

  const atrSeries = padSeries(atrRaw, candles.length);
  const volumeSmaSeries = padSeries(volumeSmaRaw, candles.length);
  const indicators: BarIndicators1m[] = [];

  const typicalPrices = candles.map(c => (c.high + c.low + c.close) / 3);

  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - params.vwapPeriod1m + 1);
    let pv = 0;
    let vv = 0;

    for (let j = start; j <= i; j++) {
      pv += typicalPrices[j] * candles[j].volume;
      vv += candles[j].volume;
    }

    indicators.push({
      atr1m: atrSeries[i],
      vwap1m: vv > 0 ? pv / vv : null,
      volumeSma1m: volumeSmaSeries[i]
    });
  }

  return indicators;
}

export function build5mIndicators(
  candles5m: Candle[],
  params: ScalpParams = DEFAULT_SCALP_PARAMS
): BarIndicators5m[] {
  const closes = candles5m.map(c => c.close);

  const atrRaw = ATR.calculate({
    high: candles5m.map(c => c.high),
    low: candles5m.map(c => c.low),
    close: closes,
    period: params.atrPeriod5m
  });

  const atrSmaRaw = SMA.calculate({
    period: params.trendAtrLookback5m,
    values: atrRaw
  });

  const emaFastRaw = EMA.calculate({
    period: params.emaFastPeriod5m,
    values: closes
  });

  const emaSlowRaw = EMA.calculate({
    period: params.emaSlowPeriod5m,
    values: closes
  });

  const atrSeries = padSeries(atrRaw, candles5m.length);
  const emaFastSeries = padSeries(emaFastRaw, candles5m.length);
  const emaSlowSeries = padSeries(emaSlowRaw, candles5m.length);

  const atrSmaSeriesRaw = padSeries(atrSmaRaw, atrRaw.length);
  const atrSmaSeries: Array<number | null> = [];
  const atrMissing = candles5m.length - atrRaw.length;
  for (let i = 0; i < atrMissing; i++) atrSmaSeries.push(null);
  for (const v of atrSmaSeriesRaw) atrSmaSeries.push(v);

  const result: BarIndicators5m[] = [];

  for (let i = 0; i < candles5m.length; i++) {
    result.push({
      atr5m: atrSeries[i],
      atr5mSma: atrSmaSeries[i] ?? null,
      emaFast5m: emaFastSeries[i],
      emaSlow5m: emaSlowSeries[i],
      close5m: candles5m[i].close
    });
  }

  return result;
}

export function map1mIndexTo5mIndex(candleTime: number, candles5m: Candle[]): number {
  if (candles5m.length === 0) return -1;

  const bucketStart = Math.floor(candleTime / (5 * 60 * 1000)) * (5 * 60 * 1000);

  let left = 0;
  let right = candles5m.length - 1;
  let ans = -1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (candles5m[mid].time <= bucketStart) {
      ans = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return ans;
}

function getHourFraction(time: number): number {
  const d = new Date(time);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function inSession(time: number, params: ScalpParams): boolean {
  const hour = getHourFraction(time);
  return hour >= params.sessionStartHour && hour <= params.sessionEndHour;
}

function calcBodyPct(candle: Candle): number {
  if (candle.open === 0) return 0;
  return Math.abs(candle.close - candle.open) / candle.open;
}

function calcVolumeRatio(candle: Candle, ind1m: BarIndicators1m): number {
  if (!ind1m.volumeSma1m || ind1m.volumeSma1m <= 0) return 0;
  return candle.volume / ind1m.volumeSma1m;
}

function calcDistancePct(a: number, b: number): number {
  if (b === 0) return 0;
  return Math.abs(a - b) / b;
}

function highestHigh(candles: Candle[], from: number, to: number): number {
  let h = -Infinity;
  for (let i = from; i <= to; i++) {
    if (candles[i].high > h) h = candles[i].high;
  }
  return h;
}

function lowestLow(candles: Candle[], from: number, to: number): number {
  let l = Infinity;
  for (let i = from; i <= to; i++) {
    if (candles[i].low < l) l = candles[i].low;
  }
  return l;
}

function detectPullbackLong(candles: Candle[], index: number, lookback: number): number | null {
  const from = index - lookback;
  if (from < 1) return null;

  const recentHigh = highestHigh(candles, from, index - 1);
  const recentLow = lowestLow(candles, from, index - 1);

  if (recentHigh <= 0) return null;
  return (recentHigh - recentLow) / recentHigh;
}

function detectPullbackShort(candles: Candle[], index: number, lookback: number): number | null {
  const from = index - lookback;
  if (from < 1) return null;

  const recentHigh = highestHigh(candles, from, index - 1);
  const recentLow = lowestLow(candles, from, index - 1);

  if (recentLow <= 0) return null;
  return (recentHigh - recentLow) / recentLow;
}

export function floorToStep(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

export function evaluateMomentumScalpEntry(
  candles1m: Candle[],
  indicators1m: BarIndicators1m[],
  candles5m: Candle[],
  indicators5m: BarIndicators5m[],
  signalIndex: number,
  params: ScalpParams = DEFAULT_SCALP_PARAMS
): EntryDecision {
  if (signalIndex < 2 || signalIndex + 1 >= candles1m.length) {
    return { accepted: false, reason: 'not_enough_history' };
  }

  const signalCandle = candles1m[signalIndex];
  const entryCandle = candles1m[signalIndex + 1];
  const ind1m = indicators1m[signalIndex];

  if (!inSession(signalCandle.time, params)) {
    return { accepted: false, reason: 'outside_session' };
  }

  if (!ind1m.atr1m || !ind1m.vwap1m || !ind1m.volumeSma1m) {
    return { accepted: false, reason: 'missing_context' };
  }

  const idx5m = map1mIndexTo5mIndex(signalCandle.time, candles5m);
  if (idx5m < 1 || idx5m >= indicators5m.length) {
    return { accepted: false, reason: 'missing_context' };
  }

  const ctx5m = indicators5m[idx5m];
  if (
    !ctx5m.atr5m ||
    !ctx5m.atr5mSma ||
    !ctx5m.emaFast5m ||
    !ctx5m.emaSlow5m ||
    !ctx5m.close5m
  ) {
    return { accepted: false, reason: 'missing_context' };
  }

  if (ctx5m.atr5m < ctx5m.atr5mSma * params.trendAtrExpandRatio5m) {
    return { accepted: false, reason: 'atr_not_expanding' };
  }

  const volumeRatio = calcVolumeRatio(signalCandle, ind1m);
  if (volumeRatio < params.volumeMinRatio1m) {
    return { accepted: false, reason: 'volume_too_small' };
  }

  const bodyPct = calcBodyPct(signalCandle);
  if (bodyPct < params.minImpulseBodyPct) {
    return { accepted: false, reason: 'impulse_too_small' };
  }

  const vwapDistancePct = calcDistancePct(signalCandle.close, ind1m.vwap1m);
  if (vwapDistancePct > params.maxEntryDistanceFromVwapPct) {
    return { accepted: false, reason: 'too_far_from_vwap' };
  }

  const is5mLongTrend = ctx5m.emaFast5m > ctx5m.emaSlow5m && ctx5m.close5m > ctx5m.emaFast5m;
  const is5mShortTrend = ctx5m.emaFast5m < ctx5m.emaSlow5m && ctx5m.close5m < ctx5m.emaFast5m;

  const recentHigh = highestHigh(
    candles1m,
    Math.max(0, signalIndex - params.pullbackLookback1m),
    signalIndex - 1
  );
  const recentLow = lowestLow(
    candles1m,
    Math.max(0, signalIndex - params.pullbackLookback1m),
    signalIndex - 1
  );

  const longPullbackPct = detectPullbackLong(candles1m, signalIndex, params.pullbackLookback1m);
  const shortPullbackPct = detectPullbackShort(candles1m, signalIndex, params.pullbackLookback1m);

  const longBreakoutLevel = recentHigh * (1 + params.breakoutBufferPct);
  const shortBreakoutLevel = recentLow * (1 - params.breakoutBufferPct);

  const longBreakout = entryCandle.high >= longBreakoutLevel;
  const shortBreakout = entryCandle.low <= shortBreakoutLevel;

  if (!is5mLongTrend && !is5mShortTrend) {
    return { accepted: false, reason: 'trend_not_aligned' };
  }

  if (is5mLongTrend && !is5mShortTrend) {
    if (longPullbackPct === null || longPullbackPct < params.minPullbackPct) {
      return { accepted: false, reason: 'pullback_too_small' };
    }
    if (!longBreakout) {
      return { accepted: false, reason: 'breakout_missing' };
    }

    const entryPrice = Math.max(entryCandle.open, longBreakoutLevel) * (1 + params.slippageRate);
    const stopDistance = ind1m.atr1m * params.atrSlMult;
    const stopLossPrice = entryPrice - stopDistance;
    const takeProfitPrice = entryPrice + ind1m.atr1m * params.atrTpMult;
    const targetMovePct = (takeProfitPrice - entryPrice) / entryPrice;
    const costPct = (params.commissionRate * 2) + (params.slippageRate * 2);

    if (targetMovePct < params.minTargetMovePct || targetMovePct < costPct * params.minCostCoverage) {
      return { accepted: false, reason: 'target_too_small_for_costs' };
    }

    return {
      accepted: true,
      signal: {
        side: 'long',
        signalIndex,
        entryIndex: signalIndex + 1,
        signalTime: signalCandle.time,
        entryTime: entryCandle.time,
        entryPrice,
        stopLossPrice,
        takeProfitPrice,
        riskDistance: stopDistance,
        atr1m: ind1m.atr1m,
        atr5m: ctx5m.atr5m,
        vwap1m: ind1m.vwap1m,
        impulseBodyPct: bodyPct,
        pullbackPct: longPullbackPct,
        volumeRatio
      }
    };
  }

  if (is5mShortTrend && !is5mLongTrend) {
    if (shortPullbackPct === null || shortPullbackPct < params.minPullbackPct) {
      return { accepted: false, reason: 'pullback_too_small' };
    }
    if (!shortBreakout) {
      return { accepted: false, reason: 'breakout_missing' };
    }

    const entryPrice = Math.min(entryCandle.open, shortBreakoutLevel) * (1 - params.slippageRate);
    const stopDistance = ind1m.atr1m * params.atrSlMult;
    const stopLossPrice = entryPrice + stopDistance;
    const takeProfitPrice = entryPrice - ind1m.atr1m * params.atrTpMult;
    const targetMovePct = (entryPrice - takeProfitPrice) / entryPrice;
    const costPct = (params.commissionRate * 2) + (params.slippageRate * 2);

    if (targetMovePct < params.minTargetMovePct || targetMovePct < costPct * params.minCostCoverage) {
      return { accepted: false, reason: 'target_too_small_for_costs' };
    }

    return {
      accepted: true,
      signal: {
        side: 'short',
        signalIndex,
        entryIndex: signalIndex + 1,
        signalTime: signalCandle.time,
        entryTime: entryCandle.time,
        entryPrice,
        stopLossPrice,
        takeProfitPrice,
        riskDistance: stopDistance,
        atr1m: ind1m.atr1m,
        atr5m: ctx5m.atr5m,
        vwap1m: ind1m.vwap1m,
        impulseBodyPct: bodyPct,
        pullbackPct: shortPullbackPct,
        volumeRatio
      }
    };
  }

  return { accepted: false, reason: 'no_signal' };
}
