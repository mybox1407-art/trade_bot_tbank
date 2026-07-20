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
  | 'ema_not_ready'
  | 'vwap_not_ready'
  | 'atr_not_ready'
  | 'volume_not_ready'
  | 'trend_not_aligned'
  | 'atr_too_small'
  | 'volume_too_small'
  | 'impulse_too_small'
  | 'target_too_small_for_costs'
  | 'too_far_from_vwap'
  | 'no_signal';

export interface ScalpParams {
  riskPerTrade: number;
  maxRiskPerTrade: number;
  commissionRate: number;
  slippageRate: number;

  atrPeriod: number;
  atrSlMult: number;
  atrTpMult: number;

  emaFastPeriod: number;
  emaSlowPeriod: number;
  vwapPeriod: number;
  volumeLookback: number;

  volumeMinRatio: number;
  minAtrPct: number;
  minImpulsePct: number;
  minTargetMovePct: number;
  minCostCoverage: number;
  maxPositionNotionalPct: number;
  maxEntryDistanceFromVwapPct: number;

  timeStopBars: number;
  sessionStartHour: number;
  sessionEndHour: number;
  afternoonStartHour: number;
  afternoonEndHour: number;
  cooldownBars: number;
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
  atr: number;
  emaFast: number;
  emaSlow: number;
  vwap: number;
  volumeRatio: number;
  impulsePct: number;
}

export interface EntryDecision {
  accepted: boolean;
  reason?: EntryRejectReason;
  signal?: ScalpSignal;
}

export interface ScalpBarIndicators {
  atr: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  vwap: number | null;
  volumeSma: number | null;
}

export const DEFAULT_SCALP_PARAMS: ScalpParams = {
  riskPerTrade: 0.005,
  maxRiskPerTrade: 0.005,
  commissionRate: 0.0002,
  slippageRate: 0.00015,

  atrPeriod: 14,
  atrSlMult: 1.2,
  atrTpMult: 2.2,

  emaFastPeriod: 9,
  emaSlowPeriod: 20,
  vwapPeriod: 60,
  volumeLookback: 60,

  volumeMinRatio: 1.1,
  minAtrPct: 0.0008,
  minImpulsePct: 0.0006,
  minTargetMovePct: 0.0022,
  minCostCoverage: 2.0,
  maxPositionNotionalPct: 0.2,
  maxEntryDistanceFromVwapPct: 0.01,

  timeStopBars: 12,
  sessionStartHour: 10,
  sessionEndHour: 18.75,
  afternoonStartHour: 10,
  afternoonEndHour: 18.75,
  cooldownBars: 4
};

function padSeries(values: number[], totalLength: number): Array<number | null> {
  const missing = totalLength - values.length;
  const result: Array<number | null> = [];

  for (let i = 0; i < missing; i++) {
    result.push(null);
  }

  for (const value of values) {
    result.push(value);
  }

  return result;
}

function typicalPrice(candle: Candle): number {
  return (candle.high + candle.low + candle.close) / 3;
}

function getHourFractionUtc(time: number): number {
  const d = new Date(time);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function isInSession(time: number, params: ScalpParams): boolean {
  const h = getHourFractionUtc(time);
  return h >= params.sessionStartHour && h <= params.sessionEndHour;
}

function calcImpulsePct(candle: Candle): number {
  if (candle.open === 0) return 0;
  return Math.abs(candle.close - candle.open) / candle.open;
}

function calcDistancePct(a: number, b: number): number {
  if (b === 0) return 0;
  return Math.abs(a - b) / b;
}

export function floorToStep(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

export function buildScalpIndicators(
  candles: Candle[],
  params: ScalpParams = DEFAULT_SCALP_PARAMS
): ScalpBarIndicators[] {
  const closes = candles.map(c => c.close);

  const atrRaw = ATR.calculate({
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: closes,
    period: params.atrPeriod
  });

  const emaFastRaw = EMA.calculate({
    values: closes,
    period: params.emaFastPeriod
  });

  const emaSlowRaw = EMA.calculate({
    values: closes,
    period: params.emaSlowPeriod
  });

  const volumeSmaRaw = SMA.calculate({
    values: candles.map(c => c.volume),
    period: params.volumeLookback
  });

  const atrSeries = padSeries(atrRaw, candles.length);
  const emaFastSeries = padSeries(emaFastRaw, candles.length);
  const emaSlowSeries = padSeries(emaSlowRaw, candles.length);
  const volumeSmaSeries = padSeries(volumeSmaRaw, candles.length);

  const result: ScalpBarIndicators[] = [];

  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - params.vwapPeriod + 1);
    let pv = 0;
    let vv = 0;

    for (let j = start; j <= i; j++) {
      const tp = typicalPrice(candles[j]);
      pv += tp * candles[j].volume;
      vv += candles[j].volume;
    }

    const vwap = vv > 0 ? pv / vv : null;

    result.push({
      atr: atrSeries[i],
      emaFast: emaFastSeries[i],
      emaSlow: emaSlowSeries[i],
      vwap,
      volumeSma: volumeSmaSeries[i]
    });
  }

  return result;
}

function getVolumeRatio(candle: Candle, volumeSma: number | null): number | null {
  if (volumeSma == null || volumeSma <= 0) return null;
  return candle.volume / volumeSma;
}

function isLongTrend(emaFast: number, emaSlow: number, close: number, vwap: number): boolean {
  return emaFast > emaSlow && close > emaFast && close > vwap;
}

function isShortTrend(emaFast: number, emaSlow: number, close: number, vwap: number): boolean {
  return emaFast < emaSlow && close < emaFast && close < vwap;
}

export function evaluateMomentumScalpEntry(
  candles: Candle[],
  indicators: ScalpBarIndicators[],
  signalIndex: number,
  params: ScalpParams = DEFAULT_SCALP_PARAMS
): EntryDecision {
  if (signalIndex < 1 || signalIndex + 1 >= candles.length) {
    return { accepted: false, reason: 'not_enough_history' };
  }

  const signalCandle = candles[signalIndex];
  const entryCandle = candles[signalIndex + 1];
  const ind = indicators[signalIndex];

  if (!isInSession(signalCandle.time, params)) {
    return { accepted: false, reason: 'outside_session' };
  }

  if (ind.emaFast == null || ind.emaSlow == null) {
    return { accepted: false, reason: 'ema_not_ready' };
  }

  if (ind.vwap == null) {
    return { accepted: false, reason: 'vwap_not_ready' };
  }

  if (ind.atr == null) {
    return { accepted: false, reason: 'atr_not_ready' };
  }

  if (ind.volumeSma == null) {
    return { accepted: false, reason: 'volume_not_ready' };
  }

  const atrPct = signalCandle.close !== 0 ? ind.atr / signalCandle.close : 0;
  if (atrPct < params.minAtrPct) {
    return { accepted: false, reason: 'atr_too_small' };
  }

  const volumeRatio = getVolumeRatio(signalCandle, ind.volumeSma);
  if (volumeRatio == null) {
    return { accepted: false, reason: 'volume_not_ready' };
  }

  if (volumeRatio < params.volumeMinRatio) {
    return { accepted: false, reason: 'volume_too_small' };
  }

  const impulsePct = calcImpulsePct(signalCandle);
  if (impulsePct < params.minImpulsePct) {
    return { accepted: false, reason: 'impulse_too_small' };
  }

  const distanceFromVwapPct = calcDistancePct(signalCandle.close, ind.vwap);
  if (distanceFromVwapPct > params.maxEntryDistanceFromVwapPct) {
    return { accepted: false, reason: 'too_far_from_vwap' };
  }

  const longTrend = isLongTrend(ind.emaFast, ind.emaSlow, signalCandle.close, ind.vwap);
  const shortTrend = isShortTrend(ind.emaFast, ind.emaSlow, signalCandle.close, ind.vwap);

  if (!longTrend && !shortTrend) {
    return { accepted: false, reason: 'trend_not_aligned' };
  }

  const prevHigh = candles[signalIndex - 1].high;
  const prevLow = candles[signalIndex - 1].low;

  const longBreakout = signalCandle.high > prevHigh && signalCandle.close > signalCandle.open;
  const shortBreakout = signalCandle.low < prevLow && signalCandle.close < signalCandle.open;

  if (longTrend && longBreakout) {
    const rawEntryPrice = Math.max(entryCandle.open, signalCandle.high);
    const entryPrice = rawEntryPrice * (1 + params.slippageRate);
    const stopLossPrice = entryPrice - ind.atr * params.atrSlMult;
    const takeProfitPrice = entryPrice + ind.atr * params.atrTpMult;
    const targetMovePct = entryPrice !== 0 ? (takeProfitPrice - entryPrice) / entryPrice : 0;
    const costPct = (params.commissionRate * 2) + (params.slippageRate * 2);

    if (
      targetMovePct < params.minTargetMovePct ||
      targetMovePct < costPct * params.minCostCoverage
    ) {
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
        riskDistance: entryPrice - stopLossPrice,
        atr: ind.atr,
        emaFast: ind.emaFast,
        emaSlow: ind.emaSlow,
        vwap: ind.vwap,
        volumeRatio,
        impulsePct
      }
    };
  }

  if (shortTrend && shortBreakout) {
    const rawEntryPrice = Math.min(entryCandle.open, signalCandle.low);
    const entryPrice = rawEntryPrice * (1 - params.slippageRate);
    const stopLossPrice = entryPrice + ind.atr * params.atrSlMult;
    const takeProfitPrice = entryPrice - ind.atr * params.atrTpMult;
    const targetMovePct = entryPrice !== 0 ? (entryPrice - takeProfitPrice) / entryPrice : 0;
    const costPct = (params.commissionRate * 2) + (params.slippageRate * 2);

    if (
      targetMovePct < params.minTargetMovePct ||
      targetMovePct < costPct * params.minCostCoverage
    ) {
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
        riskDistance: stopLossPrice - entryPrice,
        atr: ind.atr,
        emaFast: ind.emaFast,
        emaSlow: ind.emaSlow,
        vwap: ind.vwap,
        volumeRatio,
        impulsePct
      }
    };
  }

  return { accepted: false, reason: 'no_signal' };
}
