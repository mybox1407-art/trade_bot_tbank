// ✅ ИСПРАВЛЕНО: пути импортов (файл находится в src/backtest/)
import { Candle } from '../services/dailyBreakoutStrategy';
import {
  runDailyUniverseBacktest,
  DailyUniverseBacktestResult,
  DailyMonthStats,
  DailyUniverseTrade,
} from './dailyUniverseBacktest';

// ЗАМЕНИ на свой реальный способ загрузки данных
// import { loadCandlesForSymbols } from '../data/loadCandlesForSymbols';

// ✅ Заглушка — замени на реальную реализацию
async function loadCandlesForSymbols(
  symbols: string[],
  opts: { timeframe: string; from: string; to: string }
): Promise<Record<string, Candle[]>> {
  // TODO: загрузи свечи из Binance/T-Bank API или из PostgreSQL
  console.log(`Loading candles for ${symbols.join(', ')} opts:`, opts);
  return {};
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pct(value: number, digits = 2): string {
  return `${round(value * 100, digits)}%`;
}

function money(value: number, digits = 2): string {
  return round(value, digits).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function printHeader(title: string): void {
  console.log('');
  console.log('='.repeat(80));
  console.log(title);
  console.log('='.repeat(80));
}

function printSummary(result: DailyUniverseBacktestResult): void {
  const s = result.summary;

  printHeader('DAILY UNIVERSE BACKTEST');

  console.log(`Universe: ${s.universe.join(', ')}`);
  console.log(`Trades: ${s.tradesCount}`);
  console.log(`Wins / Losses: ${s.wins} / ${s.losses}`);
  console.log(`Win rate: ${pct(s.winRate)}`);
  console.log(`Start balance: ${money(s.startBalance)}`);
  console.log(`End balance: ${money(s.endBalance)}`);
  console.log(`Net profit: ${money(s.netProfit)}`);
  console.log(`Return: ${pct(s.returnPct)}`);
  console.log(
    `Profit factor: ${Number.isFinite(s.profitFactor) ? round(s.profitFactor, 2) : 'Infinity'}`
  );
  console.log(`Sharpe: ${round(s.sharpe, 2)}`);
  console.log(`Avg trade: ${money(s.avgNetPnl)}`);
  console.log(`Avg win: ${money(s.avgWin)}`);
  console.log(`Avg loss: ${money(s.avgLoss)}`);
  console.log(`Max drawdown: ${money(s.maxDrawdownAbs)} (${pct(s.maxDrawdownPct)})`);
  console.log(`Years in sample: ${round(s.yearsCount, 2)}`);
}

function printSelectionStats(result: DailyUniverseBacktestResult): void {
  const s = result.selectionStats;

  printHeader('SELECTION STATS');

  console.log(`Decision days: ${s.totalDecisionDays}`);
  console.log(`No-signal days: ${s.noSignalDays}`);
  console.log(`Accepted signals: ${s.signalsAccepted}`);
  console.log(`Rejected signals: ${s.signalsRejected}`);

  const pickedSymbolsRows = Object.entries(s.pickedBySymbol)
    .sort((a, b) => b[1] - a[1])
    .map(([symbol, count]) => ({ symbol, picked: count }));

  const pickedSidesRows = Object.entries(s.pickedBySide)
    .sort((a, b) => b[1] - a[1])
    .map(([side, count]) => ({ side, picked: count }));

  if (pickedSymbolsRows.length) {
    console.log('');
    console.log('Picked by symbol:');
    console.table(pickedSymbolsRows);
  }

  if (pickedSidesRows.length) {
    console.log('');
    console.log('Picked by side:');
    console.table(pickedSidesRows);
  }
}

function printFilterDiagnostics(result: DailyUniverseBacktestResult): void {
  const f = result.diagnostics.filters;

  printHeader('FILTER DIAGNOSTICS');

  const rows = [
    { metric: 'Bars processed', value: f.barsProcessed },
    { metric: 'Symbols seen', value: f.symbolsSeen },
    { metric: 'Warm symbols', value: f.warmSymbols },
    { metric: 'ATR filter passed', value: f.atrFilterPassed },
    { metric: 'ATR filter rejected', value: f.atrFilterRejected },
    { metric: 'Breakout candidates', value: f.breakoutCandidates },
    { metric: 'Long candidates', value: f.longCandidates },
    { metric: 'Short candidates', value: f.shortCandidates },
    { metric: 'Accepted signals', value: f.acceptedSignals },
    { metric: 'Rejected signals', value: f.rejectedSignals },
    { metric: 'Selected signals', value: f.selectedSignals },
    { metric: 'Opened positions', value: f.openedPositions },
  ];

  console.table(rows);

  const warmRate = f.symbolsSeen > 0 ? f.warmSymbols / f.symbolsSeen : 0;
  const atrPassRate =
    f.atrFilterPassed + f.atrFilterRejected > 0
      ? f.atrFilterPassed / (f.atrFilterPassed + f.atrFilterRejected)
      : 0;
  const acceptRate =
    f.acceptedSignals + f.rejectedSignals > 0
      ? f.acceptedSignals / (f.acceptedSignals + f.rejectedSignals)
      : 0;
  const selectRate = f.acceptedSignals > 0 ? f.selectedSignals / f.acceptedSignals : 0;
  const openRate = f.selectedSignals > 0 ? f.openedPositions / f.selectedSignals : 0;

  console.log(`Warm coverage: ${pct(warmRate)}`);
  console.log(`ATR pass rate: ${pct(atrPassRate)}`);
  console.log(`Signal accept rate: ${pct(acceptRate)}`);
  console.log(`Selection rate: ${pct(selectRate)}`);
  console.log(`Open rate after selection: ${pct(openRate)}`);
}

function printMonthlyStats(result: DailyUniverseBacktestResult): void {
  const months = result.diagnostics.months;

  printHeader('MONTHLY STATS');

  if (!months.length) {
    console.log('No monthly stats.');
    return;
  }

  // ✅ ИСПРАВЛЕНО: явный тип параметра m
  const rows = months.map((m: DailyMonthStats) => ({
    month: m.month,
    decisionDays: m.decisionDays,
    acceptedSignals: m.acceptedSignals,
    rejectedSignals: m.rejectedSignals,
    selectedSignals: m.selectedSignals,
    openedPositions: m.openedPositions,
    closedTrades: m.closedTrades,
    netPnl: money(m.netPnl),
  }));

  console.table(rows);
}

function printRejectDiagnostics(result: DailyUniverseBacktestResult): void {
  const r = result.diagnostics.rejects;

  printHeader('REJECT DIAGNOSTICS');

  const byReasonRows = Object.entries(r.rejectsByReason)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));

  if (!byReasonRows.length) {
    console.log('No reject diagnostics.');
    return;
  }

  console.log('Reject reasons:');
  console.table(byReasonRows);

  // ✅ ИСПРАВЛЕНО: явные типы в map и reduce для rejectsByMonth
  const byMonthRows = Object.entries(r.rejectsByMonth)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, reasons]: [string, Record<string, number>]) => ({
      month,
      total: Object.values(reasons).reduce((sum: number, n: number) => sum + n, 0),
      ...reasons,
    }));

  if (byMonthRows.length) {
    console.log('');
    console.log('Reject reasons by month:');
    console.table(byMonthRows);
  }

  // ✅ ИСПРАВЛЕНО: явные типы в map и reduce для rejectsBySymbol
  const bySymbolRows = Object.entries(r.rejectsBySymbol)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([symbol, reasons]: [string, Record<string, number>]) => ({
      symbol,
      total: Object.values(reasons).reduce((sum: number, n: number) => sum + n, 0),
      ...reasons,
    }));

  if (bySymbolRows.length) {
    console.log('');
    console.log('Reject reasons by symbol:');
    console.table(bySymbolRows);
  }
}

function printTradesPreview(result: DailyUniverseBacktestResult, limit = 20): void {
  const trades = result.trades.slice(-limit);

  printHeader(`LAST ${trades.length} TRADES`);

  if (!trades.length) {
    console.log('No trades.');
    return;
  }

  // ✅ ИСПРАВЛЕНО: явный тип параметра t
  const rows = trades.map((t: DailyUniverseTrade) => ({
    symbol: t.symbol,
    side: t.side,
    openedAt: new Date(t.openedAt).toISOString().slice(0, 10),
    closedAt: new Date(t.closedAt).toISOString().slice(0, 10),
    entry: round(t.entryPrice, 2),
    exit: round(t.exitPrice, 2),
    qty: round(t.quantity, 4),
    netPnl: money(t.netPnl),
    barsHeld: t.barsHeld,
    reason: t.closeReason,
  }));

  console.table(rows);
}

function printSilenceDiagnosis(result: DailyUniverseBacktestResult): void {
  const f = result.diagnostics.filters;
  const months = result.diagnostics.months;
  const rejects = result.diagnostics.rejects.rejectsByReason;

  printHeader('INTERPRETATION');

  const activeMonths = months.filter(
    (m: DailyMonthStats) => m.openedPositions > 0 || m.closedTrades > 0 || m.acceptedSignals > 0
  );

  const firstActiveMonth = activeMonths.length ? activeMonths[0].month : null;
  const firstTradeMonth = months.find((m: DailyMonthStats) => m.closedTrades > 0)?.month ?? null;

  if (!firstActiveMonth) {
    console.log(
      'Стратегия не активировалась ни в одном месяце: либо сигналы не генерируются, либо фильтры/ограничения полностью блокируют входы.'
    );
  } else {
    console.log(`Первый месяц с активностью сигналов: ${firstActiveMonth}`);

    if (firstTradeMonth) {
      console.log(`Первый месяц с закрытыми сделками: ${firstTradeMonth}`);
    } else {
      console.log('Закрытых сделок не было.');
    }
  }

  const atrDenom = f.atrFilterPassed + f.atrFilterRejected;
  const atrPassRate = atrDenom > 0 ? f.atrFilterPassed / atrDenom : 0;
  const acceptDenom = f.acceptedSignals + f.rejectedSignals;
  const acceptRate = acceptDenom > 0 ? f.acceptedSignals / acceptDenom : 0;

  if (f.breakoutCandidates === 0) {
    console.log(
      'Похоже, стратегия почти не видит breakout-кандидатов: сначала проверь саму логику пробоя, таймфрейм и корректность previous-day уровней.'
    );
    return;
  }

  if (atrDenom > 0 && atrPassRate < 0.2) {
    console.log(
      'Основной подозреваемый — ATR-фильтр: слишком мало баров проходит фильтр волатильности.'
    );
  }

  if (acceptDenom > 0 && acceptRate < 0.1) {
    console.log(
      'Сигналы в основном отбрасываются после первичного анализа: проверь entry/stop/size и дополнительные условия допуска.'
    );
  }

  if (f.acceptedSignals > 0 && f.selectedSignals === 0) {
    console.log(
      'Есть принятые сигналы, но ни один не выбирается как лучший: проблема может быть в логике score/selection.'
    );
  }

  if (f.selectedSignals > 0 && f.openedPositions === 0) {
    console.log(
      'Сигналы выбираются, но позиции не открываются: проверь buildDailyBreakoutPositionFromSignal и ограничения размера позиции.'
    );
  }

  const topRejects = Object.entries(rejects)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (topRejects.length) {
    console.log('');
    console.log(
      `Топ причин отказа: ${topRejects.map(([k, v]) => `${k}=${v}`).join(', ')}`
    );
  }

  if (activeMonths.length > 0) {
    const firstHalf = months.slice(0, Math.floor(months.length / 2));
    const secondHalf = months.slice(Math.floor(months.length / 2));

    const firstHalfOpened = firstHalf.reduce(
      (sum: number, m: DailyMonthStats) => sum + m.openedPositions, 0
    );
    const secondHalfOpened = secondHalf.reduce(
      (sum: number, m: DailyMonthStats) => sum + m.openedPositions, 0
    );

    console.log(`Opened positions, first half: ${firstHalfOpened}`);
    console.log(`Opened positions, second half: ${secondHalfOpened}`);

    if (firstHalfOpened === 0 && secondHalfOpened > 0) {
      console.log(
        'Это действительно красный флаг: стратегия была выключена в первой половине истории и "проснулась" только позже. Проверь regime dependency, фильтры и сдвиги в данных.'
      );
    }
  }
}

async function main(): Promise<void> {
  const symbols = ['AAPL', 'MSFT', 'NVDA', 'TSLA'];

  const candlesBySymbol: Record<string, Candle[]> = await loadCandlesForSymbols(symbols, {
    timeframe: '15m',
    from: '2025-01-01',
    to: '2026-07-01',
  });

  const result = runDailyUniverseBacktest(candlesBySymbol, {
    startingBalance: 50000,
    commissionRate: 0.0005,
    warmupCandles: 30,
    progressLogEvery: 250,
    onePositionAtTime: true,
    minSignalAtrPct: 0.008,
    riskPerTrade: 0.01,
    stopAtrMult: 2.5,
    trailingAtrMult: 2.0,
    smaPeriod: 20,
    atrPeriod: 14,
    minAtrPct: 0.006,
    maxAtrPct: 0.12,
    maxBreakoutDistancePct: 0.04,
    allowLongs: true,
    allowShorts: true,
  });

  printSummary(result);
  printSelectionStats(result);
  printFilterDiagnostics(result);
  printMonthlyStats(result);
  printRejectDiagnostics(result);
  printTradesPreview(result, 25);
  printSilenceDiagnosis(result);
}

main().catch((error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error('Backtest runner failed:', err.message);
  process.exit(1);
});
