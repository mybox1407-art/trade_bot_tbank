import { analyzeMarket, Candle, STARTING_BALANCE, HtfFilterOptions } from './strategy';

export interface BacktestTrade {
  openedAt: number;
  closedAt: number;
  side: 'long' | 'short';
  entry: number;
  exit: number;
  qty: number;
  bars: number;
  reason: string;
  pnl: number;
  comm: number;
}

export interface BacktestOptions {
  cooldownCandles?: number;
  runnerTrailR?: number;
  htfFilter?: HtfFilterOptions;
  timeStopBars?: number;
  earlyAbortBars?: number;
  earlyAbortMinR?: number;
  maxTradesPerDay?: number;
}

export interface BacktestResult {
  symbol?: string;
  trades: BacktestTrade[];
  startBalance: number;
  endBalance: number;
  netProfit: number;
  returnPct: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  grossProfit: number;
  grossLoss: number;
}

type Position = {
  openedAt: number;
  entry: number;
  side: 'long' | 'short';
  qty: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp1Fraction: number;
  initialR: number;
  bars: number;
  tp1Taken: boolean;
  stopMoved: boolean;
};

function round(v: number) {
  return Math.round(v * 100) / 100;
}

function comm(notional: number) {
  return notional * 0.0005;
}

function isNewDay(a: number, b: number) {
  return new Date(a).toISOString().slice(0, 10) !== new Date(b).toISOString().slice(0, 10);
}

export function runBacktest(candles: Candle[], symbol = '', options: BacktestOptions = {}): BacktestResult {
  const cooldownCandles = options.cooldownCandles ?? 12;
  const timeStopBars = options.timeStopBars ?? 64;
  const earlyAbortBars = options.earlyAbortBars ?? 16;
  const earlyAbortMinR = options.earlyAbortMinR ?? 0.35;
  const maxTradesPerDay = options.maxTradesPerDay ?? 0;
  const htfFilter = options.htfFilter ?? { enabled: false };

  let balance = STARTING_BALANCE;
  let peak = STARTING_BALANCE;
  let maxDrawdown = 0;
  let cooldown = 0;
  let tradesToday = 0;
  let pos: Position | null = null;
  const trades: BacktestTrade[] = [];

  let grossProfit = 0;
  let grossLoss = 0;

  const closePos = (i: number, price: number, reason: string) => {
    if (!pos) return;
    const ts = candles[i].time;
    const entryNotional = pos.entry * pos.qty;
    const exitNotional = price * pos.qty;
    const c = comm(entryNotional) + comm(exitNotional);
    const pnl = pos.side === 'long'
      ? (price - pos.entry) * pos.qty - c
      : (pos.entry - price) * pos.qty - c;

    balance += pnl;
    peak = Math.max(peak, balance);
    maxDrawdown = Math.max(maxDrawdown, peak - balance);

    if (pnl >= 0) grossProfit += pnl;
    else grossLoss += pnl;

    trades.push({
      openedAt: pos.openedAt,
      closedAt: ts,
      side: pos.side,
      entry: round(pos.entry),
      exit: round(price),
      qty: pos.qty,
      bars: pos.bars,
      reason,
      pnl: round(pnl),
      comm: round(c)
    });

    pos = null;
    cooldown = cooldownCandles;
  };

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    if (i === 0 || isNewDay(candles[i - 1].time, candle.time)) {
      tradesToday = 0;
    }

    if (pos) {
      pos.bars += 1;
      const high = candle.high;
      const low = candle.low;

      if (pos.side === 'long') {
        if (low <= pos.stop) {
          closePos(i, pos.stop, 'stop_loss');
          continue;
        }

        if (!pos.tp1Taken && high >= pos.tp1) {
          const qty1 = Math.floor(pos.qty * pos.tp1Fraction);
          const qty2 = pos.qty - qty1;
          const c = comm(pos.entry * qty1) + comm(pos.tp1 * qty1);
          const pnl = (pos.tp1 - pos.entry) * qty1 - c;

          balance += pnl;
          if (pnl >= 0) grossProfit += pnl;
          else grossLoss += pnl;

          trades.push({
            openedAt: pos.openedAt,
            closedAt: candle.time,
            side: pos.side,
            entry: round(pos.entry),
            exit: round(pos.tp1),
            qty: qty1,
            bars: pos.bars,
            reason: 'take_profit_1',
            pnl: round(pnl),
            comm: round(c)
          });

          pos.qty = qty2;
          pos.tp1Taken = true;

          if (qty2 <= 0) {
            pos = null;
            cooldown = cooldownCandles;
            continue;
          }

          pos.stop = pos.entry;
          pos.stopMoved = true;
        }

        if (high >= pos.tp2) {
          closePos(i, pos.tp2, 'take_profit_2');
          continue;
        }
      } else {
        if (high >= pos.stop) {
          closePos(i, pos.stop, 'stop_loss');
          continue;
        }

        if (!pos.tp1Taken && low <= pos.tp1) {
          const qty1 = Math.floor(pos.qty * pos.tp1Fraction);
          const qty2 = pos.qty - qty1;
          const c = comm(pos.entry * qty1) + comm(pos.tp1 * qty1);
          const pnl = (pos.entry - pos.tp1) * qty1 - c;

          balance += pnl;
          if (pnl >= 0) grossProfit += pnl;
          else grossLoss += pnl;

          trades.push({
            openedAt: pos.openedAt,
            closedAt: candle.time,
            side: pos.side,
            entry: round(pos.entry),
            exit: round(pos.tp1),
            qty: qty1,
            bars: pos.bars,
            reason: 'take_profit_1',
            pnl: round(pnl),
            comm: round(c)
          });

          pos.qty = qty2;
          pos.tp1Taken = true;

          if (qty2 <= 0) {
            pos = null;
            cooldown = cooldownCandles;
            continue;
          }

          pos.stop = pos.entry;
          pos.stopMoved = true;
        }

        if (low <= pos.tp2) {
          closePos(i, pos.tp2, 'take_profit_2');
          continue;
        }
      }

      if (pos) {
        if (!pos.tp1Taken && pos.bars >= earlyAbortBars) {
          const unrealR = pos.side === 'long'
            ? (candle.close - pos.entry) / pos.initialR
            : (pos.entry - candle.close) / pos.initialR;

          if (unrealR < earlyAbortMinR) {
            closePos(i, candle.close, 'early_abort');
            continue;
          }
        }

        if (pos.bars >= timeStopBars) {
          closePos(i, candle.close, 'time_stop');
          continue;
        }
      }
    }

    if (cooldown > 0) {
      cooldown -= 1;
      continue;
    }

    if (pos) continue;

    const signal = analyzeMarket(candles.slice(0, i + 1), balance, htfFilter);
    if (
      signal.side === 'none' ||
      signal.quantity == null ||
      signal.stopLossPrice == null ||
      signal.takeProfit1Price == null ||
      signal.takeProfit2Price == null
    ) {
      continue;
    }

    if (maxTradesPerDay > 0 && tradesToday >= maxTradesPerDay) {
      continue;
    }

    pos = {
      openedAt: candle.time,
      entry: signal.price,
      side: signal.side,
      qty: signal.quantity,
      stop: signal.stopLossPrice,
      tp1: signal.takeProfit1Price,
      tp2: signal.takeProfit2Price,
      tp1Fraction: signal.tp1Fraction,
      initialR: signal.initialR ?? Math.abs(signal.price - signal.stopLossPrice),
      bars: 0,
      tp1Taken: false,
      stopMoved: false
    };

    tradesToday += 1;
  }

  if (pos) {
    closePos(candles.length - 1, candles[candles.length - 1].close, 'forced_close');
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = trades.length ? wins / trades.length : 0;
  const profitFactor = grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : 0;

  return {
    symbol,
    trades,
    startBalance: STARTING_BALANCE,
    endBalance: balance,
    netProfit: totalPnL,
    returnPct: STARTING_BALANCE ? totalPnL / STARTING_BALANCE : 0,
    winRate,
    profitFactor,
    maxDrawdown,
    grossProfit,
    grossLoss
  };
}
