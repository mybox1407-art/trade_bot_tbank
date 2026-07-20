import {
  Candle,
  DEFAULT_SCALP_V2_PARAMS,
  EntryRejectReason,
  MomentumScalpSignalV2,
  MomentumScalpV2Params,
  aggregateCandlesTo5m,
  build1mIndicators,
  build5mIndicators,
  evaluateMomentumScalpEntryV2,
  floorToStep
} from '../services/momentumScalpStrategyV2';

export type ExitReason = 'stop_loss' | 'take_profit' | 'time_stop' | 'end_of_data';

export interface RejectStat {
  reason: EntryRejectReason;
  count: number;
}

export interface ScalpTradeV2 {
  side: 'long' | 'short';
  signalTime: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  size: number;
  grossPnl: number;
  commission: number;
  netPnl: number;
  pnlPct: number;
  barsHeld: number;
  exitReason: ExitReason;
  atr1m: number;
  atr5m: number;
  volumeRatio: number;
  pullbackPct: number;
  impulseBodyPct: number;
}

interface OpenPosition {
  signal: MomentumScalpSignalV2;
  size: number;
  entryCommission: number;
  openedAtIndex: number;
}

export interface ScalpBacktestResultV2 {
  finalBalance: number;
  totalReturn: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  avgTrade: number;
  avgBars: number;
  grossProfit: number;
  grossLoss: number;
  commissionTotal: number;
  equity: number[];
  trades: ScalpTradeV2[];
  rejectStats: RejectStat[];
}

export interface BacktestOptionsV2 {
  startingBalance?: number;
  lotStep?: number;
  minQty?: number;
  allowLongs?: boolean;
  allowShorts?: boolean;
}

export function runMomentumScalpBacktestV2(
  candles1m: Candle[],
  params: MomentumScalpV2Params = DEFAULT_SCALP_V2_PARAMS,
  options: BacktestOptionsV2 = {}
): ScalpBacktestResultV2 {
  const startingBalance = options.startingBalance ?? 50000;
  const lotStep = options.lotStep ?? 0.0001;
  const minQty = options.minQty ?? 1;
  const allowLongs = options.allowLongs ?? true;
  const allowShorts = options.allowShorts ?? true;

  const candles5m = aggregateCandlesTo5m(candles1m);
  const indicators1m = build1mIndicators(candles1m, params);
  const indicators5m = build5mIndicators(candles5m, params);

  let balance = startingBalance;
  const equity: number[] = [startingBalance];
  const trades: ScalpTradeV2[] = [];
  const rejectMap = new Map<EntryRejectReason, number>();

  let openPosition: OpenPosition | null = null;
  let cooldownUntilIndex = -1;
  let peakEquity = startingBalance;
  let maxDrawdown = 0;

  function addReject(reason: EntryRejectReason) {
    rejectMap.set(reason, (rejectMap.get(reason) ?? 0) + 1);
  }

  function updateEquity(markToMarketValue?: number) {
    const currentEquity = markToMarketValue ?? balance;
    equity.push(currentEquity);
    if (currentEquity > peakEquity) {
      peakEquity = currentEquity;
    }
    const dd = peakEquity - currentEquity;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
    }
  }

  function buildPosition(signal: MomentumScalpSignalV2): OpenPosition | null {
    const riskCapital = balance * Math.min(params.riskPerTrade, params.maxRiskPerTrade);
    if (riskCapital <= 0 || signal.riskDistance <= 0 || signal.entryPrice <= 0) {
      return null;
    }

    const rawQty = riskCapital / signal.riskDistance;
    let qty = floorToStep(rawQty, lotStep);

    const maxNotional = balance * params.maxPositionNotionalPct;
    const maxQtyByNotional = floorToStep(maxNotional / signal.entryPrice, lotStep);

    qty = Math.min(qty, maxQtyByNotional);

    if (qty < minQty) {
      return null;
    }

    const entryCommission = qty * signal.entryPrice * params.commissionRate;

    return {
      signal,
      size: qty,
      entryCommission,
      openedAtIndex: signal.entryIndex
    };
  }

  function closePosition(pos: OpenPosition, exitIndex: number, exitPrice: number, exitReason: ExitReason) {
    const exitCandle = candles1m[exitIndex];
    const size = pos.size;
    const entryPrice = pos.signal.entryPrice;

    let grossPnl = 0;
    if (pos.signal.side === 'long') {
      grossPnl = (exitPrice - entryPrice) * size;
    } else {
      grossPnl = (entryPrice - exitPrice) * size;
    }

    const exitCommission = size * exitPrice * params.commissionRate;
    const totalCommission = pos.entryCommission + exitCommission;
    const netPnl = grossPnl - totalCommission;

    balance += netPnl;

    trades.push({
      side: pos.signal.side,
      signalTime: pos.signal.signalTime,
      entryTime: pos.signal.entryTime,
      exitTime: exitCandle.time,
      entryPrice,
      exitPrice,
      stopLossPrice: pos.signal.stopLossPrice,
      takeProfitPrice: pos.signal.takeProfitPrice,
      size,
      grossPnl,
      commission: totalCommission,
      netPnl,
      pnlPct: (netPnl / startingBalance) * 100,
      barsHeld: exitIndex - pos.openedAtIndex + 1,
      exitReason,
      atr1m: pos.signal.atr1m,
      atr5m: pos.signal.atr5m,
      volumeRatio: pos.signal.volumeRatio,
      pullbackPct: pos.signal.pullbackPct,
      impulseBodyPct: pos.signal.impulseBodyPct
    });

    cooldownUntilIndex = exitIndex + params.cooldownBars;
    openPosition = null;
    updateEquity();
  }

  for (let i = 0; i < candles1m.length; i++) {
    const candle = candles1m[i];

    if (openPosition) {
      const pos = openPosition;
      const sig = pos.signal;

      if (sig.side === 'long') {
        const stopHit = candle.low <= sig.stopLossPrice;
        const tpHit = candle.high >= sig.takeProfitPrice;

        if (stopHit && tpHit) {
          closePosition(pos, i, sig.stopLossPrice, 'stop_loss');
          continue;
        }
        if (stopHit) {
          closePosition(pos, i, sig.stopLossPrice, 'stop_loss');
          continue;
        }
        if (tpHit) {
          closePosition(pos, i, sig.takeProfitPrice, 'take_profit');
          continue;
        }
      } else {
        const stopHit = candle.high >= sig.stopLossPrice;
        const tpHit = candle.low <= sig.takeProfitPrice;

        if (stopHit && tpHit) {
          closePosition(pos, i, sig.stopLossPrice, 'stop_loss');
          continue;
        }
        if (stopHit) {
          closePosition(pos, i, sig.stopLossPrice, 'stop_loss');
          continue;
        }
        if (tpHit) {
          closePosition(pos, i, sig.takeProfitPrice, 'take_profit');
          continue;
        }
      }

      const barsHeld = i - pos.openedAtIndex + 1;
      if (barsHeld >= params.timeStopBars) {
        let exitPrice = candle.close;
        if (sig.side === 'long') {
          exitPrice = candle.close * (1 - params.slippageRate);
        } else {
          exitPrice = candle.close * (1 + params.slippageRate);
        }
        closePosition(pos, i, exitPrice, 'time_stop');
        continue;
      }

      let markPrice = candle.close;
      let openGross = 0;
      if (sig.side === 'long') {
        markPrice = candle.close * (1 - params.slippageRate);
        openGross = (markPrice - sig.entryPrice) * pos.size;
      } else {
        markPrice = candle.close * (1 + params.slippageRate);
        openGross = (sig.entryPrice - markPrice) * pos.size;
      }
      updateEquity(balance + openGross - pos.entryCommission);
      continue;
    }

    if (i <= cooldownUntilIndex) {
      updateEquity();
      continue;
    }

    const decision = evaluateMomentumScalpEntryV2(
      candles1m,
      indicators1m,
      candles5m,
      indicators5m,
      i,
      params
    );

    if (!decision.accepted || !decision.signal) {
      if (decision.reason) addReject(decision.reason);
      updateEquity();
      continue;
    }

    if (decision.signal.side === 'long' && !allowLongs) {
      updateEquity();
      continue;
    }

    if (decision.signal.side === 'short' && !allowShorts) {
      updateEquity();
      continue;
    }

    const pos = buildPosition(decision.signal);
    if (!pos) {
      updateEquity();
      continue;
    }

    openPosition = pos;
    updateEquity();
  }

  if (openPosition) {
    const lastIndex = candles1m.length - 1;
    const lastCandle = candles1m[lastIndex];
    const exitPrice =
      openPosition.signal.side === 'long'
        ? lastCandle.close * (1 - params.slippageRate)
        : lastCandle.close * (1 + params.slippageRate);
    closePosition(openPosition, lastIndex, exitPrice, 'end_of_data');
  }

  const grossProfit = trades.filter(t => t.grossPnl > 0).reduce((s, t) => s + t.grossPnl, 0);
  const grossLossAbs = Math.abs(trades.filter(t => t.grossPnl < 0).reduce((s, t) => s + t.grossPnl, 0));
  const netSum = trades.reduce((s, t) => s + t.netPnl, 0);
  const wins = trades.filter(t => t.netPnl > 0).length;
  const commissionTotal = trades.reduce((s, t) => s + t.commission, 0);
  const avgBars = trades.length > 0 ? trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length : 0;

  const rejectStats: RejectStat[] = Array.from(rejectMap.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    finalBalance: balance,
    totalReturn: ((balance - startingBalance) / startingBalance) * 100,
    totalTrades: trades.length,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    profitFactor: grossLossAbs > 0 ? grossProfit / grossLossAbs : 0,
    maxDrawdown,
    avgTrade: trades.length > 0 ? netSum / trades.length : 0,
    avgBars,
    grossProfit,
    grossLoss: grossLossAbs,
    commissionTotal,
    equity,
    trades,
    rejectStats
  };
}
