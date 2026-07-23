import {
  analyzeMarket,
  Candle,
  detectMarketRegime,
  MarketRegime,
  STARTING_BALANCE,
  COMMISSION_RATE,
  MAX_RISK_PER_TRADE,
  MIN_QUANTITY,
  isTradingHour,
  StrategySignal,
  HtfFilterOptions,
  DEFAULT_HTF_FILTER
} from '../services/strategy';

export type SideFilter = 'both' | 'long' | 'short';

export interface BacktestOptions {
  startingBalance?: number;
  commissionRate?: number;
  warmupCandles15m?: number;
  progressLogEvery?: number;
  sideFilter?: SideFilter;
  tradeStartTime?: number;
  closeOpenPositionOnEnd?: boolean;
  maxRiskPerTrade?: number;
  htfFilter?: HtfFilterOptions;
}

interface OpenPosition {
  symbol: string;
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  entryPrice: number;
  quantity: number;
  initialQuantity: number;
  notional: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  tp1Fraction: number;
  stopLossPrice: number;
  balanceBefore: number;
  tp1Hit: boolean;
}

export interface OpenPositionSnapshot {
  symbol: string;
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  entryPrice: number;
  quantity: number;
  initialQuantity: number;
  notional: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  stopLossPrice: number;
  lastPrice: number;
  unrealizedGrossPnl: number;
  unrealizedNetPnl: number;
}

export interface BacktestTrade {
  symbol: string;
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notional: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  stopLossPrice: number;
  realizedPnL: number;
  grossPnl: number;
  commissionOpen: number;
  commissionClose: number;
  totalCommission: number;
  netPnl: number;
  balanceBefore: number;
  balanceAfter: number;
  barsHeld: number;
  closeReason: 'take_profit_1' | 'take_profit_2' | 'stop_loss' | 'forced_close';
}

export interface BacktestSummary {
  symbol: string;
  tradesCount: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  avgNetPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  startBalance: number;
  endBalance: number;
  returnPct: number;
  maxDrawdownAbs: number;
  maxDrawdownPct: number;
}

export interface RegimeBarBucket {
  bars: number;
  pct: number;
}

export interface RegimeTradeBucket {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  avgBarsHeld: number;
  closeReasons: Record<string, number>;
}

export interface RegimeStats {
  totalBars: number;
  barsByRegime: Record<string, RegimeBarBucket>;
  tradesByRegime: Record<string, RegimeTradeBucket>;
  closeReasonsAll: Record<string, number>;
}

export interface BacktestResult {
  symbol: string;
  options: Required<BacktestOptions>;
  trades: BacktestTrade[];
  summary: BacktestSummary;
  equityCurve: Array<{ time: number; balance: number }>;
  regimeStats: RegimeStats;
  openPosition: OpenPositionSnapshot | null;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'неизвестно';
  if (seconds < 60) return `${Math.round(seconds)} сек`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} мин ${secs} сек`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours} ч ${mins} мин`;
}

function getCommission(turnover: number, commissionRate: number): number {
  return turnover * commissionRate;
}

function getGrossPnl(params: {
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
}): number {
  const { side, entryPrice, exitPrice, quantity } = params;
  if (side === 'long') return (exitPrice - entryPrice) * quantity;
  return (entryPrice - exitPrice) * quantity;
}

function emptyRegimeStats(): RegimeStats {
  return {
    totalBars: 0,
    barsByRegime: {},
    tradesByRegime: {},
    closeReasonsAll: {}
  };
}

function incReason(map: Record<string, number>, reason: string, n = 1): void {
  map[reason] = (map[reason] ?? 0) + n;
}

function buildRegimeStats(
  trades: BacktestTrade[],
  barCounts: Record<string, number>
): RegimeStats {
  const totalBars = Object.values(barCounts).reduce((a, b) => a + b, 0);

  const barsByRegime: Record<string, RegimeBarBucket> = {};
  for (const [reg, bars] of Object.entries(barCounts)) {
    barsByRegime[reg] = {
      bars,
      pct: totalBars > 0 ? round(bars / totalBars, 6) : 0
    };
  }

  const tradesByRegime: Record<string, RegimeTradeBucket> = {};
  const closeReasonsAll: Record<string, number> = {};

  for (const t of trades) {
    const reg = String(t.regime || 'unknown');

    if (!tradesByRegime[reg]) {
      tradesByRegime[reg] = {
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        netProfit: 0,
        grossProfit: 0,
        grossLoss: 0,
        profitFactor: 0,
        avgBarsHeld: 0,
        closeReasons: {}
      };
    }

    const bucket = tradesByRegime[reg];
    bucket.trades += 1;
    bucket.netProfit += t.netPnl;
    bucket.avgBarsHeld += t.barsHeld;

    if (t.netPnl > 0) {
      bucket.wins += 1;
      bucket.grossProfit += t.netPnl;
    } else {
      bucket.losses += 1;
      bucket.grossLoss += t.netPnl;
    }

    incReason(bucket.closeReasons, t.closeReason);
    incReason(closeReasonsAll, t.closeReason);
  }

  for (const bucket of Object.values(tradesByRegime)) {
    const grossLossAbs = Math.abs(bucket.grossLoss);
    bucket.winRate = bucket.trades > 0 ? round(bucket.wins / bucket.trades, 6) : 0;
    bucket.netProfit = round(bucket.netProfit);
    bucket.grossProfit = round(bucket.grossProfit);
    bucket.grossLoss = round(bucket.grossLoss);
    bucket.profitFactor =
      grossLossAbs > 0
        ? round(bucket.grossProfit / grossLossAbs, 6)
        : bucket.grossProfit > 0
          ? Infinity
          : 0;
    bucket.avgBarsHeld =
      bucket.trades > 0 ? round(bucket.avgBarsHeld / bucket.trades, 2) : 0;
  }

  return { totalBars, barsByRegime, tradesByRegime, closeReasonsAll };
}

function calculateDrawdown(equityCurve: Array<{ time: number; balance: number }>) {
  let peak = equityCurve.length ? equityCurve[0].balance : 0;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;

  for (const point of equityCurve) {
    if (point.balance > peak) peak = point.balance;
    const dd = peak - point.balance;
    const ddPct = peak > 0 ? dd / peak : 0;
    if (dd > maxDrawdownAbs) maxDrawdownAbs = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
  }

  return {
    maxDrawdownAbs: round(maxDrawdownAbs),
    maxDrawdownPct: round(maxDrawdownPct, 6)
  };
}

function buildSummary(params: {
  symbol: string;
  trades: BacktestTrade[];
  startBalance: number;
  endBalance: number;
  equityCurve: Array<{ time: number; balance: number }>;
}): BacktestSummary {
  const { symbol, trades, startBalance, endBalance, equityCurve } = params;

  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);

  const grossProfit = wins.reduce((a, b) => a + b.netPnl, 0);
  const grossLossSum = losses.reduce((a, b) => a + b.netPnl, 0);
  const grossLossAbs = Math.abs(grossLossSum);
  const netProfit = trades.reduce((a, b) => a + b.netPnl, 0);

  const profitFactor =
    grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? Infinity : 0;

  const returnPct = startBalance > 0 ? (endBalance - startBalance) / startBalance : 0;
  const dd = calculateDrawdown(equityCurve);

  return {
    symbol,
    tradesCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(trades.length ? wins.length / trades.length : 0, 6),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLossSum),
    netProfit: round(netProfit),
    avgNetPnl: round(trades.length ? netProfit / trades.length : 0),
    avgWin: round(wins.length ? grossProfit / wins.length : 0),
    avgLoss: round(losses.length ? grossLossSum / losses.length : 0),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 6) : Infinity,
    startBalance: round(startBalance),
    endBalance: round(endBalance),
    returnPct: round(returnPct, 6),
    maxDrawdownAbs: dd.maxDrawdownAbs,
    maxDrawdownPct: dd.maxDrawdownPct
  };
}

function snapshotOpenPosition(params: {
  position: OpenPosition;
  lastPrice: number;
  commissionRate: number;
}): OpenPositionSnapshot {
  const { position, lastPrice, commissionRate } = params;

  const unrealizedGrossPnl = getGrossPnl({
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: lastPrice,
    quantity: position.quantity
  });

  const estimatedOpenCommission = getCommission(position.initialQuantity * position.entryPrice, commissionRate);
  const estimatedCloseCommission = getCommission(position.quantity * lastPrice, commissionRate);
  const unrealizedNetPnl =
    unrealizedGrossPnl - estimatedOpenCommission - estimatedCloseCommission;

  return {
    symbol: position.symbol,
    side: position.side,
    regime: position.regime,
    openedAt: position.openedAt,
    entryPrice: round(position.entryPrice),
    quantity: round(position.quantity, 12),
    initialQuantity: round(position.initialQuantity, 12),
    notional: round(position.notional, 8),
    takeProfit1Price: round(position.takeProfit1Price),
    takeProfit2Price: round(position.takeProfit2Price),
    stopLossPrice: round(position.stopLossPrice),
    lastPrice: round(lastPrice),
    unrealizedGrossPnl: round(unrealizedGrossPnl),
    unrealizedNetPnl: round(unrealizedNetPnl)
  };
}

function lowerBoundCandles(candles: Candle[], targetTime: number): number {
  let left = 0;
  let right = candles.length;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (candles[mid].time < targetTime) left = mid + 1;
    else right = mid;
  }

  return left;
}

function buildTrade(params: {
  position: OpenPosition;
  exitPrice: number;
  closedAt: number;
  closeReason: BacktestTrade['closeReason'];
  balanceBeforeClose: number;
  commissionRate: number;
  barsHeld: number;
  quantityToClose: number;
}): BacktestTrade {
  const {
    position,
    exitPrice,
    closedAt,
    closeReason,
    balanceBeforeClose,
    commissionRate,
    barsHeld,
    quantityToClose
  } = params;

  const grossPnl = getGrossPnl({
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: quantityToClose
  });

  const openNotional = quantityToClose * position.entryPrice;
  const closeNotional = quantityToClose * exitPrice;
  const commissionOpen = getCommission(openNotional, commissionRate);
  const commissionClose = getCommission(closeNotional, commissionRate);
  const totalCommission = commissionOpen + commissionClose;
  const netPnl = grossPnl - totalCommission;

  return {
    symbol: position.symbol,
    side: position.side,
    regime: position.regime,
    openedAt: position.openedAt,
    closedAt,
    entryPrice: round(position.entryPrice),
    exitPrice: round(exitPrice),
    quantity: round(quantityToClose, 12),
    notional: round(openNotional, 8),
    takeProfit1Price: round(position.takeProfit1Price),
    takeProfit2Price: round(position.takeProfit2Price),
    stopLossPrice: round(position.stopLossPrice),
    realizedPnL: round(grossPnl),
    grossPnl: round(grossPnl),
    commissionOpen: round(commissionOpen),
    commissionClose: round(commissionClose),
    totalCommission: round(totalCommission),
    netPnl: round(netPnl),
    balanceBefore: round(balanceBeforeClose),
    balanceAfter: round(balanceBeforeClose + netPnl),
    barsHeld,
    closeReason
  };
}

function processExitOnObservedPrice(params: {
  position: OpenPosition;
  currentPrice: number;
  observedAt: number;
  balance: number;
  commissionRate: number;
  barsHeld: number;
}): {
  trade: BacktestTrade | null;
  balance: number;
  stillOpen: boolean;
} {
  const { position, currentPrice, observedAt, commissionRate, barsHeld } = params;
  let { balance } = params;

  const hitTakeProfit1 =
    !position.tp1Hit &&
    (position.side === 'long'
      ? currentPrice >= position.takeProfit1Price
      : currentPrice <= position.takeProfit1Price);

  const hitTakeProfit2 =
    position.tp1Hit &&
    (position.side === 'long'
      ? currentPrice >= position.takeProfit2Price
      : currentPrice <= position.takeProfit2Price);

  const hitStopLoss =
    position.side === 'long'
      ? currentPrice <= position.stopLossPrice
      : currentPrice >= position.stopLossPrice;

  if (hitTakeProfit1) {
    let closeQty = Math.max(MIN_QUANTITY, Math.floor(position.initialQuantity * position.tp1Fraction));
    if (closeQty >= position.quantity) {
      closeQty = position.quantity;
      const trade = buildTrade({
        position,
        exitPrice: currentPrice,
        closedAt: observedAt,
        closeReason: 'take_profit_1',
        balanceBeforeClose: balance,
        commissionRate,
        barsHeld,
        quantityToClose: closeQty
      });
      balance = trade.balanceAfter;
      return { trade, balance, stillOpen: false };
    }

    const trade = buildTrade({
      position,
      exitPrice: currentPrice,
      closedAt: observedAt,
      closeReason: 'take_profit_1',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      quantityToClose: closeQty
    });

    balance = trade.balanceAfter;
    position.quantity -= closeQty;
    position.notional = position.quantity * position.entryPrice;
    position.tp1Hit = true;
    return { trade, balance, stillOpen: true };
  }

  if (hitTakeProfit2) {
    const trade = buildTrade({
      position,
      exitPrice: currentPrice,
      closedAt: observedAt,
      closeReason: 'take_profit_2',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      quantityToClose: position.quantity
    });
    balance = trade.balanceAfter;
    return { trade, balance, stillOpen: false };
  }

  if (hitStopLoss) {
    const trade = buildTrade({
      position,
      exitPrice: currentPrice,
      closedAt: observedAt,
      closeReason: 'stop_loss',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      quantityToClose: position.quantity
    });
    balance = trade.balanceAfter;
    return { trade, balance, stillOpen: false };
  }

  return { trade: null, balance, stillOpen: true };
}

function tryOpenPosition(params: {
  symbol: string;
  signalCandles15m: Candle[];
  entryCandle1m: Candle | null;
  fallbackEntryTime: number;
  fallbackEntryPrice: number;
  currentBalance: number;
  commissionRate: number;
  sideFilter: SideFilter;
  htfFilter: HtfFilterOptions;
}): OpenPosition | null {
  const {
    symbol,
    signalCandles15m,
    entryCandle1m,
    fallbackEntryTime,
    fallbackEntryPrice,
    currentBalance,
    commissionRate,
    sideFilter,
    htfFilter
  } = params;

  const signal = analyzeMarket(signalCandles15m, currentBalance, htfFilter);

  if (signal.side === 'none') return null;
  if (!signal.buy && !signal.sell) return null;
  if (sideFilter === 'long' && signal.side !== 'long') return null;
  if (sideFilter === 'short' && signal.side !== 'short') return null;

  if (
    signal.price == null ||
    signal.stopLossPrice == null ||
    signal.takeProfit1Price == null ||
    signal.takeProfit2Price == null ||
    signal.quantity == null ||
    !Number.isFinite(signal.price) ||
    !Number.isFinite(signal.stopLossPrice) ||
    !Number.isFinite(signal.takeProfit1Price) ||
    !Number.isFinite(signal.takeProfit2Price) ||
    !Number.isFinite(signal.quantity)
  ) {
    return null;
  }

  const signalPrice = toNumber(signal.price);
  const signalStop = toNumber(signal.stopLossPrice);
  const signalTp1 = toNumber(signal.takeProfit1Price);
  const signalTp2 = toNumber(signal.takeProfit2Price);

  const entryPrice = entryCandle1m?.open ?? fallbackEntryPrice;
  const openedAt = entryCandle1m?.time ?? fallbackEntryTime;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

  const stopDistance = Math.abs(signalPrice - signalStop);
  const tp1Distance = Math.abs(signalTp1 - signalPrice);
  const tp2Distance = Math.abs(signalTp2 - signalPrice);

  if (!Number.isFinite(stopDistance) || stopDistance <= 0) return null;
  if (!Number.isFinite(tp1Distance) || tp1Distance <= 0) return null;
  if (!Number.isFinite(tp2Distance) || tp2Distance <= 0) return null;

  const stopLossPrice =
    signal.side === 'long'
      ? entryPrice - stopDistance
      : entryPrice + stopDistance;

  const takeProfit1Price =
    signal.side === 'long'
      ? entryPrice + tp1Distance
      : entryPrice - tp1Distance;

  const takeProfit2Price =
    signal.side === 'long'
      ? entryPrice + tp2Distance
      : entryPrice - tp2Distance;

  if (signal.side === 'long') {
    if (!(stopLossPrice < entryPrice && takeProfit1Price > entryPrice && takeProfit2Price > entryPrice)) return null;
  } else {
    if (!(stopLossPrice > entryPrice && takeProfit1Price < entryPrice && takeProfit2Price < entryPrice)) return null;
  }

  const quantity = toNumber(signal.quantity);
  const notional = quantity * entryPrice;

  if (!Number.isFinite(quantity) || quantity < MIN_QUANTITY) return null;
  if (!Number.isFinite(notional) || notional <= 0) return null;

  return {
    symbol,
    side: signal.side,
    regime: signal.regime,
    openedAt,
    entryPrice,
    quantity,
    initialQuantity: quantity,
    notional,
    takeProfit1Price,
    takeProfit2Price,
    tp1Fraction: signal.tp1Fraction,
    stopLossPrice,
    balanceBefore: currentBalance,
    tp1Hit: false
  };
}

export function runStrategyBacktest(
  symbol: string,
  candles15m: Candle[],
  candles1m: Candle[],
  options: BacktestOptions = {}
): BacktestResult {
  const resolvedOptions: Required<BacktestOptions> = {
    startingBalance: options.startingBalance ?? STARTING_BALANCE,
    commissionRate: options.commissionRate ?? COMMISSION_RATE,
    warmupCandles15m: options.warmupCandles15m ?? 0,
    progressLogEvery: options.progressLogEvery ?? 250,
    sideFilter: options.sideFilter ?? 'both',
    tradeStartTime: options.tradeStartTime ?? 0,
    closeOpenPositionOnEnd: options.closeOpenPositionOnEnd ?? false,
    maxRiskPerTrade: options.maxRiskPerTrade ?? MAX_RISK_PER_TRADE,
    htfFilter: options.htfFilter ?? DEFAULT_HTF_FILTER
  };

  if (!Array.isArray(candles15m) || candles15m.length === 0) {
    return {
      symbol,
      options: resolvedOptions,
      trades: [],
      summary: buildSummary({
        symbol,
        trades: [],
        startBalance: resolvedOptions.startingBalance,
        endBalance: resolvedOptions.startingBalance,
        equityCurve: []
      }),
      equityCurve: [],
      regimeStats: emptyRegimeStats(),
      openPosition: null
    };
  }

  const sorted15m = [...candles15m].sort((a, b) => a.time - b.time);
  const sorted1m = [...candles1m].sort((a, b) => a.time - b.time);

  const tf15mMs =
    sorted15m.length >= 2 ? Math.max(1, sorted15m[1].time - sorted15m[0].time) : 15 * 60 * 1000;

  let balance = resolvedOptions.startingBalance;
  let openPosition: OpenPosition | null = null;

  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ time: number; balance: number }> = [
    { time: sorted15m[0].time, balance: round(balance) }
  ];
  const barCounts: Record<string, number> = {};

  const startedAt = Date.now();
  const startIndex = Math.max(
    1,
    Math.min(resolvedOptions.warmupCandles15m, sorted15m.length - 1)
  );
  const totalBarsToProcess = Math.max(sorted15m.length - startIndex, 0);

  let minuteIndex =
    sorted1m.length > 0 ? lowerBoundCandles(sorted1m, sorted15m[startIndex].time) : 0;

  for (let i = startIndex; i < sorted15m.length; i++) {
    const current15m = sorted15m[i];
    const next15mTime =
      i + 1 < sorted15m.length ? sorted15m[i + 1].time : Number.POSITIVE_INFINITY;

    const signalCandles15m = sorted15m.slice(0, i + 1);

    const regInfo = detectMarketRegime(signalCandles15m);
    const regName = regInfo.ready ? regInfo.regime : 'unknown';
    barCounts[regName] = (barCounts[regName] ?? 0) + 1;

    if (resolvedOptions.progressLogEvery > 0) {
      const processedBars = i - startIndex;
      const shouldLog =
        processedBars > 0 &&
        (processedBars % resolvedOptions.progressLogEvery === 0 || i === sorted15m.length - 1);

      if (shouldLog) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const speed = processedBars / Math.max(elapsedSec, 1e-9);
        const remainingBars = Math.max(totalBarsToProcess - processedBars, 0);
        const etaSec = remainingBars / Math.max(speed, 1e-9);
        const progressPct =
          totalBarsToProcess > 0 ? (processedBars / totalBarsToProcess) * 100 : 100;

        console.log(
          [
            `[${symbol}]`,
            `Прогресс: ${processedBars}/${totalBarsToProcess}`,
            `${round(progressPct, 2)}%`,
            `Скорость: ${round(speed, 2)} свеч/сек`,
            `ETA: ${formatDuration(etaSec)}`,
            `Сделок: ${trades.length}`,
            `Баланс: ${round(balance, 2)}`,
            `Открыта: ${openPosition ? `${openPosition.side}@${round(openPosition.entryPrice, 4)}` : 'нет'}`
          ].join(' | ')
        );
      }
    }

    while (minuteIndex < sorted1m.length && sorted1m[minuteIndex].time < current15m.time) {
      minuteIndex += 1;
    }

    const first1mInWindow =
      minuteIndex < sorted1m.length && sorted1m[minuteIndex].time < next15mTime
        ? sorted1m[minuteIndex]
        : null;

    if (!openPosition && current15m.time >= resolvedOptions.tradeStartTime && isTradingHour(current15m.time)) {
      const maybeOpen = tryOpenPosition({
        symbol,
        signalCandles15m,
        entryCandle1m: first1mInWindow,
        fallbackEntryTime: current15m.time,
        fallbackEntryPrice: current15m.open,
        currentBalance: balance,
        commissionRate: resolvedOptions.commissionRate,
        sideFilter: resolvedOptions.sideFilter,
        htfFilter: resolvedOptions.htfFilter
      });

      if (maybeOpen) {
        openPosition = maybeOpen;
      }
    }

    let scanIndex = minuteIndex;

    while (scanIndex < sorted1m.length && sorted1m[scanIndex].time < next15mTime) {
      if (openPosition) {
        const minuteCandle = sorted1m[scanIndex];
        const observedPrice = minuteCandle.close;
        const barsHeld = Math.max(
          0,
          Math.floor((minuteCandle.time - openPosition.openedAt) / tf15mMs)
        );

        const result = processExitOnObservedPrice({
          position: openPosition,
          currentPrice: observedPrice,
          observedAt: minuteCandle.time,
          balance,
          commissionRate: resolvedOptions.commissionRate,
          barsHeld
        });

        balance = result.balance;

        if (result.trade) {
          trades.push(result.trade);
          equityCurve.push({ time: result.trade.closedAt, balance: round(balance) });
          if (!result.stillOpen) {
            openPosition = null;
            scanIndex += 1;
            break;
          }
        }
      }

      scanIndex += 1;
    }

    minuteIndex = scanIndex;
  }

  let openPositionSnapshot: OpenPositionSnapshot | null = null;

  if (openPosition) {
    const last1m = sorted1m.length ? sorted1m[sorted1m.length - 1] : null;
    const last15m = sorted15m[sorted15m.length - 1];
    const lastPrice = last1m?.close ?? last15m.close;
    const lastTime = last1m?.time ?? last15m.time;

    if (resolvedOptions.closeOpenPositionOnEnd) {
      const barsHeld = Math.max(0, Math.floor((lastTime - openPosition.openedAt) / tf15mMs));

      const trade = buildTrade({
        position: openPosition,
        exitPrice: lastPrice,
        closedAt: lastTime,
        closeReason: 'forced_close',
        balanceBeforeClose: balance,
        commissionRate: resolvedOptions.commissionRate,
        barsHeld,
        quantityToClose: openPosition.quantity
      });

      balance = trade.balanceAfter;
      trades.push(trade);
      equityCurve.push({ time: lastTime, balance: round(balance) });
    } else {
      openPositionSnapshot = snapshotOpenPosition({
        position: openPosition,
        lastPrice,
        commissionRate: resolvedOptions.commissionRate
      });
    }
  }

  const regimeStats = buildRegimeStats(trades, barCounts);

  return {
    symbol,
    options: resolvedOptions,
    trades,
    summary: buildSummary({
      symbol,
      trades,
      startBalance: resolvedOptions.startingBalance,
      endBalance: balance,
      equityCurve
    }),
    equityCurve,
    regimeStats,
    openPosition: openPositionSnapshot
  };
}
