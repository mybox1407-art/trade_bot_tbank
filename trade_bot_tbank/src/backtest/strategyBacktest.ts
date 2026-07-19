import { analyzeMarket, Candle, MarketRegime } from '../services/strategy';

/**
 * Настройки бэктеста.
 */
export interface BacktestOptions {
  startingBalance?: number;
  /** Комиссия за одну сторону, 0.0005 = 0.05% */
  commissionRate?: number;
  warmupCandles?: number;
  onePositionAtTime?: boolean;
  /**
   * Если на одной свече и SL и TP — считаем стоп.
   */
  conservativeIntrabarExecution?: boolean;
  /** Пауза после убытка / стопа (свечи). */
  cooldownCandles?: number;
  progressLogEvery?: number;

  /**
   * Когда цена прошла moveToBreakevenR * R в плюс —
   * переносим стоп в безубыток (entry ± commission buffer).
   * 0 = выключено.
   */
  moveToBreakevenR?: number;

  /**
   * После breakeven: трейлинг-стоп на trailAtrMult * ATR от экстремума.
   * 0 = только BE без трейла.
   * ATR берём грубо как initialR (stop distance при входе).
   */
  trailAfterBreakevenR?: number;
}

interface OpenPosition {
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  entryPrice: number;
  /** Текущий стоп (может двигаться). */
  stopLossPrice: number;
  /** Исходный стоп — для расчёта R. */
  initialStopLossPrice: number;
  takeProfitPrice: number;
  quantity: number;
  positionSize: number;
  balanceBefore: number;
  /** 1R в цене (расстояние entry → initial stop). */
  initialR: number;
  breakevenMoved: boolean;
}

export interface BacktestTrade {
  symbol: string;
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  quantity: number;
  positionSize: number;
  closeReason: 'stop_loss' | 'take_profit' | 'forced_close' | 'breakeven' | 'trail_stop';
  grossPnl: number;
  commissionOpen: number;
  commissionClose: number;
  totalCommission: number;
  netPnl: number;
  balanceBefore: number;
  balanceAfter: number;
  barsHeld: number;
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

export interface BacktestResult {
  symbol: string;
  options: Required<BacktestOptions>;
  trades: BacktestTrade[];
  summary: BacktestSummary;
  equityCurve: Array<{ time: number; balance: number }>;
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

function tryOpenPosition(params: {
  visibleCandles: Candle[];
  currentBalance: number;
}): OpenPosition | null {
  const { visibleCandles, currentBalance } = params;
  const signal = analyzeMarket(visibleCandles);

  if (
    signal.side === 'none' ||
    signal.positionSize == null ||
    signal.quantity == null ||
    signal.stopLossPrice == null ||
    signal.takeProfitPrice == null
  ) {
    return null;
  }

  const lastCandle = visibleCandles[visibleCandles.length - 1];
  const entryPrice = toNumber(signal.price);
  const stopLossPrice = toNumber(signal.stopLossPrice);
  const takeProfitPrice = toNumber(signal.takeProfitPrice);

  if (entryPrice <= 0) return null;

  const initialR = Math.abs(entryPrice - stopLossPrice);
  if (initialR <= 0) return null;

  return {
    side: signal.side,
    regime: signal.regime,
    openedAt: lastCandle.time,
    entryPrice,
    stopLossPrice,
    initialStopLossPrice: stopLossPrice,
    takeProfitPrice,
    quantity: toNumber(signal.quantity),
    positionSize: toNumber(signal.positionSize),
    balanceBefore: currentBalance,
    initialR,
    breakevenMoved: false
  };
}

/**
 * Двигаем стоп: breakeven после N*R, затем опциональный трейл.
 * buffer — небольшой запас на комиссию (в цене).
 */
function updateTrailingStop(params: {
  position: OpenPosition;
  candle: Candle;
  moveToBreakevenR: number;
  trailAfterBreakevenR: number;
  commissionRate: number;
}): void {
  const {
    position,
    candle,
    moveToBreakevenR,
    trailAfterBreakevenR,
    commissionRate
  } = params;

  if (moveToBreakevenR <= 0) return;

  const r = position.initialR;
  // Запас на round-trip комиссию в цене, чтобы BE ≈ 0 net
  const buffer = position.entryPrice * commissionRate * 2.2;

  if (position.side === 'long') {
    const favorable = candle.high - position.entryPrice;

    if (!position.breakevenMoved && favorable >= moveToBreakevenR * r) {
      const beStop = position.entryPrice + buffer;
      if (beStop > position.stopLossPrice) {
        position.stopLossPrice = beStop;
      }
      position.breakevenMoved = true;
    }

    if (position.breakevenMoved && trailAfterBreakevenR > 0) {
      const trailStop = candle.high - trailAfterBreakevenR * r;
      if (trailStop > position.stopLossPrice) {
        position.stopLossPrice = trailStop;
      }
    }
  } else {
    const favorable = position.entryPrice - candle.low;

    if (!position.breakevenMoved && favorable >= moveToBreakevenR * r) {
      const beStop = position.entryPrice - buffer;
      if (beStop < position.stopLossPrice) {
        position.stopLossPrice = beStop;
      }
      position.breakevenMoved = true;
    }

    if (position.breakevenMoved && trailAfterBreakevenR > 0) {
      const trailStop = candle.low + trailAfterBreakevenR * r;
      if (trailStop < position.stopLossPrice) {
        position.stopLossPrice = trailStop;
      }
    }
  }
}

function checkExitOnCandle(params: {
  position: OpenPosition;
  candle: Candle;
  conservativeIntrabarExecution: boolean;
}): {
  exitPrice: number;
  closeReason: 'stop_loss' | 'take_profit' | 'breakeven' | 'trail_stop';
} | null {
  const { position, candle, conservativeIntrabarExecution } = params;

  const stopIsBreakeven =
    position.breakevenMoved &&
    Math.abs(position.stopLossPrice - position.entryPrice) <
      position.entryPrice * 0.004;

  if (position.side === 'long') {
    const stopHit = candle.low <= position.stopLossPrice;
    const takeHit = candle.high >= position.takeProfitPrice;

    if (stopHit && takeHit) {
      return conservativeIntrabarExecution
        ? {
            exitPrice: position.stopLossPrice,
            closeReason: stopIsBreakeven ? 'breakeven' : 'stop_loss'
          }
        : { exitPrice: position.takeProfitPrice, closeReason: 'take_profit' };
    }

    if (stopHit) {
      let reason: 'stop_loss' | 'breakeven' | 'trail_stop' = 'stop_loss';
      if (position.breakevenMoved) {
        reason = stopIsBreakeven ? 'breakeven' : 'trail_stop';
      }
      return { exitPrice: position.stopLossPrice, closeReason: reason };
    }

    if (takeHit) {
      return { exitPrice: position.takeProfitPrice, closeReason: 'take_profit' };
    }

    return null;
  }

  const stopHit = candle.high >= position.stopLossPrice;
  const takeHit = candle.low <= position.takeProfitPrice;

  if (stopHit && takeHit) {
    return conservativeIntrabarExecution
      ? {
          exitPrice: position.stopLossPrice,
          closeReason: stopIsBreakeven ? 'breakeven' : 'stop_loss'
        }
      : { exitPrice: position.takeProfitPrice, closeReason: 'take_profit' };
  }

  if (stopHit) {
    let reason: 'stop_loss' | 'breakeven' | 'trail_stop' = 'stop_loss';
    if (position.breakevenMoved) {
      reason = stopIsBreakeven ? 'breakeven' : 'trail_stop';
    }
    return { exitPrice: position.stopLossPrice, closeReason: reason };
  }

  if (takeHit) {
    return { exitPrice: position.takeProfitPrice, closeReason: 'take_profit' };
  }

  return null;
}

function closePosition(params: {
  symbol: string;
  position: OpenPosition;
  closeReason: BacktestTrade['closeReason'];
  exitPrice: number;
  closedAt: number;
  balanceBeforeClose: number;
  commissionRate: number;
  barsHeld: number;
}): BacktestTrade {
  const {
    symbol,
    position,
    closeReason,
    exitPrice,
    closedAt,
    balanceBeforeClose,
    commissionRate,
    barsHeld
  } = params;

  const openTurnover = position.entryPrice * position.quantity;
  const closeTurnover = exitPrice * position.quantity;

  const commissionOpen = getCommission(openTurnover, commissionRate);
  const commissionClose = getCommission(closeTurnover, commissionRate);
  const totalCommission = commissionOpen + commissionClose;

  const grossPnl = getGrossPnl({
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity
  });

  const netPnl = grossPnl - totalCommission;
  const balanceAfter = balanceBeforeClose + netPnl;

  return {
    symbol,
    side: position.side,
    regime: position.regime,
    openedAt: position.openedAt,
    closedAt,
    entryPrice: round(position.entryPrice),
    exitPrice: round(exitPrice),
    stopLossPrice: round(position.stopLossPrice),
    takeProfitPrice: round(position.takeProfitPrice),
    quantity: round(position.quantity, 12),
    positionSize: round(position.positionSize, 8),
    closeReason,
    grossPnl: round(grossPnl),
    commissionOpen: round(commissionOpen),
    commissionClose: round(commissionClose),
    totalCommission: round(totalCommission),
    netPnl: round(netPnl),
    balanceBefore: round(position.balanceBefore),
    balanceAfter: round(balanceAfter),
    barsHeld
  };
}

function calculateDrawdown(equityCurve: Array<{ time: number; balance: number }>) {
  let peak = equityCurve.length ? equityCurve[0].balance : 0;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;

  for (const point of equityCurve) {
    if (point.balance > peak) peak = point.balance;
    const drawdownAbs = peak - point.balance;
    const drawdownPct = peak > 0 ? drawdownAbs / peak : 0;
    if (drawdownAbs > maxDrawdownAbs) maxDrawdownAbs = drawdownAbs;
    if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;
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

  const grossProfit = wins.reduce((sum, t) => sum + t.netPnl, 0);
  const grossLossAbs = Math.abs(losses.reduce((sum, t) => sum + t.netPnl, 0));
  const netProfit = trades.reduce((sum, t) => sum + t.netPnl, 0);

  const avgNetPnl = trades.length ? netProfit / trades.length : 0;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length
    ? losses.reduce((sum, t) => sum + t.netPnl, 0) / losses.length
    : 0;

  const profitFactor =
    grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? Infinity : 0;
  const returnPct = startBalance > 0 ? (endBalance - startBalance) / startBalance : 0;
  const drawdown = calculateDrawdown(equityCurve);

  return {
    symbol,
    tradesCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(trades.length ? wins.length / trades.length : 0, 6),
    grossProfit: round(grossProfit),
    grossLoss: round(-grossLossAbs),
    netProfit: round(netProfit),
    avgNetPnl: round(avgNetPnl),
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 6) : Infinity,
    startBalance: round(startBalance),
    endBalance: round(endBalance),
    returnPct: round(returnPct, 6),
    maxDrawdownAbs: drawdown.maxDrawdownAbs,
    maxDrawdownPct: drawdown.maxDrawdownPct
  };
}

export function runStrategyBacktest(
  symbol: string,
  candles: Candle[],
  options: BacktestOptions = {}
): BacktestResult {
  const resolvedOptions: Required<BacktestOptions> = {
    startingBalance: options.startingBalance ?? 50000,
    commissionRate: options.commissionRate ?? 0.0005,
    warmupCandles: options.warmupCandles ?? 250,
    onePositionAtTime: options.onePositionAtTime ?? true,
    conservativeIntrabarExecution: options.conservativeIntrabarExecution ?? true,
    cooldownCandles: options.cooldownCandles ?? 6,
    progressLogEvery: options.progressLogEvery ?? 5000,
    // После 1R в плюс — стоп в BE
    moveToBreakevenR: options.moveToBreakevenR ?? 1.0,
    // После BE — трейл на 1.2R от экстремума (0 = только BE)
    trailAfterBreakevenR: options.trailAfterBreakevenR ?? 1.2
  };

  if (!Array.isArray(candles) || candles.length === 0) {
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
      equityCurve: []
    };
  }

  const sortedCandles = [...candles].sort((a, b) => a.time - b.time);

  let balance = resolvedOptions.startingBalance;
  let openPosition: OpenPosition | null = null;
  let openPositionIndex = -1;
  let cooldownRemaining = 0;

  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ time: number; balance: number }> = [
    { time: sortedCandles[0].time, balance: round(balance) }
  ];

  const startedAt = Date.now();
  const totalBarsToProcess = Math.max(
    sortedCandles.length - resolvedOptions.warmupCandles,
    0
  );

  for (let i = resolvedOptions.warmupCandles; i < sortedCandles.length; i++) {
    const visibleCandles = sortedCandles.slice(0, i + 1);
    const currentCandle = sortedCandles[i];

    if (resolvedOptions.progressLogEvery > 0) {
      const processedBars = i - resolvedOptions.warmupCandles;
      const shouldLog =
        processedBars > 0 &&
        (processedBars % resolvedOptions.progressLogEvery === 0 ||
          i === sortedCandles.length - 1);

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
            `Баланс: ${round(balance, 2)}`
          ].join(' | ')
        );
      }
    }

    if (openPosition) {
      // 1) Сначала двигаем стоп по high/low текущей свечи
      updateTrailingStop({
        position: openPosition,
        candle: currentCandle,
        moveToBreakevenR: resolvedOptions.moveToBreakevenR,
        trailAfterBreakevenR: resolvedOptions.trailAfterBreakevenR,
        commissionRate: resolvedOptions.commissionRate
      });

      // 2) Потом проверяем выход (уже с новым стопом)
      const exit = checkExitOnCandle({
        position: openPosition,
        candle: currentCandle,
        conservativeIntrabarExecution: resolvedOptions.conservativeIntrabarExecution
      });

      if (exit) {
        const trade = closePosition({
          symbol,
          position: openPosition,
          closeReason: exit.closeReason,
          exitPrice: exit.exitPrice,
          closedAt: currentCandle.time,
          balanceBeforeClose: balance,
          commissionRate: resolvedOptions.commissionRate,
          barsHeld: i - openPositionIndex
        });

        balance = trade.balanceAfter;
        trades.push(trade);
        equityCurve.push({ time: currentCandle.time, balance: round(balance) });

        if (trade.closeReason === 'stop_loss' || trade.netPnl <= 0) {
          cooldownRemaining = resolvedOptions.cooldownCandles;
        }

        openPosition = null;
        openPositionIndex = -1;
      }
    }

    if (openPosition && resolvedOptions.onePositionAtTime) {
      continue;
    }

    if (cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      continue;
    }

    if (!openPosition || !resolvedOptions.onePositionAtTime) {
      const maybeOpen = tryOpenPosition({
        visibleCandles,
        currentBalance: balance
      });

      if (maybeOpen && !openPosition) {
        openPosition = maybeOpen;
        openPositionIndex = i;
      }
    }
  }

  if (openPosition) {
    const lastCandle = sortedCandles[sortedCandles.length - 1];
    const trade = closePosition({
      symbol,
      position: openPosition,
      closeReason: 'forced_close',
      exitPrice: lastCandle.close,
      closedAt: lastCandle.time,
      balanceBeforeClose: balance,
      commissionRate: resolvedOptions.commissionRate,
      barsHeld: sortedCandles.length - 1 - openPositionIndex
    });
    balance = trade.balanceAfter;
    trades.push(trade);
    equityCurve.push({ time: lastCandle.time, balance: round(balance) });
  }

  const summary = buildSummary({
    symbol,
    trades,
    startBalance: resolvedOptions.startingBalance,
    endBalance: balance,
    equityCurve
  });

  return {
    symbol,
    options: resolvedOptions,
    trades,
    summary,
    equityCurve
  };
}
