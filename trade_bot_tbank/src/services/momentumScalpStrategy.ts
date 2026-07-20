import { ATR, EMA } from 'technicalindicators';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ScalpSide = 'long' | 'short' | 'none';

export interface ScalpSignal {
  side: ScalpSide;
  timestamp: number;
  signalPrice: number;
  atr: number;
  emaFast: number;
  emaSlow: number;
  vwap: number;
  volumeRatio: number;
  atrPct: number;
  impulsePct: number;
  expectedTargetMovePct: number;
  estimatedRoundTripCostPct: number;
  reason?: string;
}

export interface ScalpPosition {
  side: 'long' | 'short';
  entryPrice: number;
  entryIndex: number;
  entryTime: number;
  size: number;
  stopLoss: number;
  takeProfit: number;
  timeStopBars: number;
  signalTime: number;
  atrAtEntry: number;
}

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
  volumeMinRatio: 1.2,
  minAtrPct: 0.0007,
  minImpulsePct: 0.0005,
  minTargetMovePct: 0.0022,
  minCostCoverage: 2.0,
  maxPositionNotionalPct: 0.20,
  maxEntryDistanceFromVwapPct: 0.010,
  timeStopBars: 12,
  sessionStartHour: 10,
  sessionEndHour: 12.5,
  afternoonStartHour: 14,
  afternoonEndHour: 17.5,
  cooldownBars: 4
};

function round(value: number, digits: number = 6): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toMskHour(timestamp: number): number {
  const d = new Date(timestamp);
  const hour = (d.getUTCHours() + 3) % 24;
  return hour + d.getUTCMinutes() / 60;
}

function isInSession(timestamp: number, params: ScalpParams): boolean {
  const h = toMskHour(timestamp);

  const inMorning = h >= params.sessionStartHour && h <= params.sessionEndHour;
  const inAfternoon = h >= params.afternoonStartHour && h <= params.afternoonEndHour;

  return inMorning || inAfternoon;
}

function calcVWAP(candles: Candle[], period: number, endIndex: number): number {
  const start = Math.max(0, endIndex - period + 1);

  let priceVolumeSum = 0;
  let volumeSum = 0;

  for (let i = start; i <= endIndex; i++) {
    const typicalPrice = (candles[i].high + candles[i].low + candles[i].close) / 3;
    priceVolumeSum += typicalPrice * candles[i].volume;
    volumeSum += candles[i].volume;
  }

  if (volumeSum <= 0) {
    return candles[endIndex].close;
  }

  return priceVolumeSum / volumeSum;
}

function calcAverageVolume(candles: Candle[], period: number, endIndex: number): number {
  const start = Math.max(0, endIndex - period + 1);
  let sum = 0;

  for (let i = start; i <= endIndex; i++) {
    sum += candles[i].volume;
  }

  const count = endIndex - start + 1;
  return count > 0 ? sum / count : 0;
}

function calcIndicatorsAtIndex(
  candles: Candle[],
  currentIndex: number,
  params: ScalpParams
): {
  atr: number;
  emaFast: number;
  emaSlow: number;
  vwap: number;
  volumeRatio: number;
  atrPct: number;
  impulsePct: number;
} {
  const closes = candles.slice(0, currentIndex + 1).map((c: Candle) => c.close);
  const highs = candles.slice(0, currentIndex + 1).map((c: Candle) => c.high);
  const lows = candles.slice(0, currentIndex + 1).map((c: Candle) => c.low);

  const emaFastArr = EMA.calculate({
    period: params.emaFastPeriod,
    values: closes
  });

  const emaSlowArr = EMA.calculate({
    period: params.emaSlowPeriod,
    values: closes
  });

  const atrArr = ATR.calculate({
    period: params.atrPeriod,
    high: highs,
    low: lows,
    close: closes
  });

  const candle = candles[currentIndex];
  const prevCandle = candles[currentIndex - 1];

  const emaFast = emaFastArr[emaFastArr.length - 1];
  const emaSlow = emaSlowArr[emaSlowArr.length - 1];
  const atr = atrArr[atrArr.length - 1];
  const vwap = calcVWAP(candles, params.vwapPeriod, currentIndex);
  const avgVolume = calcAverageVolume(candles, params.volumeLookback, currentIndex - 1);
  const volumeRatio = avgVolume > 0 ? candle.volume / avgVolume : 0;
  const atrPct = candle.close > 0 ? atr / candle.close : 0;
  const impulsePct = prevCandle.close > 0
    ? Math.abs(candle.close - prevCandle.close) / prevCandle.close
    : 0;

  return {
    atr,
    emaFast,
    emaSlow,
    vwap,
    volumeRatio,
    atrPct,
    impulsePct
  };
}

export function analyzeMomentumScalp(
  candles: Candle[],
  currentIndex: number,
  params: ScalpParams = DEFAULT_SCALP_PARAMS
): ScalpSignal {
  const candle = candles[currentIndex];

  if (!candle) {
    return {
      side: 'none',
      timestamp: 0,
      signalPrice: 0,
      atr: 0,
      emaFast: 0,
      emaSlow: 0,
      vwap: 0,
      volumeRatio: 0,
      atrPct: 0,
      impulsePct: 0,
      expectedTargetMovePct: 0,
      estimatedRoundTripCostPct: 0,
      reason: 'missing_candle'
    };
  }

  const minHistory = Math.max(
    params.emaSlowPeriod,
    params.atrPeriod,
    params.vwapPeriod,
    params.volumeLookback
  ) + 2;

  if (currentIndex < minHistory) {
    return {
      side: 'none',
      timestamp: candle.time,
      signalPrice: candle.close,
      atr: 0,
      emaFast: 0,
      emaSlow: 0,
      vwap: 0,
      volumeRatio: 0,
      atrPct: 0,
      impulsePct: 0,
      expectedTargetMovePct: 0,
      estimatedRoundTripCostPct: 0,
      reason: 'not_enough_history'
    };
  }

  if (currentIndex >= candles.length - 1) {
    return {
      side: 'none',
      timestamp: candle.time,
      signalPrice: candle.close,
      atr: 0,
      emaFast: 0,
      emaSlow: 0,
      vwap: 0,
      volumeRatio: 0,
      atrPct: 0,
      impulsePct: 0,
      expectedTargetMovePct: 0,
      estimatedRoundTripCostPct: 0,
      reason: 'no_next_candle_for_entry'
    };
  }

  if (!isInSession(candle.time, params)) {
    return {
      side: 'none',
      timestamp: candle.time,
      signalPrice: candle.close,
      atr: 0,
      emaFast: 0,
      emaSlow: 0,
      vwap: 0,
      volumeRatio: 0,
      atrPct: 0,
      impulsePct: 0,
      expectedTargetMovePct: 0,
      estimatedRoundTripCostPct: 0,
      reason: 'outside_session'
    };
  }

  const prevCandle = candles[currentIndex - 1];
  const {
    atr,
    emaFast,
    emaSlow,
    vwap,
    volumeRatio,
    atrPct,
    impulsePct
  } = calcIndicatorsAtIndex(candles, currentIndex, params);

  if (
    !Number.isFinite(atr) ||
    !Number.isFinite(emaFast) ||
    !Number.isFinite(emaSlow) ||
    !Number.isFinite(vwap)
  ) {
    return {
      side: 'none',
      timestamp: candle.time,
      signalPrice: candle.close,
      atr: 0,
      emaFast: 0,
      emaSlow: 0,
      vwap: 0,
      volumeRatio: 0,
      atrPct: 0,
      impulsePct: 0,
      expectedTargetMovePct: 0,
      estimatedRoundTripCostPct: 0,
      reason: 'invalid_indicators'
    };
  }

  if (atrPct < params.minAtrPct) {
    return {
      side: 'none',
      timestamp: candle.time,
      signalPrice: candle.close,
      atr,
      emaFast,
      emaSlow,
      vwap,
      volumeRatio,
      atrPct,
      impulsePct,
      expectedTargetMovePct: 0,
      estimatedRoundTripCostPct: 0,
      reason: 'atr_too_small'
    };
  }

  if (volumeRatio < params.volumeMinRatio) {
    return {
      side: 'none',
      timestamp: candle.time,
      signalPrice: candle.close,
      atr,
      emaFast,
      emaSlow,
      vwap,
      volumeRatio,
      atrPct,
      impulsePct,
      expectedTargetMovePct: 0,
      estimatedRoundTripCostPct: 0,
      reason: 'volume_too_small'
    };
  }

  if (impulsePct < params.minImpulsePct) {
    return {
      side: 'none',
      timestamp: candle.time,
      signalPrice: candle.close,
      atr,
      emaFast,
      emaSlow,
      vwap,
      volumeRatio,
      atrPct,
      impulsePct,
      expectedTargetMovePct: 0,
      estimatedRoundTripCostPct: 0,
      reason: 'impulse_too_small'
    };
  }

  const expectedTargetMovePct = candle.close > 0
    ? (atr * params.atrTpMult) / candle.close
    : 0;

  const estimatedRoundTripCostPct =
    (params.commissionRate + params.slippageRate) * 2;

  const minRequiredMovePct = Math.max(
    params.minTargetMovePct,
    estimatedRoundTripCostPct * params.minCostCoverage
  );

  if (expectedTargetMovePct < minRequiredMovePct) {
    return {
      side: 'none',
      timestamp: candle.time,
      signalPrice: candle.close,
      atr,
      emaFast,
      emaSlow,
      vwap,
      volumeRatio,
      atrPct,
      impulsePct,
      expectedTargetMovePct,
      estimatedRoundTripCostPct,
      reason: 'target_too_small_for_costs'
    };
  }

  const distanceFromVwapPct = candle.close > 0
    ? Math.abs(candle.close - vwap) / candle.close
    : 0;

  if (distanceFromVwapPct > params.maxEntryDistanceFromVwapPct) {
    return {
      side: 'none',
      timestamp: candle.time,
      signalPrice: candle.close,
      atr,
      emaFast,
      emaSlow,
      vwap,
      volumeRatio,
      atrPct,
      impulsePct,
      expectedTargetMovePct,
      estimatedRoundTripCostPct,
      reason: 'too_far_from_vwap'
    };
  }

  const bullishBreakout =
    candle.close > vwap &&
    emaFast > emaSlow &&
    candle.close > prevCandle.high &&
    candle.close > candle.open;

  if (bullishBreakout) {
    return {
      side: 'long',
      timestamp: candle.time,
      signalPrice: candle.close,
      atr: round(atr),
      emaFast: round(emaFast),
      emaSlow: round(emaSlow),
      vwap: round(vwap),
      volumeRatio: round(volumeRatio),
      atrPct: round(atrPct),
      impulsePct: round(impulsePct),
      expectedTargetMovePct: round(expectedTargetMovePct),
      estimatedRoundTripCostPct: round(estimatedRoundTripCostPct)
    };
  }

  const bearishBreakout =
    candle.close < vwap &&
    emaFast < emaSlow &&
    candle.close < prevCandle.low &&
    candle.close < candle.open;

  if (bearishBreakout) {
    return {
      side: 'short',
      timestamp: candle.time,
      signalPrice: candle.close,
      atr: round(atr),
      emaFast: round(emaFast),
      emaSlow: round(emaSlow),
      vwap: round(vwap),
      volumeRatio: round(volumeRatio),
      atrPct: round(atrPct),
      impulsePct: round(impulsePct),
      expectedTargetMovePct: round(expectedTargetMovePct),
      estimatedRoundTripCostPct: round(estimatedRoundTripCostPct)
    };
  }

  return {
    side: 'none',
    timestamp: candle.time,
    signalPrice: candle.close,
    atr: round(atr),
    emaFast: round(emaFast),
    emaSlow: round(emaSlow),
    vwap: round(vwap),
    volumeRatio: round(volumeRatio),
    atrPct: round(atrPct),
    impulsePct: round(impulsePct),
    expectedTargetMovePct: round(expectedTargetMovePct),
    estimatedRoundTripCostPct: round(estimatedRoundTripCostPct),
    reason: 'no_signal'
  };
}

export function buildScalpPositionFromSignal(
  signal: ScalpSignal,
  entryCandle: Candle,
  params: ScalpParams,
  balance: number,
  entryIndex: number
): ScalpPosition | null {
  if (signal.side !== 'long' && signal.side !== 'short') {
    return null;
  }

  const cappedRisk = Math.min(params.riskPerTrade, params.maxRiskPerTrade);
  const riskAmount = balance * cappedRisk;

  if (!Number.isFinite(riskAmount) || riskAmount <= 0) {
    return null;
  }

  const entryPrice =
    signal.side === 'long'
      ? entryCandle.open * (1 + params.slippageRate)
      : entryCandle.open * (1 - params.slippageRate);

  const stopDistance = signal.atr * params.atrSlMult;
  const targetDistance = signal.atr * params.atrTpMult;

  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(stopDistance) ||
    !Number.isFinite(targetDistance) ||
    entryPrice <= 0 ||
    stopDistance <= 0 ||
    targetDistance <= 0
  ) {
    return null;
  }

  const rawSizeByRisk = riskAmount / stopDistance;
  const maxNotional = balance * params.maxPositionNotionalPct;
  const maxSizeByNotional = maxNotional / entryPrice;
  const size = Math.min(rawSizeByRisk, maxSizeByNotional);

  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }

  const stopLoss =
    signal.side === 'long'
      ? entryPrice - stopDistance
      : entryPrice + stopDistance;

  const takeProfit =
    signal.side === 'long'
      ? entryPrice + targetDistance
      : entryPrice - targetDistance;

  return {
    side: signal.side,
    entryPrice: round(entryPrice),
    entryIndex,
    entryTime: entryCandle.time,
    size: round(size),
    stopLoss: round(stopLoss),
    takeProfit: round(takeProfit),
    timeStopBars: params.timeStopBars,
    signalTime: signal.timestamp,
    atrAtEntry: round(signal.atr)
  };
}

export function evaluateScalpExit(
  position: ScalpPosition,
  candle: Candle,
  currentIndex: number,
  params: ScalpParams
): { exit: boolean; exitPrice: number | null; reason: string | null } {
  const barsHeld = currentIndex - position.entryIndex;

  if (barsHeld >= position.timeStopBars) {
    const exitPrice =
      position.side === 'long'
        ? candle.close * (1 - params.slippageRate)
        : candle.close * (1 + params.slippageRate);

    return {
      exit: true,
      exitPrice: round(exitPrice),
      reason: 'time_stop'
    };
  }

  if (position.side === 'long') {
    if (candle.low <= position.stopLoss) {
      const basePrice = Math.min(candle.open, position.stopLoss);
      return {
        exit: true,
        exitPrice: round(basePrice * (1 - params.slippageRate)),
        reason: 'stop_loss'
      };
    }

    if (candle.high >= position.takeProfit) {
      const basePrice = Math.max(candle.open, position.takeProfit);
      return {
        exit: true,
        exitPrice: round(basePrice * (1 - params.slippageRate)),
        reason: 'take_profit'
      };
    }
  }

  if (position.side === 'short') {
    if (candle.high >= position.stopLoss) {
      const basePrice = Math.max(candle.open, position.stopLoss);
      return {
        exit: true,
        exitPrice: round(basePrice * (1 + params.slippageRate)),
        reason: 'stop_loss'
      };
    }

    if (candle.low <= position.takeProfit) {
      const basePrice = Math.min(candle.open, position.takeProfit);
      return {
        exit: true,
        exitPrice: round(basePrice * (1 + params.slippageRate)),
        reason: 'take_profit'
      };
    }
  }

  return {
    exit: false,
    exitPrice: null,
    reason: null
  };
}
