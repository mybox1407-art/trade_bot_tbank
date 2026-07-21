import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

export const STARTING_BALANCE = 50000;
export const MAX_RISK_PER_TRADE = 0.01;
export const COMMISSION_RATE = 0.0005;
export const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2;
export const TP1_FRACTION = 0.5;
export const TP1_R = 1.2;
export const TP2_R = 1.8;
export const PARTIAL_LOCK_R = 0;

const MIN_STOP_DISTANCE_RATE = 0.004;
const MAX_STOP_DISTANCE_RATE = 0.01;
const MAX_POSITION_FRAC = 0.25;
const MAX_COMMISSION_SHARE_OF_RISK = 0.28;
const MIN_ADX_TREND = 20;
const STOP_STRUCTURE_LOOKBACK = 8;
const STOP_SWING_PAD_ATR = 0.18;
const MAX_EXTENSION_FROM_EMA20 = 0.008;
const TRADING_HOUR_UTC_FROM = 7;
const TRADING_HOUR_UTC_TO = 15;
const MIN_QUANTITY = 2;
const DEFAULT_TIME_FAIL_BARS = 4;
const DEFAULT_BREAKOUT_LOOKBACK = 12;
const DEFAULT_ATR_PERCENTILE_MAX = 0.4;
const DEFAULT_VOLUME_MULTIPLIER = 1.2;
const ATR_PERCENTILE_WINDOW = 120;

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }
export type MarketRegime = 'trend_up' | 'trend_down' | 'range' | 'high_volatility' | 'unknown';
export type HtfBias = 'up' | 'down' | 'neutral';
export interface HtfBarState { time: number; bias: HtfBias; adx: number; ema20: number; ema50: number; ema200: number; close: number; }
export interface HtfFilterOptions { enabled: boolean; minAdx1h?: number; precomputedHtf?: HtfBarState[]; }
export const DEFAULT_HTF_FILTER: HtfFilterOptions = { enabled: false, minAdx1h: 18 };
export interface StrategySignal {
  price: number; buy: boolean; sell: boolean; side: 'long' | 'short' | 'none';
  stopLossPrice: number | null; takeProfit1Price: number | null; takeProfit2Price: number | null; takeProfitPrice: number | null;
  tp1Fraction: number; positionSize: number | null; quantity: number | null; regime: MarketRegime; initialR: number | null; timeFailBars: number; indicators: Record<string, unknown>;
}

function last<T>(arr: T[]) { return arr[arr.length - 1]; }
function prev<T>(arr: T[]) { return arr[arr.length - 2]; }
function mean(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function isTradingHour(ts: number) { const h = new Date(ts).getUTCHours(); return h >= TRADING_HOUR_UTC_FROM && h < TRADING_HOUR_UTC_TO; }

function getStructureStop(params: { side: 'long' | 'short'; highs: number[]; lows: number[]; price: number; lastAtr: number; atrStopMult: number; }) {
  const { side, highs, lows, price, lastAtr, atrStopMult } = params;
  const recentHigh = Math.max(...highs.slice(-STOP_STRUCTURE_LOOKBACK));
  const recentLow = Math.min(...lows.slice(-STOP_STRUCTURE_LOOKBACK));
  const pad = lastAtr * STOP_SWING_PAD_ATR;
  const minDist = Math.max(lastAtr * atrStopMult, price * MIN_STOP_DISTANCE_RATE);
  const maxDist = Math.min(lastAtr * 1.8, price * MAX_STOP_DISTANCE_RATE);

  if (side === 'long') {
    let stop = recentLow - pad;
    if (price - stop < minDist) stop = price - minDist;
    if (price - stop > maxDist) stop = price - maxDist;
    if (stop >= price) stop = price - minDist;
    return stop;
  }

  let stop = recentHigh + pad;
  if (stop - price < minDist) stop = price + minDist;
  if (stop - price > maxDist) stop = price + maxDist;
  if (stop <= price) stop = price + minDist;
  return stop;
}

function calcPositionSize(params: { price: number; stopLossPrice: number; riskCapital: number; balance: number; }) {
  const { price, stopLossPrice, riskCapital, balance } = params;
  const stopDist = Math.abs(price - stopLossPrice);
  if (stopDist <= 0 || price <= 0) return { quantity: null as number | null, positionSize: null as number | null };
  const commPerShare = price * ROUND_TRIP_COMMISSION_RATE;
  const riskPerShare = stopDist + commPerShare;
  if (commPerShare / riskPerShare > MAX_COMMISSION_SHARE_OF_RISK) return { quantity: null, positionSize: null };
  let quantity = Math.floor(riskCapital / riskPerShare);
  const maxQty = Math.floor((balance * MAX_POSITION_FRAC) / price);
  quantity = Math.min(quantity, maxQty);
  if (quantity < MIN_QUANTITY) return { quantity: null, positionSize: null };
  return { quantity, positionSize: quantity * price };
}

export function hourBucketStart(ts: number) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0);
}

export function aggregateTo1h(candles15: Candle[]) {
  const map = new Map<number, Candle>();
  for (const c of candles15) {
    const key = hourBucketStart(c.time);
    const prevBar = map.get(key);
    if (!prevBar) map.set(key, { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    else { prevBar.high = Math.max(prevBar.high, c.high); prevBar.low = Math.min(prevBar.low, c.low); prevBar.close = c.close; prevBar.volume += c.volume; }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

export function buildHtfBiasSeries(hours: Candle[], minAdx1h = 18) {
  if (hours.length < 210) return [];
  const closes = hours.map(h => h.close), highs = hours.map(h => h.high), lows = hours.map(h => h.low);
  const ema20Arr = EMA.calculate({ period: 20, values: closes });
  const ema50Arr = EMA.calculate({ period: 50, values: closes });
  const ema200Arr = EMA.calculate({ period: 200, values: closes });
  const adxArr = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
  const n = hours.length;
  const offE20 = n - ema20Arr.length, offE50 = n - ema50Arr.length, offE200 = n - ema200Arr.length, offAdx = n - adxArr.length;
  const out: HtfBarState[] = [];
  for (let i = 0; i < n; i++) {
    const i20 = i - offE20, i50 = i - offE50, i200 = i - offE200, iAdx = i - offAdx;
    if (i20 < 0 || i50 < 0 || i200 < 0 || iAdx < 0) continue;
    const ema20 = ema20Arr[i20], ema50 = ema50Arr[i50], ema200 = ema200Arr[i200], adxVal = adxArr[iAdx].adx, close = closes[i];
    const adxOk = minAdx1h <= 0 || adxVal >= minAdx1h;
    let bias: HtfBias = 'neutral';
    if (adxOk && close > ema200 && ema20 > ema50) bias = 'up';
    else if (adxOk && close < ema200 && ema20 < ema50) bias = 'down';
    out.push({ time: hours[i].time, bias, adx: adxVal, ema20, ema50, ema200, close });
  }
  return out;
}

export function getHtfBiasAt(series: HtfBarState[], ts15: number) {
  if (!series.length) return null;
  let lo = 0, hi = series.length - 1, best: HtfBarState | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const closeTs = series[mid].time + 3_600_000;
    if (closeTs <= ts15) { best = series[mid]; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best;
}

export function detectMarketRegime(candles: Candle[]) {
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low), volumes = candles.map(c => c.volume);
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  if (atr.length < 2 || adx.length < 2 || ema20.length < 1 || ema50.length < 1 || ema200.length < 1 || bb.length < 1) return { regime: 'unknown' as MarketRegime, ready: false, indicators: null };
  const lastClose = last(closes), lastAtr = last(atr), lastAdx = last(adx), prevAdx = prev(adx), lastEma20 = last(ema20), lastEma50 = last(ema50), lastEma200 = last(ema200), lastBb = last(bb);
  const bbWidth = (lastBb.upper - lastBb.lower) / lastBb.middle;
  const atrPct = lastAtr / lastClose;
  const adxRising = lastAdx.adx > prevAdx.adx;
  const adxOk = lastAdx.adx >= MIN_ADX_TREND && (adxRising || lastAdx.adx >= 26);
  const stackUp = lastEma20 > lastEma50 && lastEma50 > lastEma200;
  const stackDown = lastEma20 < lastEma50 && lastEma50 < lastEma200;
  const highVolatility = atrPct > 0.028 || bbWidth > 0.13;
  const trendUp = !highVolatility && lastClose > lastEma200 && stackUp && adxOk;
  const trendDown = !highVolatility && lastClose < lastEma200 && stackDown && adxOk;
  let regime: MarketRegime = 'unknown';
  if (highVolatility) regime = 'high_volatility';
  else if (trendUp) regime = 'trend_up';
  else if (trendDown) regime = 'trend_down';
  else if (lastAdx.adx < 18) regime = 'range';
  return { regime, ready: true, indicators: { lastClose, lastAtr, atrPct, adx: lastAdx.adx, adxRising, ema20: lastEma20, ema50: lastEma50, ema200: lastEma200, bbWidth, avgVol20: mean(volumes.slice(-20)) } };
}

function emptySignal(price: number, regime: MarketRegime = 'unknown'): StrategySignal {
  return { price, buy: false, sell: false, side: 'none', stopLossPrice: null, takeProfit1Price: null, takeProfit2Price: null, takeProfitPrice: null, tp1Fraction: TP1_FRACTION, positionSize: null, quantity: null, regime, initialR: null, timeFailBars: DEFAULT_TIME_FAIL_BARS, indicators: { ready: false } };
}

function getAtrPercentile(candles: Candle[], window = ATR_PERCENTILE_WINDOW) {
  if (candles.length < Math.max(30, window + 20)) return 0;
  const highs = candles.map(c => c.high), lows = candles.map(c => c.low), closes = candles.map(c => c.close);
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  if (atr.length < 20) return 0;
  const atrValues = atr.slice(-window).map(v => v);
  const lastAtr = atrValues[atrValues.length - 1];
  const rank = atrValues.filter(v => v <= lastAtr).length;
  return atrValues.length ? rank / atrValues.length : 0;
}

export function analyzeMarket(candles: Candle[], balance: number = STARTING_BALANCE, htf: HtfFilterOptions = DEFAULT_HTF_FILTER): StrategySignal {
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low), opens = candles.map(c => c.open), volumes = candles.map(c => c.volume);
  const regimeInfo = detectMarketRegime(candles);
  const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const rsi = RSI.calculate({ period: 14, values: closes });
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  if (!regimeInfo.ready || !regimeInfo.indicators || macd.length < 3 || rsi.length < 2 || atr.length < 2 || candles.length < 40) return emptySignal(closes[closes.length - 1] ?? 0);
  const price = last(closes), prevPrice = prev(closes), regime = regimeInfo.regime, ind = regimeInfo.indicators, lastAtr = last(atr), lastMacd = last(macd), prevMacd = prev(macd), lastRsi = last(rsi), lastOpen = last(opens), lastHigh = last(highs), lastLow = last(lows), lastTs = last(candles).time, avgVol20 = mean(volumes.slice(-20)), atrPct = (ind.atrPct as number) ?? 0, atrPercentile = getAtrPercentile(candles, ATR_PERCENTILE_WINDOW);
  if (!isTradingHour(lastTs)) return { ...emptySignal(price, regime), indicators: { ready: true, skipped: true, regime } };
  const ema20 = ind.ema20 as number, ema50 = ind.ema50 as number, ema200 = ind.ema200 as number, extension = (price - ema20) / price;
  const macdCrossUp = prevMacd.MACD! < prevMacd.signal! && lastMacd.MACD! > lastMacd.signal!;
  const macdCrossDown = prevMacd.MACD! > prevMacd.signal! && lastMacd.MACD! < lastMacd.signal!;
  const macdBull = lastMacd.MACD! > lastMacd.signal! && (lastMacd.histogram ?? 0) >= (prevMacd.histogram ?? 0);
  const macdBear = lastMacd.MACD! < lastMacd.signal! && (lastMacd.histogram ?? 0) <= (prevMacd.histogram ?? 0);
  const range = Math.max(lastHigh - lastLow, 1e-9);
  const bodyPct = Math.abs(price - lastOpen) / range;
  const bullCandle = price > lastOpen && bodyPct >= 0.4;
  const bearCandle = price < lastOpen && bodyPct >= 0.4;
  const priorHigh = Math.max(...highs.slice(-(DEFAULT_BREAKOUT_LOOKBACK + 1), -1));
  const priorLow = Math.min(...lows.slice(-(DEFAULT_BREAKOUT_LOOKBACK + 1), -1));
  const closeOutsideRangeLong = price > priorHigh;
  const closeOutsideRangeShort = price < priorLow;
  const compressionOk = atrPercentile > 0 && atrPercentile <= DEFAULT_ATR_PERCENTILE_MAX && atrPct <= 0.03;
  const volumeOk = avgVol20 > 0 && last(candles).volume >= avgVol20 * DEFAULT_VOLUME_MULTIPLIER;
  const touchLong = lastLow <= ema20 * 1.004 || lastLow <= ema50 * 1.008 || (prevPrice <= ema20 * 1.004 && lastLow <= ema20 * 1.008);
  const touchShort = lastHigh >= ema20 * 0.996 || lastHigh >= ema50 * 0.992 || (prevPrice >= ema20 * 0.996 && lastHigh >= ema20 * 0.992);
  const notExtLong = extension > -0.002 && extension < MAX_EXTENSION_FROM_EMA20;
  const notExtShort = extension < 0.002 && extension > -MAX_EXTENSION_FROM_EMA20;
  const pullbackLong = touchLong && bullCandle && price >= ema20 * 0.998 && macdBull && lastRsi > 46 && lastRsi < 66 && notExtLong;
  const pullbackShort = touchShort && bearCandle && price <= ema20 * 1.002 && macdBear && lastRsi < 54 && lastRsi > 34 && notExtShort;
  const breakoutLong = compressionOk && volumeOk && closeOutsideRangeLong && price > ema20 && price > ema50 && price > ema200 && lastRsi > 52 && lastRsi < 76 && (bullCandle || lastMacd.histogram! > prevMacd.histogram!);
  const breakoutShort = compressionOk && volumeOk && closeOutsideRangeShort && price < ema20 && price < ema50 && price < ema200 && lastRsi < 48 && lastRsi > 24 && (bearCandle || lastMacd.histogram! < prevMacd.histogram!);
  let longSignal = regime === 'trend_up' && price > ema200 && (pullbackLong || breakoutLong);
  let shortSignal = regime === 'trend_down' && price < ema200 && (pullbackShort || breakoutShort);
  if (htf.enabled && (longSignal || shortSignal)) {
    const minAdx = htf.minAdx1h ?? 18;
    let series = htf.precomputedHtf ?? buildHtfBiasSeries(aggregateTo1h(candles), minAdx);
    const st = getHtfBiasAt(series, lastTs);
    if (!st) return { ...emptySignal(price, regime), indicators: { ready: true, reject: 'htf_warmup', longWould: longSignal, shortWould: shortSignal } };
    const sideWouldBe: 'long' | 'short' = longSignal ? 'long' : 'short';
    if (longSignal && st.bias !== 'up') longSignal = false;
    if (shortSignal && st.bias !== 'down') shortSignal = false;
    if (!longSignal && !shortSignal) return { ...emptySignal(price, regime), indicators: { ready: true, reject: 'htf_gate', htfBias: st.bias, htfAdx: st.adx, sideWouldBe, htfEma20: st.ema20, htfEma200: st.ema200 } };
  }
  if (!longSignal && !shortSignal) return { ...emptySignal(price, regime), indicators: { ready: true, longSignal, shortSignal, lastRsi, extension, bodyPct, pullbackLong, pullbackShort, breakoutLong, breakoutShort, compressionOk, volumeOk, closeOutsideRangeLong, closeOutsideRangeShort, atrPercentile } };
  const side: 'long' | 'short' = longSignal ? 'long' : 'short';
  const atrStopMult = atrPct > 0.015 ? 1.4 : 1.3;
  const stopLossPrice = getStructureStop({ side, highs, lows, price, lastAtr, atrStopMult });
  const initialR = Math.abs(price - stopLossPrice);
  const stopPct = initialR / price;
  if (initialR <= 0 || stopPct < MIN_STOP_DISTANCE_RATE || stopPct > MAX_STOP_DISTANCE_RATE) return { ...emptySignal(price, regime), indicators: { ready: true, reject: 'stop_distance', stopPct } };
  const takeProfit1Price = side === 'long' ? price + TP1_R * initialR : price - TP1_R * initialR;
  const takeProfit2Price = side === 'long' ? price + TP2_R * initialR : price - TP2_R * initialR;
  const riskCapital = balance * MAX_RISK_PER_TRADE;
  const sized = calcPositionSize({ price, stopLossPrice, riskCapital, balance });
  if (sized.quantity == null) return { ...emptySignal(price, regime), indicators: { ready: true, reject: 'size' } };
  return { price, buy: side === 'long', sell: side === 'short', side, stopLossPrice, takeProfit1Price, takeProfit2Price, takeProfitPrice: takeProfit2Price, tp1Fraction: TP1_FRACTION, positionSize: sized.positionSize, quantity: sized.quantity, regime, initialR, timeFailBars: DEFAULT_TIME_FAIL_BARS, indicators: { ready: true, lastRsi, extension, initialR, stopPct, bodyPct, tp1: takeProfit1Price, tp2: takeProfit2Price, pullbackLong, pullbackShort, breakoutLong, breakoutShort, compressionOk, volumeOk, closeOutsideRangeLong, closeOutsideRangeShort, atrPercentile, htfEnabled: htf.enabled } };
}
