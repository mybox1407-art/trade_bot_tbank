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
  price: number;
  atr: number;
  ema9: number;
  ema20: number;
  vwap: number;
  volumeRatio: number;
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
}

export interface ScalpParams {
  riskPerTrade: number;
  maxRiskPerTrade: number;
  commissionRate: number;
  atrPeriod: number;
  atrSlMult: number;
  atrTpMult: number;
  emaFastPeriod: number;
  emaSlowPeriod: number;
  vwapPeriod: number;
  volumeMinRatio: number;
  timeStopBars: number;
  sessionStartHour: number;
  sessionEndHour: number;
  afternoonStartHour: number;
  afternoonEndHour: number;
  cooldownBars: number;
}

export const DEFAULT_SCALP_PARAMS: ScalpParams = {
  riskPerTrade: 0.01,
  maxRiskPerTrade: 0.02,
  commissionRate: 0.0005,
  atrPeriod: 14,
  atrSlMult: 1.5,
  atrTpMult: 2.0,
  emaFastPeriod: 9,
  emaSlowPeriod: 20,
  vwapPeriod: 60,
  volumeMinRatio: 1.5,
  timeStopBars: 15,
  sessionStartHour: 10,
  sessionEndHour: 12.5,
  afternoonStartHour: 14,
  afternoonEndHour: 17.5,
  cooldownBars: 5,
};

function toMskHour(timestamp: number): number {
  const d = new Date(timestamp);
  let h = d.getUTCHours() + 3;
  if (h >= 24) h -= 24;
  return h + d.getUTCMinutes() / 60;
}

function calcVWAP(candles: Candle[], period: number, endIndex: number): number {
  let tpVolSum = 0;
  let volSum = 0;
  const start = Math.max(0, endIndex - period + 1);
  for (let i = start; i <= endIndex; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    tpVolSum += tp * candles[i].volume;
    volSum += candles[i].volume;
  }
  return volSum === 0 ? candles[endIndex].close : tpVolSum / volSum;
}

function calcAverageVolume(candles: Candle[], period: number, endIndex: number): number {
  let sum = 0;
  const start = Math.max(0, endIndex - period + 1);
  for (let i = start; i <= endIndex; i++) {
    sum += candles[i].volume;
  }
  const count = endIndex - start + 1;
  return count === 0 ? 0 : sum / count;
}

function isInSession(timestamp: number, p: ScalpParams): boolean {
  const h = toMskHour(timestamp);
  return (h >= p.sessionStartHour && h <= p.sessionEndHour) ||
         (h >= p.afternoonStartHour && h <= p.afternoonEndHour);
}

export function analyzeMomentumScalp(
  candles: Candle[],
  currentIndex: number,
  params: ScalpParams = DEFAULT_SCALP_PARAMS
): ScalpSignal {
  const candle = candles[currentIndex];
  const prevCandle = candles[currentIndex - 1];

  const minHistory = Math.max(params.emaSlowPeriod, params.atrPeriod, params.vwapPeriod) + 2;
  if (currentIndex < minHistory) {
    return { side: 'none', timestamp: candle.time, price: candle.close, atr: 0, ema9: 0, ema20: 0, vwap: 0, volumeRatio: 0, reason: 'not_enough_history' };
  }

  if (!isInSession(candle.time, params)) {
    return { side: 'none', timestamp: candle.time, price: candle.close, atr: 0, ema9: 0, ema20: 0, vwap: 0, volumeRatio: 0, reason: 'outside_session' };
  }

  const closes = candles.slice(0, currentIndex + 1).map(c => c.close);
  const emaFast = EMA.calculate({ period: params.emaFastPeriod, values: closes });
  const emaSlow = EMA.calculate({ period: params.emaSlowPeriod, values: closes });
  const atr = ATR.calculate({
    period: params.atrPeriod,
    high: candles.slice(0, currentIndex + 1).map(c => c.high),
    low: candles.slice(0, currentIndex + 1).map(c => c.low),
    close: candles.slice(0, currentIndex + 1).map(c => c.close),
  });

  const ema9 = emaFast[emaFast.length - 1];
  const ema20 = emaSlow[emaSlow.length - 1];
  const currentATR = atr[atr.length - 1];
  const vwap = calcVWAP(candles, params.vwapPeriod, currentIndex);
  const avgVolume = calcAverageVolume(candles, params.vwapPeriod, currentIndex - 1);
  const volumeRatio = avgVolume === 0 ? 0 : candle.volume / avgVolume;

  if (candle.close > vwap && ema9 > ema20 && candle.close > prevCandle.high && volumeRatio >= params.volumeMinRatio) {
    return { side: 'long', timestamp: candle.time, price: candle.close, atr: currentATR, ema9, ema20, vwap, volumeRatio };
  }

  if (candle.close < vwap && ema9 < ema20 && candle.close < prevCandle.low && volumeRatio >= params.volumeMinRatio) {
    return { side: 'short', timestamp: candle.time, price: candle.close, atr: currentATR, ema9, ema20, vwap, volumeRatio };
  }

  return { side: 'none', timestamp: candle.time, price: candle.close, atr: currentATR, ema9, ema20, vwap, volumeRatio, reason: 'no_signal' };
}

export function buildScalpPosition(
  signal: ScalpSignal,
  params: ScalpParams,
  balance: number
): ScalpPosition {
  const riskAmount = balance * params.riskPerTrade;
  const slDistance = signal.atr * params.atrSlMult;
  const size = riskAmount / slDistance;
  const entryPrice = signal.price;

  return {
    side: signal.side as 'long' | 'short',
    entryPrice,
    entryIndex: 0,
    entryTime: signal.timestamp,
    size,
    stopLoss: signal.side === 'long' ? entryPrice - slDistance : entryPrice + slDistance,
    takeProfit: signal.side === 'long' ? entryPrice + signal.atr * params.atrTpMult : entryPrice - signal.atr * params.atrTpMult,
    timeStopBars: params.timeStopBars,
  };
}

export function evaluateScalpExit(
  position: ScalpPosition,
  candle: Candle,
  currentIndex: number
): { exit: boolean; exitPrice: number | null; reason: string | null } {
  const barsHeld = currentIndex - position.entryIndex;

  if (barsHeld >= position.timeStopBars) {
    return { exit: true, exitPrice: candle.close, reason: 'time_stop' };
  }

  if (position.side === 'long' && candle.low <= position.stopLoss) {
    return { exit: true, exitPrice: Math.min(candle.open, position.stopLoss), reason: 'stop_loss' };
  }
  if (position.side === 'short' && candle.high >= position.stopLoss) {
    return { exit: true, exitPrice: Math.max(candle.open, position.stopLoss), reason: 'stop_loss' };
  }

  if (position.side === 'long' && candle.high >= position.takeProfit) {
    return { exit: true, exitPrice: Math.max(candle.open, position.takeProfit), reason: 'take_profit' };
  }
  if (position.side === 'short' && candle.low <= position.takeProfit) {
    return { exit: true, exitPrice: Math.min(candle.open, position.takeProfit), reason: 'take_profit' };
  }

  return { exit: false, exitPrice: null, reason: null };
}
