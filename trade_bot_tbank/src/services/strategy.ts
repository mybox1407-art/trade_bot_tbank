import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

// ============================================================================
// КАПИТАЛ / РИСК
// ============================================================================
export const STARTING_BALANCE = 50000;
export const MAX_RISK_PER_TRADE = 0.03;
export const COMMISSION_RATE = 0.0005;
export const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2;
export const TP1_FRACTION = 0.5;

export const TREND_TP1_R = 1.2;
export const TREND_TP2_R = 1.8;

// Breakout-only режим:
// TP1 должен быть не меньше 1.15R, поэтому 1.0R здесь больше не подходит.
export const BREAKOUT_TP1_R = 1.2;
export const BREAKOUT_TP2_R = 2.5;

export const PARTIAL_LOCK_R = 0;

const MIN_STOP_DISTANCE_RATE = 0.003;
const MAX_STOP_DISTANCE_RATE = 0.012;
const MAX_POSITION_FRAC = 0.3;
const MAX_COMMISSION_SHARE_OF_RISK = 0.28;
const MIN_ADX_TREND = 20;
const MIN_ADX_RANGE = 18;
const BB_SQUEEZE_THRESHOLD = 0.06;
const STOP_STRUCTURE_LOOKBACK = 8;
const STOP_SWING_PAD_ATR = 0.18;

// MOEX: основная сессия 10:00–18:59 МСК (07:00–15:59 UTC)
// + вечерняя 19:00–23:49 МСК (16:00–20:49 UTC).
const TRADING_HOUR_UTC_FROM = 7;
const TRADING_HOUR_UTC_TO = 21;

export const MIN_QUANTITY = 2;

// В данном режиме стратегия генерирует только breakout_entry.
// Значение 0 исключает случайное применение time-fail к отсутствующим standard-входам.
const DEFAULT_TIME_FAIL_BARS = 0;

// ============================================================================
// BREAKOUT SETTINGS
// ============================================================================
const BREAKOUT_ATR_BUFFER_K = 0.1;
const BREAKOUT_BODY_ATR_MIN = 0.3;
const MAX_BREAKOUT_BODY_ATR = 2;
const BREAKOUT_ATR_STOP_MULT = 1.5;

// ============================================================================
// BREAKOUT RISK / EXIT SETTINGS
// ============================================================================

// Не открывать пробой, если расстояние от входа до TP1 меньше 1.15R.
export const BREAKOUT_MIN_TP1_R = 1.15;

// Если за 4 завершённых пятиминутных бара пробой не показал
// хотя бы +0.25R движения в сторону позиции — закрыть breakout_time_fail.
export const BREAKOUT_TIME_FAIL_BARS = 2;
export const BREAKOUT_TIME_FAIL_MIN_MFE_R = 0.20;

// ============================================================================
// VOLUME SETTINGS
// ============================================================================
const VOLUME_LOOKBACK = 20;
const VOLUME_SPIKE_MULTIPLIER = 1.1;

// ============================================================================
// 5M ENTRY SETTINGS
// ============================================================================
const ENTRY_5M_DIAGNOSTIC_LOOKBACK = 4;
const ENTRY_5M_DIAGNOSTIC_ATR_BUFFER = 0.05;
const ENTRY_5M_MAX_EMA20_EXTENSION_ATR = 0.8;
const ENTRY_5M_VOLUME_MULTIPLIER = 1.1;
const ENTRY_5M_ATR_STOP_MULT = 1.1;
const ENTRY_5M_CLOSE_NEAR_EXTREME_ATR = 0.70;
const ENTRY_5M_MAX_DISTANCE_FROM_LEVEL_ATR = 0.5;

// ============================================================================
// FRESH BREAKOUT ENTRY
// ============================================================================
const BREAKOUT_ENTRY_MAX_DISTANCE_ATR = 0.35;
const BREAKOUT_ENTRY_MIN_DISTANCE_ATR = 0.05;

// Для ранних breakout-entry допускаем нейтральный RSI.
// Направление подтверждают: закрытие за уровнем, объём,
// тело свечи и closeNearHigh/closeNearLow.
const BREAKOUT_LONG_RSI_MIN = 45;
const BREAKOUT_LONG_RSI_MAX = 78;
const BREAKOUT_SHORT_RSI_MIN = 22;
const BREAKOUT_SHORT_RSI_MAX = 56;

// ============================================================================
// ТИПЫ
// ============================================================================
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
  | 'trend_breakout'
  | 'high_volatility'
  | 'unknown';

export type BreakoutRegimeBucket =
  | 'breakout_watch'
  | 'trend_up'
  | 'trend_down'
  | 'trend_breakout'
  | 'other';

export type HtfBias = 'up' | 'down' | 'neutral';

export type EntryMode =
  | 'none'
  | 'standard'
  | 'breakout_entry';

export interface HtfBarState {
  time: number;
  bias: HtfBias;
  adx: number;
  ema20: number;
  ema50: number;
  ema200: number;
  close: number;
}

export interface HtfFilterOptions {
  enabled: boolean;
  minAdx1h?: number;
  precomputedHtf?: HtfBarState[];
}

export const DEFAULT_HTF_FILTER: HtfFilterOptions = {
  enabled: false,
  minAdx1h: 18
};

export interface StrategySignal {
  [key: string]: any;
  price: number;
  buy: boolean;
  sell: boolean;
  side: 'long' | 'short' | 'none';
  entryMode: EntryMode;
  stopLossPrice: number | null;
  takeProfit1Price: number | null;
  takeProfit2Price: number | null;
  takeProfitPrice: number | null;
  tp1Fraction: number;
  positionSize: number | null;
  quantity: number | null;
  regime: MarketRegime;
  initialR: number | null;

  // Параметры, которые должен сохранить position manager
  // в момент фактического открытия позиции.
  timeFailBars: number;
  timeFailMinMfeR: number | null;
  minTp1R: number | null;

  indicators: Record<string, unknown>;
}

export interface MultiTimeframeInput {
  candles15m: Candle[];
  candles5m: Candle[];
  candles1m?: Candle[]; // ← новое
  balance?: number;
  htf?: HtfFilterOptions;
}

// ============================================================================
// УТИЛИТЫ
// ============================================================================
function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function prev<T>(arr: T[]): T {
  return arr[arr.length - 2];
}

function median(values: number[]): number {
  const sorted = values
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  if (!sorted.length) return 0;

  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function inferBarMs(candles: Candle[]): number {
  const deltas: number[] = [];

  for (let i = Math.max(1, candles.length - 12); i < candles.length; i++) {
    const delta = candles[i].time - candles[i - 1].time;

    if (Number.isFinite(delta) && delta > 0) {
      deltas.push(delta);
    }
  }

  return deltas.length ? Math.min(...deltas) : 15 * 60_000;
}

function indicatorAt<T>(
  values: T[],
  candleIndex: number,
  candleCount: number
): T | undefined {
  const offset = candleCount - values.length;
  const index = candleIndex - offset;

  return index >= 0 && index < values.length
    ? values[index]
    : undefined;
}

function toBreakoutRegimeBucket(
  regime: MarketRegime
): BreakoutRegimeBucket {
  if (
    regime === 'breakout_watch' ||
    regime === 'trend_up' ||
    regime === 'trend_down' ||
    regime === 'trend_breakout'
  ) {
    return regime;
  }

  return 'other';
}

interface VolumeCheck {
  ok: boolean;
  signalVolume: number;
  medianVolume: number;
  threshold: number;
  ratio: number | null;
  sampleSize: number;
}

function checkSignalVolume(
  volumes: number[],
  signalIndex: number,
  lookback = VOLUME_LOOKBACK,
  multiplier = VOLUME_SPIKE_MULTIPLIER
): VolumeCheck {
  const signalVolume = volumes[signalIndex] ?? 0;

  const baselineVolumes = volumes
    .slice(Math.max(0, signalIndex - lookback), signalIndex)
    .filter(value => Number.isFinite(value) && value > 0);

  const medianVolume = median(baselineVolumes);
  const threshold = medianVolume * multiplier;
  const ratio = medianVolume > 0
    ? signalVolume / medianVolume
    : null;

  return {
    ok:
      Number.isFinite(signalVolume) &&
      signalVolume > 0 &&
      medianVolume > 0 &&
      signalVolume >= threshold,
    signalVolume,
    medianVolume,
    threshold,
    ratio,
    sampleSize: baselineVolumes.length
  };
}

export function isTradingHour(timestamp: number): boolean {
  const hour = new Date(timestamp).getUTCHours();

  return hour >= TRADING_HOUR_UTC_FROM &&
    hour < TRADING_HOUR_UTC_TO;
}

function getStructureStop(params: {
  side: 'long' | 'short';
  highs: number[];
  lows: number[];
  price: number;
  lastAtr: number;
  atrStopMult: number;
}): number {
  const {
    side,
    highs,
    lows,
    price,
    lastAtr,
    atrStopMult
  } = params;

  const recentHigh = Math.max(...highs.slice(-STOP_STRUCTURE_LOOKBACK));
  const recentLow = Math.min(...lows.slice(-STOP_STRUCTURE_LOOKBACK));

  const pad = lastAtr * STOP_SWING_PAD_ATR;

  const minDistance = Math.max(
    lastAtr * atrStopMult,
    price * MIN_STOP_DISTANCE_RATE
  );

  const maxDistance = Math.min(
    lastAtr * 1.8,
    price * MAX_STOP_DISTANCE_RATE
  );

  if (side === 'long') {
    let stop = recentLow - pad;

    if (price - stop < minDistance) stop = price - minDistance;
    if (price - stop > maxDistance) stop = price - maxDistance;
    if (stop >= price) stop = price - minDistance;

    return stop;
  }

  let stop = recentHigh + pad;

  if (stop - price < minDistance) stop = price + minDistance;
  if (stop - price > maxDistance) stop = price + maxDistance;
  if (stop <= price) stop = price + minDistance;

  return stop;
}

function calcPositionSize(params: {
  price: number;
  stopLossPrice: number;
  riskCapital: number;
  balance: number;
}) {
  const { price, stopLossPrice, riskCapital, balance } = params;
  const stopDistance = Math.abs(price - stopLossPrice);

  if (stopDistance <= 0 || price <= 0) {
    return {
      quantity: null as number | null,
      positionSize: null as number | null
    };
  }

  const commissionPerShare = price * ROUND_TRIP_COMMISSION_RATE;
  const riskPerShare = stopDistance + commissionPerShare;

  if (commissionPerShare / riskPerShare > MAX_COMMISSION_SHARE_OF_RISK) {
    return {
      quantity: null,
      positionSize: null
    };
  }

  let quantity = Math.floor(riskCapital / riskPerShare);

  const maxQuantity = Math.floor(
    (balance * MAX_POSITION_FRAC) / price
  );

  quantity = Math.min(quantity, maxQuantity);

  if (quantity < MIN_QUANTITY) {
    return {
      quantity: null,
      positionSize: null
    };
  }

  return {
    quantity,
    positionSize: quantity * price
  };
}

// ============================================================================
// HTF (1H BIAS)
// ============================================================================
export function hourBucketStart(timestamp: number): number {
  const date = new Date(timestamp);

  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    0,
    0,
    0
  );
}

export function aggregateTo1h(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();

  for (const candle of candles) {
    const key = hourBucketStart(candle.time);
    const existing = map.get(key);

    if (!existing) {
      map.set(key, {
        time: key,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      });
      continue;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
  }

  return [...map.values()].sort((a, b) => a.time - b.time);
}

export function buildHtfBiasSeries(
  hours: Candle[],
  minAdx1h = 18
): HtfBarState[] {
  if (hours.length < 100) return [];

  const closes = hours.map(bar => bar.close);
  const highs = hours.map(bar => bar.high);
  const lows = hours.map(bar => bar.low);

  const ema20Arr = EMA.calculate({ period: 20, values: closes });
  const ema50Arr = EMA.calculate({ period: 50, values: closes });
  const ema200Arr = EMA.calculate({ period: 200, values: closes });

  const adxArr = ADX.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes
  });

  const candleCount = hours.length;
  const offEma20 = candleCount - ema20Arr.length;
  const offEma50 = candleCount - ema50Arr.length;
  const offEma200 = candleCount - ema200Arr.length;
  const offAdx = candleCount - adxArr.length;

  const output: HtfBarState[] = [];

  for (let i = 0; i < candleCount; i++) {
    const ema20Index = i - offEma20;
    const ema50Index = i - offEma50;
    const ema200Index = i - offEma200;
    const adxIndex = i - offAdx;

    if (
      ema20Index < 0 ||
      ema50Index < 0 ||
      ema200Index < 0 ||
      adxIndex < 0
    ) {
      continue;
    }

    const ema20 = ema20Arr[ema20Index];
    const ema50 = ema50Arr[ema50Index];
    const ema200 = ema200Arr[ema200Index];
    const adx = adxArr[adxIndex].adx;
    const close = closes[i];

    const adxOk = minAdx1h <= 0 || adx >= minAdx1h;

    let bias: HtfBias = 'neutral';

    if (adxOk && close > ema200 && ema20 > ema50) {
      bias = 'up';
    } else if (adxOk && close < ema200 && ema20 < ema50) {
      bias = 'down';
    }

    output.push({
      time: hours[i].time,
      bias,
      adx,
      ema20,
      ema50,
      ema200,
      close
    });
  }

  return output;
}

export function getHtfBiasAt(
  series: HtfBarState[],
  timestamp: number
): HtfBarState | null {
  if (!series.length) return null;

  let low = 0;
  let high = series.length - 1;
  let best: HtfBarState | null = null;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const closeTimestamp = series[mid].time + 3_600_000;

    if (closeTimestamp <= timestamp) {
      best = series[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function isHtfDirectionAllowed(
  side: 'long' | 'short',
  htfBias: HtfBias
): boolean {
  if (side === 'long') {
    return htfBias !== 'down';
  }

  return htfBias !== 'up';
}

// ============================================================================
// 15M MARKET CONTEXT
// ============================================================================
export function detectMarketRegime(
  candles: Candle[],
  asOfIndex?: number
) {
  const end = asOfIndex === undefined
    ? candles.length
    : Math.max(0, Math.min(asOfIndex + 1, candles.length));

  const view = candles.slice(0, end);

  const closes = view.map(candle => candle.close);
  const highs = view.map(candle => candle.high);
  const lows = view.map(candle => candle.low);
  const volumes = view.map(candle => candle.volume);

  const atr = ATR.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes
  });

  const adx = ADX.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes
  });

  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });

  const bb = BollingerBands.calculate({
    period: 20,
    values: closes,
    stdDev: 2
  });

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
      indicators: null
    };
  }

  const lastClose = last(closes);
  const lastAtr = last(atr);
  const lastAdx = last(adx);
  const previousAdx = prev(adx);

  const lastEma20 = last(ema20);
  const lastEma50 = last(ema50);
  const lastEma200 = last(ema200);
  const lastBb = last(bb);

  const regimeSignalIndex = view.length - 2;
  const volumeCheck = checkSignalVolume(volumes, regimeSignalIndex);

  const bbWidth = (lastBb.upper - lastBb.lower) / lastBb.middle;
  const atrPct = lastAtr / lastClose;

  const adxRising = lastAdx.adx > previousAdx.adx;

  const adxOk =
    lastAdx.adx >= MIN_ADX_TREND &&
    (adxRising || lastAdx.adx >= 26);

  const stackUp =
    lastEma20 > lastEma50 &&
    lastEma50 > lastEma200;

  const stackDown =
    lastEma20 < lastEma50 &&
    lastEma50 < lastEma200;

  const highVolatility =
    atrPct > 0.028 ||
    bbWidth > 0.13;

  const compression = bbWidth <= BB_SQUEEZE_THRESHOLD;

  const trendUp =
    !highVolatility &&
    lastClose > lastEma200 &&
    stackUp &&
    adxOk;

  const trendDown =
    !highVolatility &&
    lastClose < lastEma200 &&
    stackDown &&
    adxOk;

  const range =
    lastAdx.adx < MIN_ADX_RANGE &&
    bbWidth < 0.08;

  const breakoutWatch =
    compression &&
    lastAdx.adx >= 15 &&
    lastAdx.adx <= 28 &&
    !highVolatility;

  const trendBreakoutUp =
    trendUp &&
    lastClose > lastBb.upper &&
    adxOk;

  const trendBreakoutDown =
    trendDown &&
    lastClose < lastBb.lower &&
    adxOk;

  let regime: MarketRegime = 'unknown';

  if (highVolatility) regime = 'high_volatility';
  else if (trendBreakoutUp || trendBreakoutDown) regime = 'trend_breakout';
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
      bbUpper: lastBb.upper,
      bbMiddle: lastBb.middle,
      bbLower: lastBb.lower,
      bbWidth,
      volumeMedian: volumeCheck.medianVolume,
      volumeRatio: volumeCheck.ratio,
      volumeThreshold: volumeCheck.threshold
    }
  };
}

function emptySignal(
  price: number,
  regime: MarketRegime = 'unknown',
  indicators: Record<string, unknown> = {}
): StrategySignal {
  return {
    price,
    buy: false,
    sell: false,
    side: 'none',
    entryMode: 'none',
    stopLossPrice: null,
    takeProfit1Price: null,
    takeProfit2Price: null,
    takeProfitPrice: null,
    tp1Fraction: TP1_FRACTION,
    positionSize: null,
    quantity: null,
    regime,
    initialR: null,

    timeFailBars: DEFAULT_TIME_FAIL_BARS,
    timeFailMinMfeR: null,
    minTp1R: null,

    indicators: {
      ready: false,
      entryMode: 'none',
      ...indicators
    }
  };
}

// ============================================================================
// 5M ENTRY ANALYSIS WITH 15M CONTEXT
// ============================================================================
//
// ВАЖНО:
// В данной версии отключены все standard-входы.
// Единственный возможный вход — breakout_entry.
//


// ============================================================================
export function analyzeMarketMultiTimeframe(
  input: MultiTimeframeInput
): StrategySignal {
  const {
    candles15m,
    candles5m,
    balance = STARTING_BALANCE,
    htf = DEFAULT_HTF_FILTER
  } = input;

  if (candles15m.length < 220 || candles5m.length < 60) {
    return emptySignal(
      candles5m.at(-1)?.close ??
      candles15m.at(-1)?.close ??
      0
    );
  }

  const now = Date.now();

  const bar15mMs = inferBarMs(candles15m);
  const last15mIsForming =
    last(candles15m).time + bar15mMs > now;

  const setup15mIndex =
    (last15mIsForming
      ? candles15m.length - 2
      : candles15m.length - 1) - 1;

  if (setup15mIndex < 1) {
    return emptySignal(candles5m.at(-1)?.close ?? 0);
  }

  const context15m = detectMarketRegime(
    candles15m,
    setup15mIndex
  );

  const bar5mMs = inferBarMs(candles5m);
  const last5mIsForming =
    last(candles5m).time + bar5mMs > now;

  const signal5mIndex =
    last5mIsForming
      ? candles5m.length - 2
      : candles5m.length - 1;

  if (
    signal5mIndex < ENTRY_5M_DIAGNOSTIC_LOOKBACK ||
    !context15m.ready ||
    !context15m.indicators
  ) {
    return emptySignal(
      candles5m.at(-1)?.close ?? 0,
      context15m.regime
    );
  }

  const closes5m = candles5m.map(candle => candle.close);
  const highs5m = candles5m.map(candle => candle.high);
  const lows5m = candles5m.map(candle => candle.low);
  const volumes5m = candles5m.map(candle => candle.volume);

  const atr5m = ATR.calculate({
    period: 14,
    high: highs5m,
    low: lows5m,
    close: closes5m
  });

  const rsi5m = RSI.calculate({
    period: 14,
    values: closes5m
  });

  const ema20_5m = EMA.calculate({
    period: 20,
    values: closes5m
  });

  if (
    atr5m.length < 2 ||
    rsi5m.length < 1 ||
    ema20_5m.length < 1
  ) {
    return emptySignal(
      closes5m[signal5mIndex] ?? 0,
      context15m.regime
    );
  }

  const signalCandle5m = candles5m[signal5mIndex];
  const price = signalCandle5m.close;
  const signalTime = signalCandle5m.time;

  const lastAtr5m = indicatorAt(
    atr5m,
    signal5mIndex,
    candles5m.length
  );

  const lastRsi5m = indicatorAt(
    rsi5m,
    signal5mIndex,
    candles5m.length
  );

  const lastEma20_5m = indicatorAt(
    ema20_5m,
    signal5mIndex,
    candles5m.length
  );

  if (
    lastAtr5m === undefined ||
    lastRsi5m === undefined ||
    lastEma20_5m === undefined ||
    lastAtr5m <= 0
  ) {
    return emptySignal(price, context15m.regime);
  }

  if (!isTradingHour(signalTime)) {
    return emptySignal(price, context15m.regime, {
      ready: true,
      reject: 'not_trading_hour',
      signalTimeUtc: new Date(signalTime).toISOString()
    });
  }

  const volume5m = checkSignalVolume(
    volumes5m,
    signal5mIndex,
    VOLUME_LOOKBACK,
    ENTRY_5M_VOLUME_MULTIPLIER
  );

  const candleBody5m = Math.abs(
    signalCandle5m.close - signalCandle5m.open
  );

  const candleBodyAtrRatio5m = candleBody5m / lastAtr5m;

  const bodyLargeEnough =
    candleBody5m >= lastAtr5m * BREAKOUT_BODY_ATR_MIN;

  const bodyNotExhausted =
    candleBody5m <= lastAtr5m * MAX_BREAKOUT_BODY_ATR;

  const bodyValid = bodyLargeEnough && bodyNotExhausted;

  const diagnosticLows = lows5m.slice(
    signal5mIndex - ENTRY_5M_DIAGNOSTIC_LOOKBACK,
    signal5mIndex
  );

  const diagnosticHighs = highs5m.slice(
    signal5mIndex - ENTRY_5M_DIAGNOSTIC_LOOKBACK,
    signal5mIndex
  );

  const localLow5m = Math.min(...diagnosticLows);
  const localHigh5m = Math.max(...diagnosticHighs);

  const shortBreakdownThreshold =
    localLow5m - lastAtr5m * ENTRY_5M_DIAGNOSTIC_ATR_BUFFER;

  const longBreakoutThreshold =
    localHigh5m + lastAtr5m * ENTRY_5M_DIAGNOSTIC_ATR_BUFFER;

  const longBreakoutDistanceAtr =
    (price - longBreakoutThreshold) / lastAtr5m;

  const shortBreakoutDistanceAtr =
    (shortBreakdownThreshold - price) / lastAtr5m;
  
  // Требуем, чтобы цена была около уровня (в пределах 0.20 ATR)
  const longSetupNearLevel =
    price >= longBreakoutThreshold - lastAtr5m * 0.20 &&
    price <= longBreakoutThreshold + lastAtr5m * 0.20;
  
  const shortSetupNearLevel =
    price >= shortBreakdownThreshold - lastAtr5m * 0.20 &&
    price <= shortBreakdownThreshold + lastAtr5m * 0.20;
  
  const freshLongBreakout =
    longSetupNearLevel &&
    longBreakoutDistanceAtr >=
      BREAKOUT_ENTRY_MIN_DISTANCE_ATR &&
    longBreakoutDistanceAtr <=
      BREAKOUT_ENTRY_MAX_DISTANCE_ATR;
  
  const freshShortBreakdown =
    shortSetupNearLevel &&
    shortBreakoutDistanceAtr >=
      BREAKOUT_ENTRY_MIN_DISTANCE_ATR &&
    shortBreakoutDistanceAtr <=
      BREAKOUT_ENTRY_MAX_DISTANCE_ATR;

  const shortExtensionFromEma20 =
    (lastEma20_5m - price) / lastAtr5m;

  const longExtensionFromEma20 =
    (price - lastEma20_5m) / lastAtr5m;

  const shortNotOverextended =
    shortExtensionFromEma20 <= ENTRY_5M_MAX_EMA20_EXTENSION_ATR;

  const longNotOverextended =
    longExtensionFromEma20 <= ENTRY_5M_MAX_EMA20_EXTENSION_ATR;

  const closeNearLow =
    signalCandle5m.close <=
    signalCandle5m.low +
      lastAtr5m * ENTRY_5M_CLOSE_NEAR_EXTREME_ATR;

  const closeNearHigh =
    signalCandle5m.close >=
    signalCandle5m.high -
      lastAtr5m * ENTRY_5M_CLOSE_NEAR_EXTREME_ATR;

  const contextRegime = context15m.regime;
  const breakoutRegimeBucket = toBreakoutRegimeBucket(contextRegime);

  const allowShortContext =
    contextRegime === 'trend_down' ||
    contextRegime === 'trend_breakout';

  const allowLongContext =
    contextRegime === 'trend_up' ||
    contextRegime === 'trend_breakout';

  // Для breakout_entry разрешаем вход во всех четырёх
  // отслеживаемых режимах. Направление пока не ограничивается:
  // long и short допустимы в каждом из них.
  const breakoutContextAllowed =
    contextRegime === 'breakout_watch' ||
    contextRegime === 'trend_breakout' ||
    contextRegime === 'trend_up' ||
    contextRegime === 'trend_down';

  const contextEma200 =
    context15m.indicators.ema200 as number | undefined;

  const contextClose =
    context15m.indicators.lastClose as number | undefined;

  const contextTrendShort =
    contextRegime === 'trend_down' ||
    (
      contextRegime === 'trend_breakout' &&
      contextClose !== undefined &&
      contextEma200 !== undefined &&
      contextClose < contextEma200
    );

  const contextTrendLong =
    contextRegime === 'trend_up' ||
    (
      contextRegime === 'trend_breakout' &&
      contextClose !== undefined &&
      contextEma200 !== undefined &&
      contextClose > contextEma200
    );

  const longDistanceFromLevel =
    (price - localHigh5m) / lastAtr5m;

  const shortDistanceFromLevel =
    (localLow5m - price) / lastAtr5m;

  const standardLongNotLate =
    longDistanceFromLevel <= ENTRY_5M_MAX_DISTANCE_FROM_LEVEL_ATR;

  const standardShortNotLate =
    shortDistanceFromLevel <= ENTRY_5M_MAX_DISTANCE_FROM_LEVEL_ATR;

  const rsiLongOk = lastRsi5m > 52 && lastRsi5m < 70;
  const rsiShortOk = lastRsi5m < 48 && lastRsi5m > 30;

  const rsiLongBreakoutOk =
    lastRsi5m > BREAKOUT_LONG_RSI_MIN &&
    lastRsi5m < BREAKOUT_LONG_RSI_MAX;

  const rsiShortBreakoutOk =
    lastRsi5m < BREAKOUT_SHORT_RSI_MAX &&
    lastRsi5m > BREAKOUT_SHORT_RSI_MIN;

  // ==========================================================================
  // STANDARD ENTRIES DISABLED
  // ==========================================================================
  //
  // Оставлены как telemetry-поля, но всегда false.
  // Ни один standard-вход больше не может открыть позицию.
  //
  const standardShortSignal = false;
  const standardLongSignal = false;

  // ==========================================================================
  // 1M ENTRY TRIGGER (для схемы "5m — мозг, 1m — руки")
  // ==========================================================================
  
  let breakoutLongTriggered = false;
  let breakoutShortTriggered = false;
  
  if (input.candles1m && input.candles1m.length >= 2) {
    const last1m = last(input.candles1m);
    const prev1m = input.candles1m[input.candles1m.length - 2];
  
    // LONG: 1m закрылась выше longBreakoutThreshold,
    // а предыдущая была ниже или на уровне.
    if (
      prev1m.close <= longBreakoutThreshold &&
      last1m.close > longBreakoutThreshold
    ) {
      breakoutLongTriggered = true;
    }
  
    // SHORT: 1m закрылась ниже shortBreakdownThreshold,
    // а предыдущая была выше или на уровне.
    if (
      prev1m.close >= shortBreakdownThreshold &&
      last1m.close < shortBreakdownThreshold
    ) {
      breakoutShortTriggered = true;
    }
  }
  
  // ==========================================================================
  // BREAKOUT-ONLY ENTRY
  // ==========================================================================
  const breakoutLongRaw =
    breakoutContextAllowed &&
    volume5m.ok &&
    bodyValid &&
    closeNearHigh &&
    rsiLongBreakoutOk &&
    freshLongBreakout;
  
  const breakoutShortRaw =
    breakoutContextAllowed &&
    volume5m.ok &&
    bodyValid &&
    closeNearLow &&
    rsiShortBreakoutOk &&
    freshShortBreakdown;
  
  // Объявляем breakoutLongSignal / breakoutShortSignal ЗДЕСЬ
  const breakoutLongSignal = breakoutLongRaw && breakoutLongTriggered;
  const breakoutShortSignal = breakoutShortRaw && breakoutShortTriggered;
  
  // Если 1m нет, считаем триггер равным 5m-сигналу (fallback).
  if (!input.candles1m?.length) {
    breakoutLongTriggered = breakoutLongSignal;
    breakoutShortTriggered = breakoutShortSignal;
  }

  let side: 'long' | 'short' | 'none' = 'none';

  if (longSignal && !shortSignal) {
    side = 'long';
  } else if (shortSignal && !longSignal) {
    side = 'short';
  }

  const entryMode: EntryMode =
    side === 'none'
      ? 'none'
      : 'breakout_entry';

  const htfMeta: Record<string, unknown> = {};

  if (side !== 'none' && htf.enabled) {
    const minAdx = htf.minAdx1h ?? 18;

    const series =
      htf.precomputedHtf ??
      buildHtfBiasSeries(
        aggregateTo1h(candles15m),
        minAdx
      );

    const htfState = getHtfBiasAt(series, signalTime);

    if (!htfState) {
      return emptySignal(price, contextRegime, {
        ready: true,
        reject: 'htf_warmup',
        entryTimeframe: '5m',
        contextTimeframe: '15m',
        sideWouldBe: side,
        entryModeWouldBe: entryMode,
        htfSeriesLength: series.length
      });
    }

    const htfDirectionAligned =
      isHtfDirectionAllowed(side, htfState.bias);

    // Поведение сохранено из исходной стратегии:
    // HTF не блокирует breakout_entry, только логируется.
    const htfDirectionAllowed = true;

    htfMeta.htfEnabled = true;
    htfMeta.htfBias = htfState.bias;
    htfMeta.htfAdx = htfState.adx;
    htfMeta.htfEma20 = htfState.ema20;
    htfMeta.htfEma50 = htfState.ema50;
    htfMeta.htfEma200 = htfState.ema200;
    htfMeta.htfDirectionAligned = htfDirectionAligned;
    htfMeta.htfDirectionAllowed = htfDirectionAllowed;
    htfMeta.htfGateBypassedForBreakout =
      !htfDirectionAligned;

    if (!htfDirectionAllowed) {
      return emptySignal(price, contextRegime, {
        ready: true,
        reject: 'htf_gate',
        entryTimeframe: '5m',
        contextTimeframe: '15m',
        sideWouldBe: side,
        entryModeWouldBe: entryMode,
        htfAllowed: false,
        ...htfMeta
      });
    }
  }

  if (side === 'none') {
    const rejectReasons: string[] = [];

    if (!breakoutContextAllowed) {
      rejectReasons.push('15m_breakout_context_not_tradeable');
    }

    if (!bodyLargeEnough) {
      rejectReasons.push('5m_body_too_small');
    }

    if (!bodyNotExhausted) {
      rejectReasons.push('5m_body_too_large');
    }

    if (!volume5m.ok) {
      rejectReasons.push('5m_volume_below_threshold');
    }

    if (!freshLongBreakout && !freshShortBreakdown) {
      rejectReasons.push('5m_breakout_not_confirmed_or_too_late');
    }

    // Удалены все проверки с confirmedBreakout5m / confirmedBreakdown5m

    return emptySignal(price, contextRegime, {
      ready: true,
      reject: 'no_breakout_entry_conditions',
      rejectReasons,

      entryTimeframe: '5m',
      contextTimeframe: '15m',
      signalTimeUtc: new Date(signalTime).toISOString(),
      signal5mIndex,
      last5mIsForming,
      last15mIsForming,

      contextRegime,
      regimeAtEntry: contextRegime,
      breakoutRegimeBucket,

      context15mAdx: context15m.indicators.adx,
      context15mEma20: context15m.indicators.ema20,
      context15mEma50: context15m.indicators.ema50,
      context15mEma200: context15m.indicators.ema200,
      context15mBbWidth: context15m.indicators.bbWidth,

      allowShortContext,
      allowLongContext,
      breakoutContextAllowed,
      contextTrendShort,
      contextTrendLong,

      price,
      lastAtr5m,
      lastRsi5m,
      ema20_5m: lastEma20_5m,

      candleBody5m,
      candleBodyAtrRatio5m,
      minBody5m: lastAtr5m * BREAKOUT_BODY_ATR_MIN,
      maxBody5m: lastAtr5m * MAX_BREAKOUT_BODY_ATR,
      bodyValid,

      volumeSpike: volume5m.ok,
      volumeCurrent: volume5m.signalVolume,
      volumeMedian: volume5m.medianVolume,
      volumeRatio: volume5m.ratio,
      volumeThreshold: volume5m.threshold,
      volumeSampleSize: volume5m.sampleSize,

      diagnosticLookback: ENTRY_5M_DIAGNOSTIC_LOOKBACK,
      diagnosticAtrBuffer: ENTRY_5M_DIAGNOSTIC_ATR_BUFFER,
      localLow5m,
      localHigh5m,
      shortBreakdownThreshold,
      longBreakoutThreshold,

      entryMode: 'none',
      standardLongSignal,
      standardShortSignal,
      breakoutLongSignal,
      breakoutShortSignal,

      // 1m-триггеры
      breakoutLongTriggered,
      breakoutShortTriggered,
      has1mTrigger: Boolean(input.candles1m?.length),

      breakoutEntryMaxDistanceAtr: BREAKOUT_ENTRY_MAX_DISTANCE_ATR,
      freshLongBreakout,
      freshShortBreakdown,
      longBreakoutDistanceAtr,
      shortBreakoutDistanceAtr,

      rsiLongBreakoutOk,
      rsiShortBreakoutOk,
      breakoutLongRsiMin: BREAKOUT_LONG_RSI_MIN,
      breakoutLongRsiMax: BREAKOUT_LONG_RSI_MAX,
      breakoutShortRsiMin: BREAKOUT_SHORT_RSI_MIN,
      breakoutShortRsiMax: BREAKOUT_SHORT_RSI_MAX,

      shortExtensionFromEma20,
      longExtensionFromEma20,
      maxEma20ExtensionAtr: ENTRY_5M_MAX_EMA20_EXTENSION_ATR,
      shortNotOverextended,
      longNotOverextended,

      closeNearLow,
      closeNearHigh,
      closeNearExtremeAtr: ENTRY_5M_CLOSE_NEAR_EXTREME_ATR,

      longDistanceFromLevel,
      shortDistanceFromLevel,
      maxDistanceFromLevelAtr: ENTRY_5M_MAX_DISTANCE_FROM_LEVEL_ATR,
      standardLongNotLate,
      standardShortNotLate,

      rsiLongOk,
      rsiShortOk,

      breakoutMinTp1R: BREAKOUT_MIN_TP1_R,
      breakoutTimeFailBars: BREAKOUT_TIME_FAIL_BARS,
      breakoutTimeFailMinMfeR: BREAKOUT_TIME_FAIL_MIN_MFE_R
    });
  }

  const signalHighs5m = highs5m.slice(0, signal5mIndex + 1);
  const signalLows5m = lows5m.slice(0, signal5mIndex + 1);

  const stopLossPrice = getStructureStop({
    side,
    highs: signalHighs5m,
    lows: signalLows5m,
    price,
    lastAtr: lastAtr5m,

    // Для пробойной ветки используем breakout-множитель.
    atrStopMult: BREAKOUT_ATR_STOP_MULT
  });

  const initialR = Math.abs(price - stopLossPrice);
  const stopPct = initialR / price;

  if (
    initialR <= 0 ||
    stopPct < MIN_STOP_DISTANCE_RATE ||
    stopPct > MAX_STOP_DISTANCE_RATE
  ) {
    return emptySignal(price, contextRegime, {
      ready: true,
      reject: 'stop_distance',
      entryTimeframe: '5m',
      contextTimeframe: '15m',

      sideWouldBe: side,
      entryModeWouldBe: entryMode,

      stopPct,
      initialR,

      contextRegime,
      regimeAtEntry: contextRegime,
      breakoutRegimeBucket,

      localLow5m,
      localHigh5m,
      shortBreakdownThreshold,
      longBreakoutThreshold,
      longBreakoutDistanceAtr,
      shortBreakoutDistanceAtr,
      breakoutEntryMaxDistanceAtr: BREAKOUT_ENTRY_MAX_DISTANCE_ATR
    });
  }

  const isTrendContinuation =
    side === 'short'
      ? contextTrendShort
      : contextTrendLong;

  const tp1R = isTrendContinuation
    ? TREND_TP1_R
    : BREAKOUT_TP1_R;

  const tp2R = isTrendContinuation
    ? TREND_TP2_R
    : BREAKOUT_TP2_R;

  const takeProfit1Price =
    side === 'long'
      ? price + tp1R * initialR
      : price - tp1R * initialR;

  const takeProfit2Price =
    side === 'long'
      ? price + tp2R * initialR
      : price - tp2R * initialR;

  const takeProfit1Distance =
    side === 'long'
      ? takeProfit1Price - price
      : price - takeProfit1Price;

  const tp1ToInitialR =
    initialR > 0
      ? takeProfit1Distance / initialR
      : 0;

  // ==========================================================================
  // BREAKOUT MINIMUM REWARD / RISK FILTER
  // ==========================================================================
  //
  // Не открываем breakout_entry, если TP1 находится ближе 1.15R.
  // Защищает от сделок типа GAZP long с TP/Risk около 0.64R.
  //
  if (tp1ToInitialR < BREAKOUT_MIN_TP1_R) {
    return emptySignal(price, contextRegime, {
      ready: true,
      reject: 'breakout_tp1_r_too_low',

      entryTimeframe: '5m',
      contextTimeframe: '15m',
      signalTimeUtc: new Date(signalTime).toISOString(),

      sideWouldBe: side,
      entryModeWouldBe: 'breakout_entry',

      contextRegime,
      regimeAtEntry: contextRegime,
      breakoutRegimeBucket,

      price,
      stopLossPrice,
      takeProfit1Price,
      takeProfit2Price,

      initialR,
      stopPct,

      tp1R,
      tp2R,
      tp1ToInitialR,
      minBreakoutTp1R: BREAKOUT_MIN_TP1_R,

      localLow5m,
      localHigh5m,
      shortBreakdownThreshold,
      longBreakoutThreshold,

      freshLongBreakout,
      freshShortBreakdown,

      longBreakoutDistanceAtr,
      shortBreakoutDistanceAtr,

      breakoutEntryMaxDistanceAtr: BREAKOUT_ENTRY_MAX_DISTANCE_ATR
    });
  }

  const riskCapital = balance * MAX_RISK_PER_TRADE;

  const sized = calcPositionSize({
    price,
    stopLossPrice,
    riskCapital,
    balance
  });

  if (sized.quantity == null) {
    return emptySignal(price, contextRegime, {
      ready: true,
      reject: 'size_calculation',

      entryTimeframe: '5m',
      contextTimeframe: '15m',

      sideWouldBe: side,
      entryModeWouldBe: 'breakout_entry',

      contextRegime,
      regimeAtEntry: contextRegime,
      breakoutRegimeBucket,

      price,
      stopLossPrice,
      takeProfit1Price,
      takeProfit2Price,

      initialR,
      stopPct,

      tp1R,
      tp2R,
      tp1ToInitialR,
      minBreakoutTp1R: BREAKOUT_MIN_TP1_R,

      localLow5m,
      localHigh5m,
      shortBreakdownThreshold,
      longBreakoutThreshold,

      freshLongBreakout,
      freshShortBreakdown,

      longBreakoutDistanceAtr,
      shortBreakoutDistanceAtr,

      breakoutEntryMaxDistanceAtr: BREAKOUT_ENTRY_MAX_DISTANCE_ATR
    });
  }

  return {
    price,
    buy: side === 'long',
    sell: side === 'short',
    side,

    entryMode: 'breakout_entry',

    stopLossPrice,
    takeProfit1Price,
    takeProfit2Price,
    takeProfitPrice: takeProfit2Price,

    tp1Fraction: TP1_FRACTION,
    positionSize: sized.positionSize,
    quantity: sized.quantity,

    regime: contextRegime,
    initialR,

    // Эти параметры должен сохранить position manager при открытии.
    // На 4-й закрытой 5m-свече он должен проверить MFE:
    // если MFE < +0.25R — закрыть с breakout_time_fail.
    timeFailBars: BREAKOUT_TIME_FAIL_BARS,
    timeFailMinMfeR: BREAKOUT_TIME_FAIL_MIN_MFE_R,
    minTp1R: BREAKOUT_MIN_TP1_R,

    indicators: {
      ready: true,

      entryTimeframe: '5m',
      contextTimeframe: '15m',

      signalTimeUtc: new Date(signalTime).toISOString(),
      signal5mIndex,
      last5mIsForming,
      last15mIsForming,

      // Сохраняй именно эти значения в открытой позиции и CSV.
      // Режим на момент выхода не должен подменять режим на момент входа.
      contextRegime,
      regimeAtEntry: contextRegime,
      breakoutRegimeBucket,

      context15mAdx: context15m.indicators.adx,
      context15mEma20: context15m.indicators.ema20,
      context15mEma50: context15m.indicators.ema50,
      context15mEma200: context15m.indicators.ema200,
      context15mBbUpper: context15m.indicators.bbUpper,
      context15mBbMiddle: context15m.indicators.bbMiddle,
      context15mBbLower: context15m.indicators.bbLower,
      context15mBbWidth: context15m.indicators.bbWidth,

      allowShortContext,
      allowLongContext,
      breakoutContextAllowed,
      contextTrendShort,
      contextTrendLong,

      entryMode: 'breakout_entry',

      // Явное подтверждение: standard-ветка выключена.
      standardEntriesEnabled: false,
      standardLongSignal,
      standardShortSignal,

      breakoutLongSignal,
      breakoutShortSignal,

      lastAtr: lastAtr5m,
      lastRsi: lastRsi5m,
      ema20_5m: lastEma20_5m,

      candleBody: candleBody5m,
      candleBodyAtrRatio: candleBodyAtrRatio5m,
      minBody: lastAtr5m * BREAKOUT_BODY_ATR_MIN,
      maxBody: lastAtr5m * MAX_BREAKOUT_BODY_ATR,
      breakoutBodyWithinRange: bodyValid,

      volumeSpike: volume5m.ok,
      volumeCurrent: volume5m.signalVolume,
      volumeMedian: volume5m.medianVolume,
      volumeRatio: volume5m.ratio,
      volumeThreshold: volume5m.threshold,
      volumeSampleSize: volume5m.sampleSize,

      diagnosticLookback: ENTRY_5M_DIAGNOSTIC_LOOKBACK,
      diagnosticAtrBuffer: ENTRY_5M_DIAGNOSTIC_ATR_BUFFER,

      localLow5m,
      localHigh5m,
      shortBreakdownThreshold,
      longBreakoutThreshold,

      breakoutEntryMinDistanceAtr: BREAKOUT_ENTRY_MIN_DISTANCE_ATR,
      breakoutEntryMaxDistanceAtr: BREAKOUT_ENTRY_MAX_DISTANCE_ATR,
      freshLongBreakout,
      freshShortBreakdown,
      longBreakoutDistanceAtr,
      shortBreakoutDistanceAtr,

      rsiLongBreakoutOk,
      rsiShortBreakoutOk,
      breakoutLongRsiMin: BREAKOUT_LONG_RSI_MIN,
      breakoutLongRsiMax: BREAKOUT_LONG_RSI_MAX,
      breakoutShortRsiMin: BREAKOUT_SHORT_RSI_MIN,
      breakoutShortRsiMax: BREAKOUT_SHORT_RSI_MAX,

      shortExtensionFromEma20,
      longExtensionFromEma20,
      maxEma20ExtensionAtr: ENTRY_5M_MAX_EMA20_EXTENSION_ATR,
      shortNotOverextended,
      longNotOverextended,

      closeNearLow,
      closeNearHigh,
      closeNearExtremeAtr: ENTRY_5M_CLOSE_NEAR_EXTREME_ATR,

      initialR,
      stopPct,

      tp1R,
      tp2R,
      tp1: takeProfit1Price,
      tp2: takeProfit2Price,

      tp1ToInitialR,
      minBreakoutTp1R: BREAKOUT_MIN_TP1_R,

      breakoutTimeFailBars: BREAKOUT_TIME_FAIL_BARS,
      breakoutTimeFailMinMfeR: BREAKOUT_TIME_FAIL_MIN_MFE_R,

      longDistanceFromLevel,
      shortDistanceFromLevel,
      maxDistanceFromLevelAtr: ENTRY_5M_MAX_DISTANCE_FROM_LEVEL_ATR,
      standardLongNotLate,
      standardShortNotLate,

      rsiLongOk,
      rsiShortOk,

      ...htfMeta
    }
  };
}

// ============================================================================
// LEGACY SINGLE-TIMEFRAME ENTRY
// ============================================================================
export function analyzeMarket(
  candles: Candle[],
  balance: number = STARTING_BALANCE,
  htf: HtfFilterOptions = DEFAULT_HTF_FILTER
): StrategySignal {
  return analyzeMarketMultiTimeframe({
    candles15m: candles,
    candles5m: candles,
    balance,
    htf
  });
}
