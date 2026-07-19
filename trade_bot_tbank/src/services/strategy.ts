import { MACD, RSI, ATR, ADX, BollingerBands, EMA } from 'technicalindicators';

const STARTING_BALANCE = 50000;
const MAX_RISK_PER_TRADE = 0.01;

const MIN_ADX_TREND = 20;
const MIN_ADX_RANGE = 18;

/**
 * Порог сжатия BB для breakout_watch.
 * На 15m breakout_watch отключён полностью (см. analyzeMarket),
 * константа сохранена для будущего использования на старших ТФ.
 */
const BB_SQUEEZE_THRESHOLD = 0.05;

const COMMISSION_RATE = 0.003; // 0.3% за одну сторону сделки
const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2; // вход + выход
const MIN_NET_PROFIT_BUFFER_RATE = 0.001; // 0.1% запас поверх round-trip комиссии
const MIN_TP_ATR_MULTIPLIER = 0.5;

const STRUCTURE_LOOKBACK = 10;

/**
 * Повышен с 0.002 до 0.003: на 15m ATR SBER ~0.2% и нам нужен
 * реальный запас поверх 0.6% round-trip комиссии.
 */
const MIN_EXPECTED_NET_MOVE_RATE = 0.003;

/**
 * Кулдаун после стоп-лосса: 6 свечей × 15m = 90 минут.
 * Предотвращает серию встречных сделок в пилообразном рынке.
 */
const LOSS_COOLDOWN_CANDLES = 6;

/**
 * Торговые часы MOEX (UTC): 07:00–15:00 = 10:00–18:00 МСК.
 * Первый час после открытия (07:00–08:00 UTC) и вечерняя сессия
 * дают повышенный процент ложных пробоев на 15m.
 */
const TRADING_HOUR_START_UTC = 7;
const TRADING_HOUR_END_UTC = 15;

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
  | 'high_volatility'
  | 'unknown';

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

/**
 * Внутреннее состояние кулдауна.
 * В live-боте хранится в памяти процесса / БД.
 * В бэктесте передаётся через параметр analyzeMarket.
 */
export interface StrategyState {
  cooldownCandlesLeft: number;
}

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function prev<T>(arr: T[]): T {
  return arr[arr.length - 2];\n}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Порог объёма повышен до 1.5× для отсева мелких всплесков.
 */
function getVolumeSpike(volumes: number[], avgVol20: number): boolean {
  const v = volumes[volumes.length - 1] ?? 0;
  return v >= avgVol20 * 1.5;
}

/**
 * Проверка торгового окна по UTC-часу последней свечи.
 * Возвращает false за пределами 07:00–15:00 UTC.
 */
function isWithinTradingHours(candleTimeMs: number): boolean {
  const hour = new Date(candleTimeMs).getUTCHours();
  return hour >= TRADING_HOUR_START_UTC && hour < TRADING_HOUR_END_UTC;
}

/**
 * ATR-множители под режим рынка.
 * В тренде делаем стопы шире, чтобы не выбивало рыночным шумом.
 * breakout_watch на 15m отключён, множители оставлены для старших ТФ.
 */
function getAtrMultipliers(regime: MarketRegime, atrPct: number) {
  const highVol = atrPct > 0.02;

  if (regime === 'trend_up' || regime === 'trend_down') {
    return { stop: highVol ? 2.5 : 2.0, target: highVol ? 3.8 : 3.2 };
  }

  if (regime === 'range') {
    return { stop: 1.4, target: 1.0 };
  }

  if (regime === 'breakout_watch') {
    return { stop: highVol ? 2.5 : 2.0, target: highVol ? 4.0 : 3.6 };
  }

  return { stop: 0, target: 0 };
}

/**
 * Структурный стоп: за ближайший swing-low (для лонга)
 * или swing-high (для шорта) последних STRUCTURE_LOOKBACK свечей.
 * Если структурный стоп оказался слишком близко (< 0.5×ATR от цены),
 * используем ATR-стоп как минимум.
 */
function getStructuralStop(params: {
  side: 'long' | 'short';
  highs: number[];
  lows: number[];
  price: number;
  lastAtr: number;
  atrStopMultiplier: number;
}): number {
  const { side, highs, lows, price, lastAtr, atrStopMultiplier } = params;

  const recentHigh = Math.max(...highs.slice(-STRUCTURE_LOOKBACK));
  const recentLow = Math.min(...lows.slice(-STRUCTURE_LOOKBACK));

  const minStopDistance = lastAtr * 0.5;
  const atrStop = lastAtr * atrStopMultiplier;

  if (side === 'long') {
    const structStop = recentLow;
    const distanceFromPrice = price - structStop;
    if (distanceFromPrice < minStopDistance) {
      return price - atrStop;
    }
    // Не ставим стоп дальше ATR-множителя — иначе риск на сделку вырастет
    return Math.max(structStop, price - atrStop);
  }

  // short
  const structStop = recentHigh;
  const distanceFromPrice = structStop - price;
  if (distanceFromPrice < minStopDistance) {
    return price + atrStop;
  }
  return Math.min(structStop, price + atrStop);
}

/**
 * Минимально допустимый тейк:
 * 1) не ближе заданной доли ATR,
 * 2) не ближе, чем требуется для покрытия комиссий и небольшого запаса.
 */
function normalizeTakeProfit(params: {
  side: 'long' | 'short' | 'none';
  price: number;
  takeProfitPrice: number | null;
  lastAtr: number;
}) {
  const { side, price, takeProfitPrice, lastAtr } = params;

  if (side === 'none' || takeProfitPrice == null || lastAtr <= 0) {
    return takeProfitPrice;
  }

  const minAtrDistance = lastAtr * MIN_TP_ATR_MULTIPLIER;
  const minCommissionDistance = price * (ROUND_TRIP_COMMISSION_RATE + MIN_NET_PROFIT_BUFFER_RATE);
  const minDistance = Math.max(minAtrDistance, minCommissionDistance);

  if (side === 'long') {
    return Math.max(takeProfitPrice, price + minDistance);
  }

  if (side === 'short') {
    return Math.min(takeProfitPrice, price - minDistance);
  }

  return takeProfitPrice;
}

/**
 * Считает ожидаемое движение до тейка после вычета round-trip комиссии.
 */
function expectedNetMove(params: {
  side: 'long' | 'short' | 'none';
  price: number;
  takeProfitPrice: number | null;
}) {
  const { side, price, takeProfitPrice } = params;

  if (side === 'none' || takeProfitPrice == null || price <= 0) {
    return { grossMove: 0, netMove: 0, netMoveRate: 0 };
  }

  const grossMove =
    side === 'long' ? takeProfitPrice - price : price - takeProfitPrice;

  const commissionCost = price * ROUND_TRIP_COMMISSION_RATE;
  const netMove = grossMove - commissionCost;
  const netMoveRate = netMove / price;

  return { grossMove, netMove, netMoveRate };
}

/**
 * Структурная цель по ближайшему локальному экстремуму.
 * Для long — локальный максимум. Для short — локальный минимум.
 */
function getStructureTarget(params: {
  side: 'long' | 'short' | 'none';
  highs: number[];
  lows: number[];
  price: number;
  lastAtr: number;
}) {
  const { side, highs, lows, price, lastAtr } = params;

  if (side === 'none') return null;

  const recentHigh = Math.max(...highs.slice(-STRUCTURE_LOOKBACK));
  const recentLow = Math.min(...lows.slice(-STRUCTURE_LOOKBACK));

  if (side === 'long') {
    return Math.max(recentHigh, price + lastAtr * 1.5);
  }

  if (side === 'short') {
    return Math.min(recentLow, price - lastAtr * 1.5);
  }

  return null;
}

/**
 * Защитная проверка: уровни выхода не должны быть «перевёрнуты».
 */
function validateExitLevels(params: {
  side: 'long' | 'short' | 'none';
  price: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  lastAtr: number;
}) {
  const { side, price, lastAtr } = params;
  let { stopLossPrice, takeProfitPrice } = params;

  const fallbackStopDistance = Math.max(lastAtr, price * 0.003);
  const fallbackTakeDistance = Math.max(
    lastAtr * 1.5,
    price * (ROUND_TRIP_COMMISSION_RATE + MIN_NET_PROFIT_BUFFER_RATE)
  );

  if (side === 'long') {
    if (stopLossPrice == null || stopLossPrice >= price) {
      stopLossPrice = price - fallbackStopDistance;
    }
    if (takeProfitPrice == null || takeProfitPrice <= price) {
      takeProfitPrice = price + fallbackTakeDistance;
    }
  }

  if (side === 'short') {
    if (stopLossPrice == null || stopLossPrice <= price) {
      stopLossPrice = price + fallbackStopDistance;
    }
    if (takeProfitPrice == null || takeProfitPrice >= price) {
      takeProfitPrice = price - fallbackTakeDistance;
    }
  }

  return { stopLossPrice, takeProfitPrice };
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
      indicators: null as RegimeIndicators | null
    };
  }

  const lastClose = last(closes);
  const lastAtr = last(atr);
  const lastAdx = last(adx);
  const prevAdx = prev(adx);
  const lastEma20 = last(ema20);
  const lastEma50 = last(ema50);
  const lastEma200 = last(ema200);
  const lastBb = last(bb);

  const avgVol20 = mean(volumes.slice(-20));
  const bbWidth = (lastBb.upper - lastBb.lower) / lastBb.middle;
  const adxRising = lastAdx.adx > prevAdx.adx;
  const atrPct = lastAtr / lastClose;
  const compression = bbWidth <= BB_SQUEEZE_THRESHOLD;

  const trendUp =
    lastClose > lastEma200 &&
    lastEma20 > lastEma50 &&
    lastAdx.adx >= MIN_ADX_TREND &&
    adxRising;

  const trendDown =
    lastClose < lastEma200 &&
    lastEma20 < lastEma50 &&
    lastAdx.adx >= MIN_ADX_TREND &&
    adxRising;

  const range = lastAdx.adx < MIN_ADX_RANGE && bbWidth < 0.08;

  const breakoutWatch =
    compression &&
    lastAdx.adx >= 15 &&
    lastAdx.adx <= 28 &&
    getVolumeSpike(volumes, avgVol20);

  const highVolatility = atrPct > 0.025 || bbWidth > 0.12;

  let regime: MarketRegime = 'range';

  if (highVolatility) regime = 'high_volatility';
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
      bbWidth,
      avgVol20
    } satisfies RegimeIndicators
  };
}

const NO_TRADE = {
  buy: false,
  sell: false,
  side: 'none' as const,
  takeProfitPrice: null,
  stopLossPrice: null,
  positionSize: null,
  quantity: null,
};

export function analyzeMarket(
  candles: Candle[],
  state: StrategyState = { cooldownCandlesLeft: 0 }
) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const opens = candles.map(c => c.open);
  const volumes = candles.map(c => c.volume);

  const regimeInfo = detectMarketRegime(candles);

  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });

  const rsi = RSI.calculate({ period: 14, values: closes });
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });

  const lastCandle = candles[candles.length - 1];
  const price = last(closes);

  if (
    !regimeInfo.ready ||
    !regimeInfo.indicators ||
    macd.length < 2 ||
    rsi.length < 2 ||
    atr.length < 2 ||
    bb.length < 2 ||
    candles.length < 2
  ) {
    return {
      price,
      ...NO_TRADE,
      regime: 'unknown' as MarketRegime,
      cooldownCandlesLeft: state.cooldownCandlesLeft,
      indicators: { ready: false }
    };
  }

  // ── Фильтр 1: торговые часы 07:00–15:00 UTC (10:00–18:00 МСК) ──
  if (!isWithinTradingHours(lastCandle.time)) {
    return {
      price,
      ...NO_TRADE,
      regime: regimeInfo.regime,
      cooldownCandlesLeft: state.cooldownCandlesLeft,
      indicators: { ready: true, skippedReason: 'outside_trading_hours' }
    };
  }

  // ── Фильтр 2: кулдаун после стоп-лосса ──
  if (state.cooldownCandlesLeft > 0) {
    return {
      price,
      ...NO_TRADE,
      regime: regimeInfo.regime,
      cooldownCandlesLeft: state.cooldownCandlesLeft,
      indicators: { ready: true, skippedReason: 'cooldown_active' }
    };
  }

  const prevPrice = prev(closes);

  const lastMacd = last(macd);
  const prevMacd = prev(macd);

  const lastRsi = last(rsi);
  const prevRsi = prev(rsi);

  const lastAtr = last(atr);
  const prevAtr = prev(atr);

  const lastBb = last(bb);
  const prevBb = prev(bb);

  const lastOpen = last(opens);
  const lastHigh = last(highs);
  const lastLow = last(lows);

  const regimeIndicators = regimeInfo.indicators;
  const regime = regimeInfo.regime;
  const atrMultipliers = getAtrMultipliers(regime, regimeIndicators.atrPct);

  const macdCrossUp =
    prevMacd.MACD! < prevMacd.signal! && lastMacd.MACD! > lastMacd.signal!;
  const macdCrossDown =
    prevMacd.MACD! > prevMacd.signal! && lastMacd.MACD! < lastMacd.signal!;

  const rsiBull = lastRsi > 42 && lastRsi < 68;
  const rsiBear = lastRsi < 58 && lastRsi > 32;

  const riskCapital = STARTING_BALANCE * MAX_RISK_PER_TRADE;

  let side: 'long' | 'short' | 'none' = 'none';
  let buy = false;
  let sell = false;
  let takeProfitPrice: number | null = null;
  let stopLossPrice: number | null = null;
  let positionSize: number | null = null;
  let quantity: number | null = null;

  const candleBody = Math.abs(price - lastOpen);
  const candleRange = Math.max(lastHigh - lastLow, 1e-9);
  const bodyPctOfRange = candleBody / candleRange;

  const bullishBreakClose =
    prevPrice <= prevBb.upper &&
    price > lastBb.upper &&
    price > lastOpen &&
    bodyPctOfRange >= 0.55 &&
    lastAtr >= prevAtr;

  const bearishBreakClose =
    prevPrice >= prevBb.lower &&
    price < lastBb.lower &&
    price < lastOpen &&
    bodyPctOfRange >= 0.55 &&
    lastAtr >= prevAtr;

  // ── trend_up ──
  if (regime === 'trend_up' && macdCrossUp && rsiBull && price > regimeIndicators.ema200) {
    side = 'long';
    buy = true;

    stopLossPrice = getStructuralStop({
      side,
      highs,
      lows,
      price,
      lastAtr,
      atrStopMultiplier: atrMultipliers.stop
    });

    const atrTarget = price + lastAtr * atrMultipliers.target;
    const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });
    takeProfitPrice = Math.max(atrTarget, structureTarget ?? atrTarget);
  }

  // ── trend_down ──
  if (regime === 'trend_down' && macdCrossDown && rsiBear && price < regimeIndicators.ema200) {
    side = 'short';
    sell = true;

    stopLossPrice = getStructuralStop({
      side,
      highs,
      lows,
      price,
      lastAtr,
      atrStopMultiplier: atrMultipliers.stop
    });

    const atrTarget = price - lastAtr * atrMultipliers.target;
    const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });
    takeProfitPrice = Math.min(atrTarget, structureTarget ?? atrTarget);
  }

  // ── range ──
  if (regime === 'range') {
    const longSetup = price <= lastBb.lower && lastRsi <= 30;
    const shortSetup = price >= lastBb.upper && lastRsi >= 70;

    if (longSetup) {
      side = 'long';
      buy = true;

      stopLossPrice = getStructuralStop({
        side,
        highs,
        lows,
        price,
        lastAtr,
        atrStopMultiplier: atrMultipliers.stop
      });

      const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });
      takeProfitPrice = Math.max(lastBb.middle, structureTarget ?? lastBb.middle);
    } else if (shortSetup) {
      side = 'short';
      sell = true;

      stopLossPrice = getStructuralStop({
        side,
        highs,
        lows,
        price,
        lastAtr,
        atrStopMultiplier: atrMultipliers.stop
      });

      const structureTarget = getStructureTarget({ side, highs, lows, price, lastAtr });
      takeProfitPrice = Math.min(lastBb.middle, structureTarget ?? lastBb.middle);
    }
  }

  // ── breakout_watch: ОТКЛЮЧЁН на 15m ──
  // На 15-минутных свечах режим генерирует избыточный шум и ложные пробои.
  // Включать только при переходе на 1h+.
  // if (regime === 'breakout_watch') { ... }

  // ── high_volatility: нет сделок ──
  if (regime === 'high_volatility') {
    buy = false;
    sell = false;
    side = 'none';
    takeProfitPrice = null;
    stopLossPrice = null;
  }

  takeProfitPrice = normalizeTakeProfit({ side, price, takeProfitPrice, lastAtr });

  ({ stopLossPrice, takeProfitPrice } = validateExitLevels({
    side,
    price,
    stopLossPrice,
    takeProfitPrice,
    lastAtr
  }));

  const netMoveCheck = expectedNetMove({ side, price, takeProfitPrice });

  if (
    side !== 'none' &&
    (netMoveCheck.netMove <= 0 || netMoveCheck.netMoveRate < MIN_EXPECTED_NET_MOVE_RATE)
  ) {
    side = 'none';
    buy = false;
    sell = false;
    takeProfitPrice = null;
    stopLossPrice = null;
  }

  if (side !== 'none' && stopLossPrice != null) {
    const riskPerUnit = Math.abs(price - stopLossPrice);
    positionSize = riskPerUnit > 0 ? riskCapital / riskPerUnit : null;
    quantity = positionSize != null ? positionSize / price : null;
  }

  return {
    price,
    buy,
    sell,
    side,
    takeProfitPrice,
    stopLossPrice,
    positionSize,
    quantity,
    regime,
    /**
     * Количество оставшихся свечей кулдауна.
     * Бэктест должен передавать обновлённое значение обратно в следующий вызов:
     *   - при stop_loss: state.cooldownCandlesLeft = LOSS_COOLDOWN_CANDLES
     *   - каждая свеча без позиции: state.cooldownCandlesLeft = Math.max(0, prev - 1)
     */
    cooldownCandlesLeft: state.cooldownCandlesLeft,
    lossCooldownCandles: LOSS_COOLDOWN_CANDLES,
    indicators: {
      macdCrossUp,
      macdCrossDown,
      lastRsi,
      prevRsi,
      lastAtr,
      prevAtr,
      rsiBull,
      rsiBear,
      bbUpper: lastBb.upper,
      bbMiddle: lastBb.middle,
      bbLower: lastBb.lower,
      bodyPctOfRange,
      bullishBreakClose,
      bearishBreakClose,
      regimeReady: regimeInfo.ready,
      regimeIndicators,
      expectedNetMove: netMoveCheck,
      ready: true
    }
  };
}
