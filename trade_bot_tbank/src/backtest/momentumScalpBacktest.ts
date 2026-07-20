import {
  Candle,
  ScalpPosition,
  ScalpParams,
  analyzeMomentumScalp,
  buildScalpPositionFromSignal,
  evaluateScalpExit
} from '../services/momentumScalpStrategy';

export interface ScalpTrade {
  signalTime: number;
  entryTime: number;
  exitTime: number;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  size: number;
  grossPnl: number;
  commission: number;
  netPnl: number;
  pnlPct: number;
  barsHeld: number;
  exitReason: string;
}

export interface RejectStat {
  reason: string;
  count: number;
}

export interface ScalpBacktestResult {
  trades: ScalpTrade[];
  equity: number[];
  timestamps: number[];
  finalBalance: number;
  totalReturn: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  avgTrade: number;
  avgBars: number;
  totalTrades: number;
  grossProfit: number;
  grossLoss: number;
  commissionTotal: number;
  rejectsByReason: Record<string, number>;
  rejectStats: RejectStat[];
}

function calcTradeGrossPnl(
  side: 'long' | 'short',
  entryPrice: number,
  exitPrice: number,
  size: number
): number {
  if (side === 'long') {
    return (exitPrice - entryPrice) * size;
  }

  return (entryPrice - exitPrice) * size;
}

function calcTradeCommission(
  entryPrice: number,
  exitPrice: number,
  size: number,
  commissionRate: number
): number {
  const turnover = entryPrice * size + exitPrice * size;
  return turnover * commissionRate;
}

export function runMomentumScalpBacktest(
  candles: Candle[],
  params: ScalpParams,
  startingBalance: number = 50000
): ScalpBacktestResult {
  const trades: ScalpTrade[] = [];
  const rejectsByReason: Record<string, number> = {};

  let balance = startingBalance;
  const equity: number[] = [balance];
  const timestamps: number[] = [candles[0]?.time || 0];

  let position: ScalpPosition | null = null;
  let lastTradeExitIndex = -params.cooldownBars - 1;

  let maxEquity = balance;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let commissionTotal = 0;

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    timestamps.push(candle.time);

    if (position && i >= position.entryIndex) {
      const exit = evaluateScalpExit(position, candle, i, params);

      if (exit.exit && exit.exitPrice !== null) {
        const grossPnl = calcTradeGrossPnl(
          position.side,
          position.entryPrice,
          exit.exitPrice,
          position.size
        );

        const commission = calcTradeCommission(
          position.entryPrice,
          exit.exitPrice,
          position.size,
          params.commissionRate
        );

        const netPnl = grossPnl - commission;
        const pnlPct = balance > 0 ? (netPnl / balance) * 100 : 0;

        if (netPnl >= 0) {
          grossProfit += netPnl;
        } else {
          grossLoss += Math.abs(netPnl);
        }

        commissionTotal += commission;
        balance += netPnl;

        trades.push({
          signalTime: position.signalTime,
          entryTime: position.entryTime,
          exitTime: candle.time,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: exit.exitPrice,
          size: position.size,
          grossPnl,
          commission,
          netPnl,
          pnlPct,
          barsHeld: i - position.entryIndex + 1,
          exitReason: exit.reason || 'unknown'
        });

        lastTradeExitIndex = i;
        position = null;
      }
    }

    const canSearchEntry =
      !position &&
      i < candles.length - 1 &&
      i - lastTradeExitIndex > params.cooldownBars &&
      balance > 0;

    if (canSearchEntry) {
      const signal = analyzeMomentumScalp(candles, i, params);

      if (signal.side === 'long' || signal.side === 'short') {
        const nextCandle = candles[i + 1];

        const newPosition = buildScalpPositionFromSignal(
          signal,
          nextCandle,
          params,
          balance,
          i + 1
        );

        if (newPosition) {
          position = newPosition;
        } else {
          rejectsByReason.position_build_failed =
            (rejectsByReason.position_build_failed || 0) + 1;
        }
      } else {
        const reason = signal.reason || 'unknown_reject';
        rejectsByReason[reason] = (rejectsByReason[reason] || 0) + 1;
      }
    }

    equity.push(balance);

    if (balance > maxEquity) {
      maxEquity = balance;
    }

    const drawdown = maxEquity - balance;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  if (position) {
    const lastCandle = candles[candles.length - 1];
    const forcedExitPrice =
      position.side === 'long'
        ? lastCandle.close * (1 - params.slippageRate)
        : lastCandle.close * (1 + params.slippageRate);

    const grossPnl = calcTradeGrossPnl(
      position.side,
      position.entryPrice,
      forcedExitPrice,
      position.size
    );

    const commission = calcTradeCommission(
      position.entryPrice,
      forcedExitPrice,
      position.size,
      params.commissionRate
    );

    const netPnl = grossPnl - commission;
    const pnlPct = balance > 0 ? (netPnl / balance) * 100 : 0;

    if (netPnl >= 0) {
      grossProfit += netPnl;
    } else {
      grossLoss += Math.abs(netPnl);
    }

    commissionTotal += commission;
    balance += netPnl;

    trades.push({
      signalTime: position.signalTime,
      entryTime: position.entryTime,
      exitTime: lastCandle.time,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: forcedExitPrice,
      size: position.size,
      grossPnl,
      commission,
      netPnl,
      pnlPct,
      barsHeld: candles.length - position.entryIndex,
      exitReason: 'end_of_data'
    });

    equity[equity.length - 1] = balance;
  }

  const totalTrades = trades.length;
  const winningTrades = trades.filter((t: ScalpTrade) => t.netPnl > 0);
  const winRate = totalTrades > 0 ? winningTrades.length / totalTrades : 0;

  const profitFactor =
    grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? Infinity
        : 0;

  const avgTrade =
    totalTrades > 0
      ? trades.reduce((sum: number, t: ScalpTrade) => sum + t.netPnl, 0) / totalTrades
      : 0;

  const avgBars =
    totalTrades > 0
      ? trades.reduce((sum: number, t: ScalpTrade) => sum + t.barsHeld, 0) / totalTrades
      : 0;

  const rejectStats: RejectStat[] = Object.entries(rejectsByReason)
    .map(([reason, count]: [string, number]) => ({ reason, count }))
    .sort((a: RejectStat, b: RejectStat) => b.count - a.count);

  return {
    trades,
    equity,
    timestamps,
    finalBalance: balance,
    totalReturn: ((balance - startingBalance) / startingBalance) * 100,
    winRate,
    profitFactor,
    maxDrawdown,
    avgTrade,
    avgBars,
    totalTrades,
    grossProfit,
    grossLoss,
    commissionTotal,
    rejectsByReason,
    rejectStats
  };
}
