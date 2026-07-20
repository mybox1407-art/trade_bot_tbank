import { Candle, ScalpPosition, ScalpParams, analyzeMomentumScalp, buildScalpPosition, evaluateScalpExit } from '../services/momentumScalpStrategy';

export interface ScalpTrade {
  entryTime: number;
  exitTime: number;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  barsHeld: number;
  exitReason: string;
  size: number;
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
}

export function runMomentumScalpBacktest(
  candles: Candle[],
  params: ScalpParams,
  startingBalance: number = 50000
): ScalpBacktestResult {
  const trades: ScalpTrade[] = [];
  let balance = startingBalance;
  const equity: number[] = [balance];
  const timestamps: number[] = [candles[0]?.time || 0];
  let position: ScalpPosition | null = null;
  let lastTradeIndex = -params.cooldownBars - 1;
  let maxEquity = balance;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let commissionTotal = 0;

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    timestamps.push(candle.time);

    if (position) {
      const exit = evaluateScalpExit(position, candle, i);
      if (exit.exit && exit.exitPrice !== null) {
        const rawPnl = position.side === 'long'
          ? (exit.exitPrice - position.entryPrice) * position.size
          : (position.entryPrice - exit.exitPrice) * position.size;

        const commission = (position.entryPrice * position.size + exit.exitPrice * position.size) * params.commissionRate;
        commissionTotal += commission;
        const pnl = rawPnl - commission;
        const pnlPct = (pnl / balance) * 100;

        if (pnl > 0) grossProfit += pnl;
        else grossLoss += Math.abs(pnl);

        balance += pnl;
        trades.push({
          entryTime: position.entryTime,
          exitTime: candle.time,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: exit.exitPrice,
          pnl,
          pnlPct,
          barsHeld: i - position.entryIndex,
          exitReason: exit.reason || 'unknown',
          size: position.size,
        });

        lastTradeIndex = i;
        position = null;
      }
    }

    if (!position && i - lastTradeIndex > params.cooldownBars) {
      const signal = analyzeMomentumScalp(candles, i, params);
      if (signal.side === 'long' || signal.side === 'short') {
        const pos = buildScalpPosition(signal, params, balance);
        pos.entryIndex = i;
        position = pos;
      }
    }

    equity.push(balance);
    if (balance > maxEquity) maxEquity = balance;
    const dd = maxEquity - balance;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  if (position) {
    const lastCandle = candles[candles.length - 1];
    const rawPnl = position.side === 'long'
      ? (lastCandle.close - position.entryPrice) * position.size
      : (position.entryPrice - lastCandle.close) * position.size;
    const commission = (position.entryPrice * position.size + lastCandle.close * position.size) * params.commissionRate;
    commissionTotal += commission;
    const pnl = rawPnl - commission;
    if (pnl > 0) grossProfit += pnl;
    else grossLoss += Math.abs(pnl);
    balance += pnl;
    trades.push({
      entryTime: position.entryTime,
      exitTime: lastCandle.time,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: lastCandle.close,
      pnl,
      pnlPct: (pnl / startingBalance) * 100,
      barsHeld: candles.length - 1 - position.entryIndex,
      exitReason: 'end_of_data',
      size: position.size,
    });
    equity[equity.length - 1] = balance;
  }

  const winningTrades = trades.filter((t: ScalpTrade) => t.pnl > 0);
  const totalTrades = trades.length;
  const winRate = totalTrades === 0 ? 0 : winningTrades.length / totalTrades;
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss;
  const avgTrade = totalTrades === 0 ? 0 : trades.reduce((s: number, t: ScalpTrade) => s + t.pnl, 0) / totalTrades;
  const avgBars = totalTrades === 0 ? 0 : trades.reduce((s: number, t: ScalpTrade) => s + t.barsHeld, 0) / totalTrades;

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
  };
}
