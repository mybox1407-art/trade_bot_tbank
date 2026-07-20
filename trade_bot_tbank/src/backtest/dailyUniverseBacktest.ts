import {
  Candle,
  UniverseSignal,
  UniverseStrategyOptions,
  evaluateUniverseSymbol
} from '../services/universeStrategy';

export interface DailyUniverseBacktestOptions extends UniverseStrategyOptions {
  startingBalance?: number;
  commissionRate?: number;
  warmupCandles?: number;
  progressLogEvery?: number;
  onePositionAtTime?: boolean;
  minSignalAtrPct?: number;
  stopAtrMult?: number;
  trailingAtrMult?: number;
  minAtrPct?: number;
  maxAtrPct?: number;
  maxBreakoutDistancePct?: number;
  allowLongs?: boolean;
  allowShorts?: boolean;
}

interface OpenPosition {
  symbol: string;
  side: 'long' | 'short';
  regime: string;
  openedAt: number;
  entryPrice: number;
  stopLossPrice: number;
  trailingStopPrice: number;
  reverseLevel: number;
  quantity: number;
  positionSize: number;
  initialR: number;
  highestHigh: number;
  lowestLow: number;
  balanceBefore: number;
  openIndex: number;
}

export interface DailyUniverseTrade {
  symbol: string;
  side: 'long' | 'short';
  regime: string;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  stopLossPrice: number;
  trailingStopPrice: number;
  reverseLevel: number;
  quantity: number;
  positionSize: number;
  grossPnl: number;
  commissionOpen: number;
  commissionClose: number;
  totalCommission: number;
  netPnl: number;
  balanceBefore: number;
  balanceAfter: number;
  barsHeld: number;
  closeReason: 'stop_loss' | 'trailing_stop' | 'reverse_signal' | 'forced_close';
}

export interface DailyUniverseSummary {
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
  sharpe: number;
  startBalance: number;
  endBalance: number;
  returnPct: number;
  maxDrawdownAbs: number;
  maxDrawdownPct: number;
  yearsCount: number;
}

export interface DailySelectionStats {
  totalDecisionDays: number;
  noSignalDays: number;
  pickedBySymbol: Record<string, number>;
  pickedBySide: Record<string, number>;
  signalsAccepted: number;
  signalsRejected: number;
}

export interface DailyFilterStats {
  barsProcessed: number;
  symbolsSeen: number;
  warmSymbols: number;
  atrFilterPassed: number;
  atrFilterRejected: number;
  breakoutCandidates: number;
  longCandidates: number;
  shortCandidates: number;
  acceptedSignals: number;
  rejectedSignals: number;
  selectedSignals: number;
  openedPositions: number;
}

export interface DailyMonthStats {
  month: string;
  decisionDays: number;
  acceptedSignals: number;
  rejectedSignals: number;
  selectedSignals: number;
  openedPositions: number;
  closedTrades: number;
  netPnl: number;
}

export interface DailyRejectDiagnostics {
  rejectsByReason: Record<string, number>;
  rejectsByMonth: Record<string, Record<string, number>>;
  rejectsBySymbol: Record<string, Record<string, number>>;
}

export interface DailyUniverseDiagnostics {
  filters: DailyFilterStats;
  months: DailyMonthStats[];
  rejects: DailyRejectDiagnostics;
}

export interface DailyUniverseBacktestResult {
  options: Required<DailyUniverseBacktestOptions>;
  summary: DailyUniverseSummary;
  trades: DailyUniverseTrade[];
  equityCurve: Array<{ time: number; balance: number }>;
  selectionStats: DailySelectionStats;
  diagnostics: DailyUniverseDiagnostics;
}

interface ScoredSignal {
  signal: UniverseSignal;
  score: number;
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

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddevSample(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function calculateDrawdown(
  equityCurve: Array<{ time: number; balance: number }>
): { maxDrawdownAbs: number; maxDrawdownPct: number } {
  let peak = equityCurve.length ? equityCurve[0].balance : 0;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;

  for (const point of equityCurve) {
    if (point.balance > peak) peak = point.balance;
    const ddAbs = peak - point.balance;
    const ddPct = peak > 0 ? ddAbs / peak : 0;
    if (ddAbs > maxDrawdownAbs) maxDrawdownAbs = ddAbs;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
  }

  return {
    maxDrawdownAbs: round(maxDrawdownAbs),
    maxDrawdownPct: round(maxDrawdownPct, 6)
  };
}

function intersectTimes(candlesBySymbol: Record<string, Candle[]>): number[] {
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
    const map = new Map<number, number>();
    candles.forEach((c, i) => map.set(c.time, i));
    out[symbol] = map;
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

function monthKeyFromTs(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function ensureMonthStats(
  months: Record<string, DailyMonthStats>,
  ts: number
): DailyMonthStats {
  const key = monthKeyFromTs(ts);

  if (!months[key]) {
    months[key] = {
      month: key,
      decisionDays: 0,
      acceptedSignals: 0,
      rejectedSignals: 0,
      selectedSignals: 0,
      openedPositions: 0,
      closedTrades: 0,
      netPnl: 0
    };
  }

  return months[key];
}

function incCounter(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function incNestedCounter(
  map: Record<string, Record<string, number>>,
  outer: string,
  inner: string
): void {
  if (!map[outer]) map[outer] = {};
  map[outer][inner] = (map[outer][inner] ?? 0) + 1;
}

function getIndicatorNumber(
  signal: UniverseSignal,
  key: string
): number | null {
  const value = signal.indicators?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractRejectReason(signal: UniverseSignal): string {
  const reason =
    signal.indicators?.rejectReason ??
    signal.indicators?.reject ??
    (signal.side === 'none' ? 'side_none' : null);

  return typeof reason === 'string' && reason.trim() ? reason : 'unknown_reject';
}

function isTradableSignal(signal: UniverseSignal): boolean {
  return !!(
    signal.side !== 'none' &&
    signal.price > 0 &&
    signal.stopLossPrice != null &&
    signal.quantity != null &&
    signal.quantity > 0 &&
    signal.positionSize != null &&
    signal.positionSize > 0 &&
    signal.initialR != null &&
    signal.initialR > 0 &&
    getIndicatorNumber(signal, 'atrPct') != null
  );
}

function chooseSymbolSignal(
  signals: UniverseSignal[]
): UniverseSignal | null {
  if (!signals.length) return null;

  return signals.reduce((best, cur) => {
    if (!best) return cur;

    if (best.side === 'none' && cur.side !== 'none') return cur;
    if (best.side !== 'none' && cur.side === 'none') return best;

    if (cur.score !== best.score) {
      return cur.score > best.score ? cur : best;
    }

    if (cur.rawScore !== best.rawScore) {
      return cur.rawScore > best.rawScore ? cur : best;
    }

    return best;
  }, signals[0]);
}

function pickBestSignal(
  visibleBySymbol: Record<string, Candle[]>,
  balance: number,
  strategyOptions: Required<DailyUniverseBacktestOptions>,
  filterStats: DailyFilterStats,
  monthStats: DailyMonthStats,
  rejectsByReason: Record<string, number>,
  rejectsByMonth: Record<string, Record<string, number>>,
  rejectsBySymbol: Record<string, Record<string, number>>
): {
  best: UniverseSignal | null;
  accepted: number;
  rejected: number;
} {
  let bestScored: ScoredSignal | null = null;
  let accepted = 0;
  let rejected = 0;

  for (const [symbol, candles] of Object.entries(visibleBySymbol)) {
    filterStats.symbolsSeen += 1;

    const warmupNeeded = Math.max(strategyOptions.warmupCandles, 30);
    if (!Array.isArray(candles) || candles.length < warmupNeeded) {
      continue;
    }

    filterStats.warmSymbols += 1;

    const evaluated = evaluateUniverseSymbol(symbol, candles, balance, {
      riskPerTrade: strategyOptions.riskPerTrade,
      minScore: strategyOptions.minScore,
      warmupCandles: strategyOptions.warmupCandles
    });

    const candidates: UniverseSignal[] = [];
    if (strategyOptions.allowLongs) candidates.push(evaluated.longSignal);
    if (strategyOptions.allowShorts) candidates.push(evaluated.shortSignal);

    const signal = chooseSymbolSignal(candidates);
    if (!signal) continue;

    const atrPct = getIndicatorNumber(signal, 'atrPct');

    if (signal.indicators.ready && atrPct != null) {
      if (
        atrPct >= strategyOptions.minAtrPct &&
        atrPct <= strategyOptions.maxAtrPct
      ) {
        filterStats.atrFilterPassed += 1;
      } else {
        filterStats.atrFilterRejected += 1;
      }
    }

    if (signal.side === 'long') {
      filterStats.breakoutCandidates += 1;
      filterStats.longCandidates += 1;
    } else if (signal.side === 'short') {
      filterStats.breakoutCandidates += 1;
      filterStats.shortCandidates += 1;
    }

    if (!isTradableSignal(signal)) {
      const rejectReason = extractRejectReason(signal);

      rejected += 1;
      filterStats.rejectedSignals += 1;
      monthStats.rejectedSignals += 1;

      incCounter(rejectsByReason, rejectReason);
      incNestedCounter(rejectsByMonth, monthStats.month, rejectReason);
      incNestedCounter(rejectsBySymbol, symbol, rejectReason);

      continue;
    }

    if (atrPct == null || atrPct < strategyOptions.minSignalAtrPct) {
      const rejectReason = 'min_signal_atr_pct';

      rejected += 1;
      filterStats.rejectedSignals += 1;
      monthStats.rejectedSignals += 1;

      incCounter(rejectsByReason, rejectReason);
      incNestedCounter(rejectsByMonth, monthStats.month, rejectReason);
      incNestedCounter(rejectsBySymbol, symbol, rejectReason);

      continue;
    }

    accepted += 1;
    filterStats.acceptedSignals += 1;
    monthStats.acceptedSignals += 1;

    const signalScore = signal.score;

    if (!bestScored || signalScore > bestScored.score) {
      bestScored = {
        signal,
        score: signalScore
      };
    }
  }

  if (bestScored) {
    filterStats.selectedSignals += 1;
    monthStats.selectedSignals += 1;
  }

  return {
    best: bestScored ? bestScored.signal : null,
    accepted,
    rejected
  };
}

function buildPositionFromSignal(
  signal: UniverseSignal,
  openedAt: number
): OpenPosition | null {
  if (!isTradableSignal(signal)) return null;

  const ema20 = getIndicatorNumber(signal, 'ema20');
  const reverseLevel =
    ema20 != null && Number.isFinite(ema20)
      ? ema20
      : signal.stopLossPrice ?? signal.price;

  return {
    symbol: signal.symbol,
    side: signal.side as 'long' | 'short',
    regime: signal.regime,
    openedAt,
    entryPrice: signal.price,
    stopLossPrice: signal.stopLossPrice as number,
    trailingStopPrice: signal.stopLossPrice as number,
    reverseLevel,
    quantity: signal.quantity as number,
    positionSize: signal.positionSize as number,
    initialR: signal.initialR as number,
    highestHigh: signal.price,
    lowestLow: signal.price,
    balanceBefore: 0,
    openIndex: 0
  };
}

function updatePositionTrailingStop(
  position: OpenPosition,
  candle: Candle,
  options: Required<DailyUniverseBacktestOptions>
): OpenPosition {
  const trailFactor =
    options.stopAtrMult > 0
      ? options.trailingAtrMult / options.stopAtrMult
      : 1;

  const trailDistance = position.initialR * trailFactor;

  if (position.side === 'long') {
    const highestHigh = Math.max(position.highestHigh, candle.high);
    const trailingStopPrice = Math.max(
      position.trailingStopPrice,
      highestHigh - trailDistance
    );

    return {
      ...position,
      highestHigh,
      trailingStopPrice: round(trailingStopPrice)
    };
  }

  const lowestLow = Math.min(position.lowestLow, candle.low);
  const trailingStopPrice = Math.min(
    position.trailingStopPrice,
    lowestLow + trailDistance
  );

  return {
    ...position,
    lowestLow,
    trailingStopPrice: round(trailingStopPrice)
  };
}

function shouldExitPosition(
  position: OpenPosition,
  candle: Candle
): {
  exit: boolean;
  exitPrice: number | null;
  reason: DailyUniverseTrade['closeReason'] | null;
} {
  if (position.side === 'long') {
    if (
      position.trailingStopPrice > position.stopLossPrice &&
      candle.low <= position.trailingStopPrice
    ) {
      return {
        exit: true,
        exitPrice: position.trailingStopPrice,
        reason: 'trailing_stop'
      };
    }

    if (candle.low <= position.stopLossPrice) {
      return {
        exit: true,
        exitPrice: position.stopLossPrice,
        reason: 'stop_loss'
      };
    }

    if (candle.close < position.reverseLevel) {
      return {
        exit: true,
        exitPrice: candle.close,
        reason: 'reverse_signal'
      };
    }

    return { exit: false, exitPrice: null, reason: null };
  }

  if (
    position.trailingStopPrice < position.stopLossPrice &&
    candle.high >= position.trailingStopPrice
  ) {
    return {
      exit: true,
      exitPrice: position.trailingStopPrice,
      reason: 'trailing_stop'
    };
  }

  if (candle.high >= position.stopLossPrice) {
    return {
      exit: true,
      exitPrice: position.stopLossPrice,
      reason: 'stop_loss'
    };
  }

  if (candle.close > position.reverseLevel) {
    return {
      exit: true,
      exitPrice: candle.close,
      reason: 'reverse_signal'
    };
  }

  return { exit: false, exitPrice: null, reason: null };
}

function buildTrade(params: {
  position: OpenPosition;
  exitPrice: number;
  closedAt: number;
  closeReason: DailyUniverseTrade['closeReason'];
  commissionRate: number;
  barsHeld: number;
  balanceBeforeClose: number;
}): DailyUniverseTrade {
  const {
    position,
    exitPrice,
    closedAt,
    closeReason,
    commissionRate,
    barsHeld,
    balanceBeforeClose
  } = params;

  const grossPnl = getGrossPnl({
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity
  });

  const commissionOpen = getCommission(position.entryPrice * position.quantity, commissionRate);
  const commissionClose = getCommission(exitPrice * position.quantity, commissionRate);
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
    stopLossPrice: round(position.stopLossPrice),
    trailingStopPrice: round(position.trailingStopPrice),
    reverseLevel: round(position.reverseLevel),
    quantity: position.quantity,
    positionSize: round(position.positionSize, 6),
    grossPnl: round(grossPnl),
    commissionOpen: round(commissionOpen),
    commissionClose: round(commissionClose),
    totalCommission: round(totalCommission),
    netPnl: round(netPnl),
    balanceBefore: round(position.balanceBefore),
    balanceAfter: round(balanceBeforeClose + netPnl),
    barsHeld,
    closeReason
  };
}

function buildSummary(params: {
  universe: string[];
  trades: DailyUniverseTrade[];
  startBalance: number;
  endBalance: number;
  equityCurve: Array<{ time: number; balance: number }>;
}): DailyUniverseSummary {
  const { universe, trades, startBalance, endBalance, equityCurve } = params;

  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);

  const grossProfit = wins.reduce((a, b) => a + b.netPnl, 0);
  const grossLossAbs = Math.abs(losses.reduce((a, b) => a + b.netPnl, 0));
  const netProfit = trades.reduce((a, b) => a + b.netPnl, 0);

  const profitFactor =
    grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? Infinity : 0;

  const returnPct = startBalance > 0 ? (endBalance - startBalance) / startBalance : 0;

  const equityReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prevBalance = equityCurve[i - 1].balance;
    const curBalance = equityCurve[i].balance;
    if (prevBalance > 0) {
      equityReturns.push((curBalance - prevBalance) / prevBalance);
    }
  }

  const avgRet = mean(equityReturns);
  const stdRet = stddevSample(equityReturns);
  const sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(252) : 0;

  const dd = calculateDrawdown(equityCurve);

  const years =
    equityCurve.length >= 2
      ? Math.max(
          (equityCurve[equityCurve.length - 1].time - equityCurve[0].time) /
            (365.25 * 24 * 60 * 60 * 1000),
          0
        )
      : 0;

  return {
    universe,
    tradesCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(trades.length > 0 ? wins.length / trades.length : 0, 6),
    grossProfit: round(grossProfit),
    grossLoss: round(-grossLossAbs),
    netProfit: round(netProfit),
    avgNetPnl: round(trades.length > 0 ? netProfit / trades.length : 0),
    avgWin: round(wins.length > 0 ? grossProfit / wins.length : 0),
    avgLoss: round(
      losses.length > 0 ? losses.reduce((a, b) => a + b.netPnl, 0) / losses.length : 0
    ),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 6) : Infinity,
    sharpe: round(sharpe, 6),
    startBalance: round(startBalance),
    endBalance: round(endBalance),
    returnPct: round(returnPct, 6),
    maxDrawdownAbs: dd.maxDrawdownAbs,
    maxDrawdownPct: dd.maxDrawdownPct,
    yearsCount: round(years, 4)
  };
}

export function runDailyUniverseBacktest(
  candlesBySymbol: Record<string, Candle[]>,
  options: DailyUniverseBacktestOptions = {}
): DailyUniverseBacktestResult {
  const resolvedOptions: Required<DailyUniverseBacktestOptions> = {
    startingBalance: options.startingBalance ?? 50000,
    commissionRate: options.commissionRate ?? 0.0005,
    warmupCandles: options.warmupCandles ?? 30,
    progressLogEvery: options.progressLogEvery ?? 250,
    onePositionAtTime: options.onePositionAtTime ?? true,
    minSignalAtrPct: options.minSignalAtrPct ?? 0.006,
    riskPerTrade: options.riskPerTrade ?? 0.01,
    minScore: options.minScore ?? 4.0,
    stopAtrMult: options.stopAtrMult ?? 2.5,
    trailingAtrMult: options.trailingAtrMult ?? 2.0,
    minAtrPct: options.minAtrPct ?? 0.006,
    maxAtrPct: options.maxAtrPct ?? 0.12,
    maxBreakoutDistancePct: options.maxBreakoutDistancePct ?? 0.04,
    allowLongs: options.allowLongs ?? true,
    allowShorts: options.allowShorts ?? true
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
      selectionStats: {
        totalDecisionDays: 0,
        noSignalDays: 0,
        pickedBySymbol: {},
        pickedBySide: {},
        signalsAccepted: 0,
        signalsRejected: 0
      },
      diagnostics: {
        filters: {
          barsProcessed: 0,
          symbolsSeen: 0,
          warmSymbols: 0,
          atrFilterPassed: 0,
          atrFilterRejected: 0,
          breakoutCandidates: 0,
          longCandidates: 0,
          shortCandidates: 0,
          acceptedSignals: 0,
          rejectedSignals: 0,
          selectedSignals: 0,
          openedPositions: 0
        },
        months: [],
        rejects: {
          rejectsByReason: {},
          rejectsByMonth: {},
          rejectsBySymbol: {}
        }
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
  let openPosition: OpenPosition | null = null;

  const trades: DailyUniverseTrade[] = [];
  const equityCurve: Array<{ time: number; balance: number }> = [];
  const selectionStats: DailySelectionStats = {
    totalDecisionDays: 0,
    noSignalDays: 0,
    pickedBySymbol: {},
    pickedBySide: {},
    signalsAccepted: 0,
    signalsRejected: 0
  };
  const filterStats: DailyFilterStats = {
    barsProcessed: 0,
    symbolsSeen: 0,
    warmSymbols: 0,
    atrFilterPassed: 0,
    atrFilterRejected: 0,
    breakoutCandidates: 0,
    longCandidates: 0,
    shortCandidates: 0,
    acceptedSignals: 0,
    rejectedSignals: 0,
    selectedSignals: 0,
    openedPositions: 0
  };

  const monthStatsMap: Record<string, DailyMonthStats> = {};
  const rejectsByReason: Record<string, number> = {};
  const rejectsByMonth: Record<string, Record<string, number>> = {};
  const rejectsBySymbol: Record<string, Record<string, number>> = {};

  if (timeAxis.length) {
    equityCurve.push({ time: timeAxis[0], balance: round(balance) });
  }

  const startedAt = Date.now();
  const totalBarsToProcess = Math.max(timeAxis.length - resolvedOptions.warmupCandles, 0);

  for (let i = resolvedOptions.warmupCandles; i < timeAxis.length; i++) {
    const ts = timeAxis[i];
    const visibleBySymbol = buildVisibleSlices(sortedBySymbol, lookup, ts);
    const currentMonthStats = ensureMonthStats(monthStatsMap, ts);

    filterStats.barsProcessed += 1;

    if (resolvedOptions.progressLogEvery > 0) {
      const processedBars = i - resolvedOptions.warmupCandles;
      const shouldLog =
        processedBars > 0 &&
        (processedBars % resolvedOptions.progressLogEvery === 0 || i === timeAxis.length - 1);

      if (shouldLog) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const speed = processedBars / Math.max(elapsedSec, 1e-9);
        const remainingBars = Math.max(totalBarsToProcess - processedBars, 0);
        const etaSec = remainingBars / Math.max(speed, 1e-9);
        const progressPct =
          totalBarsToProcess > 0 ? (processedBars / totalBarsToProcess) * 100 : 100;

        console.log(
          [
            '[DAILY]',
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
      const symbolCandles = visibleBySymbol[openPosition.symbol];
      const candle = symbolCandles ? last(symbolCandles) : undefined;
      if (!candle) continue;

      openPosition = updatePositionTrailingStop(openPosition, candle, resolvedOptions);

      const exitCheck = shouldExitPosition(openPosition, candle);
      if (exitCheck.exit && exitCheck.exitPrice != null && exitCheck.reason != null) {
        const trade = buildTrade({
          position: openPosition,
          exitPrice: exitCheck.exitPrice,
          closedAt: candle.time,
          closeReason: exitCheck.reason,
          commissionRate: resolvedOptions.commissionRate,
          barsHeld: i - openPosition.openIndex,
          balanceBeforeClose: balance
        });

        balance = trade.balanceAfter;
        trades.push(trade);
        equityCurve.push({ time: candle.time, balance: round(balance) });
        currentMonthStats.closedTrades += 1;
        currentMonthStats.netPnl = round(currentMonthStats.netPnl + trade.netPnl);
        openPosition = null;
      }
    }

    if (openPosition && resolvedOptions.onePositionAtTime) {
      continue;
    }

    selectionStats.totalDecisionDays += 1;
    currentMonthStats.decisionDays += 1;

    const pick = pickBestSignal(
      visibleBySymbol,
      balance,
      resolvedOptions,
      filterStats,
      currentMonthStats,
      rejectsByReason,
      rejectsByMonth,
      rejectsBySymbol
    );

    selectionStats.signalsAccepted += pick.accepted;
    selectionStats.signalsRejected += pick.rejected;

    if (!pick.best) {
      selectionStats.noSignalDays += 1;
      continue;
    }

    selectionStats.pickedBySymbol[pick.best.symbol] =
      (selectionStats.pickedBySymbol[pick.best.symbol] ?? 0) + 1;

    selectionStats.pickedBySide[pick.best.side] =
      (selectionStats.pickedBySide[pick.best.side] ?? 0) + 1;

    const built = buildPositionFromSignal(pick.best, ts);
    if (!built) continue;

    filterStats.openedPositions += 1;
    currentMonthStats.openedPositions += 1;

    openPosition = {
      ...built,
      balanceBefore: balance,
      openIndex: i
    };
  }

  if (openPosition) {
    const finalCandles = sortedBySymbol[openPosition.symbol];
    const lastCandle = last(finalCandles);
    const finalMonthStats = ensureMonthStats(monthStatsMap, lastCandle.time);

    const trade = buildTrade({
      position: openPosition,
      exitPrice: lastCandle.close,
      closedAt: lastCandle.time,
      closeReason: 'forced_close',
      commissionRate: resolvedOptions.commissionRate,
      barsHeld: timeAxis.length - 1 - openPosition.openIndex,
      balanceBeforeClose: balance
    });

    balance = trade.balanceAfter;
    trades.push(trade);
    equityCurve.push({ time: lastCandle.time, balance: round(balance) });
    finalMonthStats.closedTrades += 1;
    finalMonthStats.netPnl = round(finalMonthStats.netPnl + trade.netPnl);
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
    selectionStats,
    diagnostics: {
      filters: filterStats,
      months: Object.values(monthStatsMap).sort((a, b) => a.month.localeCompare(b.month)),
      rejects: {
        rejectsByReason,
        rejectsByMonth,
        rejectsBySymbol
      }
    }
  };
}
