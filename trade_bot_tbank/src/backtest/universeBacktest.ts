import {
  Candle,
  PARTIAL_LOCK_R,
  STARTING_BALANCE,
  TP1_FRACTION
} from '../services/strategy';
import {
  pickBestUniverseSignal,
  rankUniverseCandidates,
  UniverseSignal
} from '../services/universeStrategy';

export interface UniverseBacktestOptions {
  startingBalance?: number;
  commissionRate?: number;
  warmupCandles?: number;
  cooldownCandles?: number;
  progressLogEvery?: number;
  timeStopBars?: number;
  earlyAbortBars?: number;
  earlyAbortMinR?: number;
  runnerTrailR?: number;
  minScore?: number;
  onePositionAtTime?: boolean;
}

interface OpenUniversePosition {
  symbol: string;
  side: 'long' | 'short';
  regime: string;
  openedAt: number;
  entryPrice: number;
  stopLossPrice: number;
  initialStopLossPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  quantity: number;
  initialQuantity: number;
  positionSize: number;
  balanceBefore: number;
  initialR: number;
  tp1Done: boolean;
  tp1Fraction: number;
  openIndex: number;
}

export interface UniverseBacktestTrade {
  symbol: string;
  side: 'long' | 'short';
  regime: string;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  quantity: number;
  positionSize: number;
  closeReason:
    | 'stop_loss'
    | 'take_profit_1'
    | 'take_profit_2'
    | 'forced_close'
    | 'time_stop'
    | 'early_abort'
    | 'breakeven'
    | 'trail_stop';
  grossPnl: number;
  commissionOpen: number;
  commissionClose: number;
  totalCommission: number;
  netPnl: number;
  balanceBefore: number;
  balanceAfter: number;
  barsHeld: number;
  leg: 'partial' | 'full';
}

export interface UniverseBacktestSummary {
  universe: string[];
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
  monthsCount: number;
  avgMonthlyReturnPct: number;
}

export interface UniverseRegimeStats {
  totalBars: number;
  barsByRegime: Record<string, { bars: number; pct: number }>;
  tradesByRegime: Record<
    string,
    {
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
  >;
  closeReasonsAll: Record<string, number>;
}

export interface UniverseSelectionStats {
  totalDecisionBars: number;
  noSignalBars: number;
  pickedBySymbol: Record<string, number>;
  pickedBySide: Record<string, number>;
  topScores: Array<{
    time: number;
    symbol: string;
    score: number;
    side: 'long' | 'short';
    regime: string;
  }>;
}

export interface UniverseBacktestResult {
  options: Required<UniverseBacktestOptions>;
  summary: UniverseBacktestSummary;
  trades: UniverseBacktestTrade[];
  equityCurve: Array<{ time: number; balance: number }>;
  regimeStats: UniverseRegimeStats;
  selectionStats: UniverseSelectionStats;
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

function utcDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function utcMonthKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

function inc(map: Record<string, number>, key: string, n = 1): void {
  map[key] = (map[key] ?? 0) + n;
}

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function stopReasonAfterTp1(
  position: OpenUniversePosition
): 'breakeven' | 'trail_stop' {
  const lockDist = position.initialR * PARTIAL_LOCK_R;
  const moved = Math.abs(position.stopLossPrice - position.entryPrice);
  if (lockDist <= 1e-12) return 'breakeven';
  return moved > lockDist * 1.15 ? 'trail_stop' : 'breakeven';
}

function updateRunnerTrail(params: {
  position: OpenUniversePosition;
  candle: Candle;
  trailR: number;
}): void {
  const { position, candle, trailR } = params;
  if (!position.tp1Done || trailR <= 0) return;

  const r = position.initialR;
  if (r <= 0) return;
  const lock = r * PARTIAL_LOCK_R;

  if (position.side === 'long') {
    const floor = position.entryPrice + lock;
    const next = Math.max(floor, candle.high - trailR * r);
    if (next > position.stopLossPrice) position.stopLossPrice = next;
  } else {
    const ceiling = position.entryPrice - lock;
    const next = Math.min(ceiling, candle.low + trailR * r);
    if (next < position.stopLossPrice) position.stopLossPrice = next;
  }
}

function buildTrade(params: {
  position: OpenUniversePosition;
  qty: number;
  exitPrice: number;
  closedAt: number;
  closeReason: UniverseBacktestTrade['closeReason'];
  balanceBeforeClose: number;
  commissionRate: number;
  barsHeld: number;
  leg: 'partial' | 'full';
  chargeOpenCommission: boolean;
}): UniverseBacktestTrade {
  const {
    position,
    qty,
    exitPrice,
    closedAt,
    closeReason,
    balanceBeforeClose,
    commissionRate,
    barsHeld,
    leg,
    chargeOpenCommission
  } = params;

  const commissionOpen = chargeOpenCommission
    ? getCommission(position.entryPrice * qty, commissionRate)
    : 0;
  const commissionClose = getCommission(exitPrice * qty, commissionRate);
  const totalCommission = commissionOpen + commissionClose;
  const grossPnl = getGrossPnl({
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: qty
  });
  const netPnl = grossPnl - totalCommission;

  return {
    symbol: position.symbol,
    side: position.side,
    regime: position.regime,
    openedAt: position.openedAt,
    closedAt,
    entryPrice: round(position.entryPrice),
    exitPrice: round(exitPrice),
    stopLossPrice: round(position.stopLossPrice),
    takeProfitPrice: round(
      leg === 'partial' ? position.takeProfit1Price : position.takeProfit2Price
    ),
    quantity: round(qty, 12),
    positionSize: round(position.entryPrice * qty, 8),
    closeReason,
    grossPnl: round(grossPnl),
    commissionOpen: round(commissionOpen),
    commissionClose: round(commissionClose),
    totalCommission: round(totalCommission),
    netPnl: round(netPnl),
    balanceBefore: round(position.balanceBefore),
    balanceAfter: round(balanceBeforeClose + netPnl),
    barsHeld,
    leg
  };
}

function processExitsOnCandle(params: {
  position: OpenUniversePosition;
  candle: Candle;
  balance: number;
  commissionRate: number;
  barsHeld: number;
  openCommissionRemaining: boolean;
}): {
  trades: UniverseBacktestTrade[];
  balance: number;
  stillOpen: boolean;
  openCommissionRemaining: boolean;
} {
  const { position, candle, commissionRate, barsHeld } = params;
  let { balance, openCommissionRemaining } = params;
  const trades: UniverseBacktestTrade[] = [];

  const hitStop =
    position.side === 'long'
      ? candle.low <= position.stopLossPrice
      : candle.high >= position.stopLossPrice;

  const hitTp1 =
    !position.tp1Done &&
    (position.side === 'long'
      ? candle.high >= position.takeProfit1Price
      : candle.low <= position.takeProfit1Price);

  const hitTp2 =
    position.side === 'long'
      ? candle.high >= position.takeProfit2Price
      : candle.low <= position.takeProfit2Price;

  if (hitStop && (hitTp1 || hitTp2)) {
    const reason = position.tp1Done ? stopReasonAfterTp1(position) : 'stop_loss';
    const t = buildTrade({
      position,
      qty: position.quantity,
      exitPrice: position.stopLossPrice,
      closedAt: candle.time,
      closeReason: reason,
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      leg: 'full',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t.balanceAfter;
    trades.push(t);
    position.quantity = 0;
    return { trades, balance, stillOpen: false, openCommissionRemaining: false };
  }

  if (hitTp1 && position.quantity > 1) {
    let qty1 = Math.floor(position.initialQuantity * position.tp1Fraction);
    qty1 = Math.max(1, Math.min(qty1, position.quantity - 1));

    const t1 = buildTrade({
      position,
      qty: qty1,
      exitPrice: position.takeProfit1Price,
      closedAt: candle.time,
      closeReason: 'take_profit_1',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      leg: 'partial',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t1.balanceAfter;
    trades.push(t1);
    openCommissionRemaining = false;
    position.quantity -= qty1;
    position.tp1Done = true;

    const lock = position.initialR * PARTIAL_LOCK_R;
    if (position.side === 'long') {
      position.stopLossPrice = Math.max(
        position.stopLossPrice,
        position.entryPrice + lock
      );
    } else {
      position.stopLossPrice = Math.min(
        position.stopLossPrice,
        position.entryPrice - lock
      );
    }
  }

  if (hitTp1 && !position.tp1Done && position.quantity === 1) {
    const t = buildTrade({
      position,
      qty: 1,
      exitPrice: position.takeProfit1Price,
      closedAt: candle.time,
      closeReason: 'take_profit_1',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      leg: 'full',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t.balanceAfter;
    trades.push(t);
    position.quantity = 0;
    return { trades, balance, stillOpen: false, openCommissionRemaining: false };
  }

  const hitStop2 =
    position.side === 'long'
      ? candle.low <= position.stopLossPrice
      : candle.high >= position.stopLossPrice;

  const hitTp2b =
    position.side === 'long'
      ? candle.high >= position.takeProfit2Price
      : candle.low <= position.takeProfit2Price;

  if (position.quantity > 0 && hitStop2 && hitTp2b) {
    const reason = position.tp1Done ? stopReasonAfterTp1(position) : 'stop_loss';
    const t = buildTrade({
      position,
      qty: position.quantity,
      exitPrice: position.stopLossPrice,
      closedAt: candle.time,
      closeReason: reason,
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      leg: 'full',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t.balanceAfter;
    trades.push(t);
    position.quantity = 0;
    return { trades, balance, stillOpen: false, openCommissionRemaining: false };
  }

  if (position.quantity > 0 && hitStop2) {
    const reason = position.tp1Done ? stopReasonAfterTp1(position) : 'stop_loss';
    const t = buildTrade({
      position,
      qty: position.quantity,
      exitPrice: position.stopLossPrice,
      closedAt: candle.time,
      closeReason: reason,
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      leg: 'full',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t.balanceAfter;
    trades.push(t);
    position.quantity = 0;
    return { trades, balance, stillOpen: false, openCommissionRemaining: false };
  }

  if (position.quantity > 0 && hitTp2b) {
    const t = buildTrade({
      position,
      qty: position.quantity,
      exitPrice: position.takeProfit2Price,
      closedAt: candle.time,
      closeReason: 'take_profit_2',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      leg: 'full',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t.balanceAfter;
    trades.push(t);
    position.quantity = 0;
    return { trades, balance, stillOpen: false, openCommissionRemaining: false };
  }

  return {
    trades,
    balance,
    stillOpen: position.quantity > 0,
    openCommissionRemaining
  };
}

function calculateDrawdown(
  equityCurve: Array<{ time: number; balance: number }>
) {
  let peak = equityCurve.length ? equityCurve[0].balance : 0;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;

  for (const point of equityCurve) {
    if (point.balance > peak) peak = point.balance;
    const d = peak - point.balance;
    const dp = peak > 0 ? d / peak : 0;
    if (d > maxDrawdownAbs) maxDrawdownAbs = d;
    if (dp > maxDrawdownPct) maxDrawdownPct = dp;
  }

  return {
    maxDrawdownAbs: round(maxDrawdownAbs),
    maxDrawdownPct: round(maxDrawdownPct, 6)
  };
}

function buildRegimeStats(
  trades: UniverseBacktestTrade[],
  barCounts: Record<string, number>
): UniverseRegimeStats {
  const totalBars = Object.values(barCounts).reduce((a, b) => a + b, 0);
  const barsByRegime: Record<string, { bars: number; pct: number }> = {};
  for (const [reg, bars] of Object.entries(barCounts)) {
    barsByRegime[reg] = {
      bars,
      pct: totalBars > 0 ? round(bars / totalBars, 6) : 0
    };
  }

  type Agg = {
    regime: string;
    net: number;
    barsMax: number;
    reasons: Record<string, number>;
  };

  const groups = new Map<string, Agg>();
  for (const t of trades) {
    const key = `${t.symbol}|${t.openedAt}|${t.side}|${t.entryPrice}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        regime: t.regime || 'unknown',
        net: 0,
        barsMax: 0,
        reasons: {}
      };
      groups.set(key, g);
    }
    g.net += t.netPnl;
    g.barsMax = Math.max(g.barsMax, t.barsHeld);
    inc(g.reasons, t.closeReason);
  }

  const tradesByRegime: UniverseRegimeStats['tradesByRegime'] = {};
  const closeReasonsAll: Record<string, number> = {};

  for (const g of groups.values()) {
    const reg = g.regime || 'unknown';
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
    bucket.netProfit += g.net;
    if (g.net > 0) {
      bucket.wins += 1;
      bucket.grossProfit += g.net;
    } else {
      bucket.losses += 1;
      bucket.grossLoss += g.net;
    }
    bucket.avgBarsHeld += g.barsMax;
    for (const [reason, n] of Object.entries(g.reasons)) {
      inc(bucket.closeReasons, reason, n);
      inc(closeReasonsAll, reason, n);
    }
  }

  for (const bucket of Object.values(tradesByRegime)) {
    const gl = Math.abs(bucket.grossLoss);
    bucket.winRate = bucket.trades > 0 ? round(bucket.wins / bucket.trades, 6) : 0;
    bucket.netProfit = round(bucket.netProfit);
    bucket.grossProfit = round(bucket.grossProfit);
    bucket.grossLoss = round(bucket.grossLoss);
    bucket.profitFactor =
      gl > 0 ? round(bucket.grossProfit / gl, 6) : bucket.grossProfit > 0 ? Infinity : 0;
    bucket.avgBarsHeld =
      bucket.trades > 0 ? round(bucket.avgBarsHeld / bucket.trades, 2) : 0;
  }

  return {
    totalBars,
    barsByRegime,
    tradesByRegime,
    closeReasonsAll
  };
}

function buildSummary(params: {
  universe: string[];
  trades: UniverseBacktestTrade[];
  startBalance: number;
  endBalance: number;
  equityCurve: Array<{ time: number; balance: number }>;
}): UniverseBacktestSummary {
  const { universe, trades, startBalance, endBalance, equityCurve } = params;
  const groups = new Map<string, number>();

  for (const t of trades) {
    const key = `${t.symbol}|${t.openedAt}|${t.side}|${t.entryPrice}`;
    groups.set(key, (groups.get(key) ?? 0) + t.netPnl);
  }

  const groupPnls = [...groups.values()];
  const wins = groupPnls.filter(p => p > 0);
  const losses = groupPnls.filter(p => p <= 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLossAbs = Math.abs(losses.reduce((a, b) => a + b, 0));
  const netProfit = groupPnls.reduce((a, b) => a + b, 0);
  const profitFactor =
    grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? Infinity : 0;
  const returnPct = startBalance > 0 ? (endBalance - startBalance) / startBalance : 0;
  const dd = calculateDrawdown(equityCurve);

  const months = new Set<string>();
  for (const p of equityCurve) months.add(utcMonthKey(p.time));
  const monthsCount = Math.max(months.size, 1);
  const avgMonthlyReturnPct = returnPct / monthsCount;

  return {
    universe,
    tradesCount: groupPnls.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(groupPnls.length ? wins.length / groupPnls.length : 0, 6),
    grossProfit: round(grossProfit),
    grossLoss: round(-grossLossAbs),
    netProfit: round(netProfit),
    avgNetPnl: round(groupPnls.length ? netProfit / groupPnls.length : 0),
    avgWin: round(wins.length ? grossProfit / wins.length : 0),
    avgLoss: round(
      losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0
    ),
    profitFactor: Number.isFinite(profitFactor)
      ? round(profitFactor, 6)
      : Infinity,
    startBalance: round(startBalance),
    endBalance: round(endBalance),
    returnPct: round(returnPct, 6),
    maxDrawdownAbs: dd.maxDrawdownAbs,
    maxDrawdownPct: dd.maxDrawdownPct,
    monthsCount,
    avgMonthlyReturnPct: round(avgMonthlyReturnPct, 6)
  };
}

function intersectTimes(
  candlesBySymbol: Record<string, Candle[]>
): number[] {
  const symbols = Object.keys(candlesBySymbol);
  if (!symbols.length) return [];

  const sets = symbols.map(symbol => new Set(candlesBySymbol[symbol].map(c => c.time)));
  const base = [...sets[0]].sort((a, b) => a - b);

  return base.filter(ts => sets.every(s => s.has(ts)));
}

function buildLookup(
  candlesBySymbol: Record<string, Candle[]>
): Record<string, Map<number, number>> {
  const out: Record<string, Map<number, number>> = {};
  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    out[symbol] = new Map<number, number>();
    candles.forEach((c, i) => out[symbol].set(c.time, i));
  }
  return out;
}

function buildVisibleSlices(
  candlesBySymbol: Record<string, Candle[]>,
  lookup: Record<string, Map<number, number>>,
  ts: number
): Record<string, Candle[]> {
  const out: Record<string, Candle[]> = {};
  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    const idx = lookup[symbol].get(ts);
    if (idx == null || idx < 0) continue;
    out[symbol] = candles.slice(0, idx + 1);
  }
  return out;
}

export function runUniverseBacktest(
  candlesBySymbol: Record<string, Candle[]>,
  options: UniverseBacktestOptions = {}
): UniverseBacktestResult {
  const resolvedOptions: Required<UniverseBacktestOptions> = {
    startingBalance: options.startingBalance ?? STARTING_BALANCE,
    commissionRate: options.commissionRate ?? 0.0005,
    warmupCandles: options.warmupCandles ?? 250,
    cooldownCandles: options.cooldownCandles ?? 12,
    progressLogEvery: options.progressLogEvery ?? 5000,
    timeStopBars: options.timeStopBars ?? 64,
    earlyAbortBars: options.earlyAbortBars ?? 16,
    earlyAbortMinR: options.earlyAbortMinR ?? 0.35,
    runnerTrailR: options.runnerTrailR ?? 0,
    minScore: options.minScore ?? 4.0,
    onePositionAtTime: options.onePositionAtTime ?? true
  };

  const symbols = Object.keys(candlesBySymbol).sort();
  if (!symbols.length) {
    return {
      options: resolvedOptions,
      summary: buildSummary({
        universe: [],
        trades: [],
        startBalance: resolvedOptions.startingBalance,
        endBalance: resolvedOptions.startingBalance,
        equityCurve: []
      }),
      trades: [],
      equityCurve: [],
      regimeStats: {
        totalBars: 0,
        barsByRegime: {},
        tradesByRegime: {},
        closeReasonsAll: {}
      },
      selectionStats: {
        totalDecisionBars: 0,
        noSignalBars: 0,
        pickedBySymbol: {},
        pickedBySide: {},
        topScores: []
      }
    };
  }

  const sortedBySymbol: Record<string, Candle[]> = {};
  for (const symbol of symbols) {
    sortedBySymbol[symbol] = [...candlesBySymbol[symbol]].sort((a, b) => a.time - b.time);
  }

  const timeAxis = intersectTimes(sortedBySymbol);
  const lookup = buildLookup(sortedBySymbol);

  let balance = resolvedOptions.startingBalance;
  let openPosition: OpenUniversePosition | null = null;
  let openCommissionRemaining = false;
  let cooldownRemaining = 0;
  const entriesPerDay = new Map<string, number>();
  const trades: UniverseBacktestTrade[] = [];
  const equityCurve: Array<{ time: number; balance: number }> = [];
  const barCounts: Record<string, number> = {};
  const selectionStats: UniverseSelectionStats = {
    totalDecisionBars: 0,
    noSignalBars: 0,
    pickedBySymbol: {},
    pickedBySide: {},
    topScores: []
  };

  if (timeAxis.length) {
    equityCurve.push({ time: timeAxis[0], balance: round(balance) });
  }

  const startedAt = Date.now();
  const totalBarsToProcess = Math.max(
    timeAxis.length - resolvedOptions.warmupCandles,
    0
  );

  for (let i = resolvedOptions.warmupCandles; i < timeAxis.length; i++) {
    const ts = timeAxis[i];
    const visibleBySymbol = buildVisibleSlices(sortedBySymbol, lookup, ts);

    for (const candles of Object.values(visibleBySymbol)) {
      const lastCandle = last(candles);
      if (!lastCandle) continue;
    }

    const ranked = rankUniverseCandidates(visibleBySymbol, balance, {
      minScore: resolvedOptions.minScore,
      warmupCandles: resolvedOptions.warmupCandles
    });

    const bestNow = ranked[0];
    selectionStats.totalDecisionBars += 1;

    if (!bestNow || bestNow.score < resolvedOptions.minScore) {
      selectionStats.noSignalBars += 1;
    } else {
      inc(selectionStats.pickedBySymbol, bestNow.symbol);
      inc(selectionStats.pickedBySide, bestNow.side);
      if (selectionStats.topScores.length < 1000) {
        selectionStats.topScores.push({
          time: ts,
          symbol: bestNow.symbol,
          score: bestNow.score,
          side: bestNow.side,
          regime: bestNow.regime
        });
      }
      inc(barCounts, bestNow.regime || 'unknown');
    }

    if (resolvedOptions.progressLogEvery > 0) {
      const processedBars = i - resolvedOptions.warmupCandles;
      const shouldLog =
        processedBars > 0 &&
        (processedBars % resolvedOptions.progressLogEvery === 0 ||
          i === timeAxis.length - 1);
      if (shouldLog) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const speed = processedBars / Math.max(elapsedSec, 1e-9);
        const remainingBars = Math.max(totalBarsToProcess - processedBars, 0);
        const etaSec = remainingBars / Math.max(speed, 1e-9);
        const progressPct =
          totalBarsToProcess > 0
            ? (processedBars / totalBarsToProcess) * 100
            : 100;
        console.log(
          [
            `[UNIVERSE]`,
            `Прогресс: ${processedBars}/${totalBarsToProcess}`,
            `${round(progressPct, 2)}%`,
            `Скорость: ${round(speed, 2)} бар/сек`,
            `ETA: ${formatDuration(etaSec)}`,
            `Сделок: ${trades.length}`,
            `Баланс: ${round(balance, 2)}`
          ].join(' | ')
        );
      }
    }

    if (openPosition) {
      const candle = last(visibleBySymbol[openPosition.symbol]);
      if (!candle) continue;

      const barsHeld = i - openPosition.openIndex;

      updateRunnerTrail({
        position: openPosition,
        candle,
        trailR: resolvedOptions.runnerTrailR
      });

      if (barsHeld >= resolvedOptions.timeStopBars) {
        const t = buildTrade({
          position: openPosition,
          qty: openPosition.quantity,
          exitPrice: candle.close,
          closedAt: candle.time,
          closeReason: 'time_stop',
          balanceBeforeClose: balance,
          commissionRate: resolvedOptions.commissionRate,
          barsHeld,
          leg: 'full',
          chargeOpenCommission: openCommissionRemaining
        });
        balance = t.balanceAfter;
        trades.push(t);
        equityCurve.push({ time: candle.time, balance: round(balance) });
        cooldownRemaining = resolvedOptions.cooldownCandles;
        openPosition = null;
        openCommissionRemaining = false;
      } else if (
        resolvedOptions.earlyAbortBars > 0 &&
        barsHeld >= resolvedOptions.earlyAbortBars &&
        !openPosition.tp1Done
      ) {
        const fav =
          openPosition.side === 'long'
            ? candle.close - openPosition.entryPrice
            : openPosition.entryPrice - candle.close;
        if (fav < resolvedOptions.earlyAbortMinR * openPosition.initialR) {
          const t = buildTrade({
            position: openPosition,
            qty: openPosition.quantity,
            exitPrice: candle.close,
            closedAt: candle.time,
            closeReason: 'early_abort',
            balanceBeforeClose: balance,
            commissionRate: resolvedOptions.commissionRate,
            barsHeld,
            leg: 'full',
            chargeOpenCommission: openCommissionRemaining
          });
          balance = t.balanceAfter;
          trades.push(t);
          equityCurve.push({ time: candle.time, balance: round(balance) });
          cooldownRemaining = resolvedOptions.cooldownCandles;
          openPosition = null;
          openCommissionRemaining = false;
        }
      }
    }

    if (openPosition) {
      const candle = last(visibleBySymbol[openPosition.symbol]);
      if (!candle) continue;

      const result = processExitsOnCandle({
        position: openPosition,
        candle,
        balance,
        commissionRate: resolvedOptions.commissionRate,
        barsHeld: i - openPosition.openIndex,
        openCommissionRemaining
      });
      balance = result.balance;
      openCommissionRemaining = result.openCommissionRemaining;
      for (const t of result.trades) {
        trades.push(t);
        equityCurve.push({ time: candle.time, balance: round(balance) });
      }

      if (!result.stillOpen) {
        cooldownRemaining = resolvedOptions.cooldownCandles;
        openPosition = null;
        openCommissionRemaining = false;
      }
    }

    if (openPosition && resolvedOptions.onePositionAtTime) continue;

    if (cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      continue;
    }

    const dayKey = utcDateKey(ts);
    const used = entriesPerDay.get(dayKey) ?? 0;
    if (used >= 1) continue;

    const bestSignal: UniverseSignal = pickBestUniverseSignal(visibleBySymbol, balance, {
      minScore: resolvedOptions.minScore,
      warmupCandles: resolvedOptions.warmupCandles
    });

    if (
      bestSignal.side !== 'none' &&
      bestSignal.quantity != null &&
      bestSignal.positionSize != null &&
      bestSignal.stopLossPrice != null &&
      bestSignal.takeProfit1Price != null &&
      bestSignal.takeProfit2Price != null &&
      bestSignal.initialR != null &&
      bestSignal.initialR > 0
    ) {
      openPosition = {
        symbol: bestSignal.symbol,
        side: bestSignal.side,
        regime: bestSignal.regime,
        openedAt: ts,
        entryPrice: bestSignal.price,
        stopLossPrice: bestSignal.stopLossPrice,
        initialStopLossPrice: bestSignal.stopLossPrice,
        takeProfit1Price: bestSignal.takeProfit1Price,
        takeProfit2Price: bestSignal.takeProfit2Price,
        quantity: bestSignal.quantity,
        initialQuantity: bestSignal.quantity,
        positionSize: bestSignal.positionSize,
        balanceBefore: balance,
        initialR: bestSignal.initialR,
        tp1Done: false,
        tp1Fraction: bestSignal.tp1Fraction ?? TP1_FRACTION,
        openIndex: i
      };
      openCommissionRemaining = true;
      entriesPerDay.set(dayKey, used + 1);
    }
  }

  if (openPosition) {
    const lastCandle = last(sortedBySymbol[openPosition.symbol]);
    const t = buildTrade({
      position: openPosition,
      qty: openPosition.quantity,
      exitPrice: lastCandle.close,
      closedAt: lastCandle.time,
      closeReason: 'forced_close',
      balanceBeforeClose: balance,
      commissionRate: resolvedOptions.commissionRate,
      barsHeld: timeAxis.length - 1 - openPosition.openIndex,
      leg: 'full',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t.balanceAfter;
    trades.push(t);
    equityCurve.push({ time: lastCandle.time, balance: round(balance) });
  }

  return {
    options: resolvedOptions,
    summary: buildSummary({
      universe: symbols,
      trades,
      startBalance: resolvedOptions.startingBalance,
      endBalance: balance,
      equityCurve
    }),
    trades,
    equityCurve,
    regimeStats: buildRegimeStats(trades, barCounts),
    selectionStats
  };
}
