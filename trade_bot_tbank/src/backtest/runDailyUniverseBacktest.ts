import fs from 'node:fs/promises';
import path from 'node:path';
import { Candle } from '../services/dailyBreakoutStrategy';
import {
  runDailyUniverseBacktest,
  DailyUniverseBacktestResult,
  DailyMonthStats,
  DailyUniverseTrade
} from './dailyUniverseBacktest';

type CliInput = {
  filePath: string;
  symbol: string;
};

type JsonObject = Record<string, unknown>;

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
    maximumFractionDigits: digits
  });
}

function printHeader(title: string): void {
  console.log('');
  console.log('='.repeat(80));
  console.log(title);
  console.log('='.repeat(80));
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  return NaN;
}

function parseTimestamp(raw: JsonObject): number {
  const directTime = toNumber(raw.time);
  if (Number.isFinite(directTime)) return directTime;

  const timestamp = toNumber(raw.timestamp);
  if (Number.isFinite(timestamp)) return timestamp;

  const openTime = toNumber(raw.openTime);
  if (Number.isFinite(openTime)) return openTime;

  const maybeDate =
    (typeof raw.date === 'string' && raw.date) ||
    (typeof raw.datetime === 'string' && raw.datetime) ||
    (typeof raw.open_time === 'string' && raw.open_time) ||
    '';

  const parsedDate = Date.parse(maybeDate);
  return Number.isFinite(parsedDate) ? parsedDate : NaN;
}

function normalizeCandle(raw: unknown): Candle {
  if (!isObject(raw)) {
    throw new Error(`Некорректная свеча: ${JSON.stringify(raw)}`);
  }

  const time = parseTimestamp(raw);
  const open = toNumber(raw.open);
  const high = toNumber(raw.high);
  const low = toNumber(raw.low);
  const close = toNumber(raw.close);
  const volume = toNumber(raw.volume ?? raw.vol ?? 0);

  if (
    !Number.isFinite(time) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    !Number.isFinite(volume)
  ) {
    throw new Error(`Некорректная свеча: ${JSON.stringify(raw).slice(0, 300)}`);
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volume
  };
}

function extractRows(parsed: unknown, resolvedPath: string): unknown[] {
  if (Array.isArray(parsed)) return parsed;

  if (isObject(parsed)) {
    if (Array.isArray(parsed.candles)) return parsed.candles;
    if (Array.isArray(parsed.data)) return parsed.data;
    if (Array.isArray(parsed.items)) return parsed.items;
  }

  throw new Error(
    `Файл ${resolvedPath} не содержит массив свечей. Ожидался массив или поле candles/data/items.`
  );
}

function parseCliInputs(argv: string[]): CliInput[] {
  const rawArgs = argv.slice(2);

  if (!rawArgs.length) {
    throw new Error(
      'Не переданы JSON-файлы. Пример:\n' +
        'npx tsx src/backtest/runDailyUniverseBacktest.ts ' +
        './src/backtest/data/SBER_15m.json:SBER ' +
        './src/backtest/data/GAZP_15m.json:GAZP ' +
        './src/backtest/data/LKOH_15m.json:LKOH ' +
        './src/backtest/data/ROSN_15m.json:ROSN'
    );
  }

  return rawArgs.map((arg: string) => {
    const idx = arg.lastIndexOf(':');

    if (idx <= 0 || idx === arg.length - 1) {
      throw new Error(`Неверный аргумент "${arg}". Ожидается формат: путь_к_json:SYMBOL`);
    }

    const filePath = arg.slice(0, idx).trim();
    const symbol = arg.slice(idx + 1).trim().toUpperCase();

    if (!filePath || !symbol) {
      throw new Error(`Неверный аргумент "${arg}". Путь или тикер пустой.`);
    }

    return { filePath, symbol };
  });
}

async function loadCandlesFromJsonFiles(
  inputs: CliInput[]
): Promise<Record<string, Candle[]>> {
  const out: Record<string, Candle[]> = {};

  for (const input of inputs) {
    const resolvedPath = path.resolve(input.filePath);
    const rawText = await fs.readFile(resolvedPath, 'utf-8');
    const parsed: unknown = JSON.parse(rawText);
    const rows = extractRows(parsed, resolvedPath);

    const candles = rows
      .map((row: unknown) => normalizeCandle(row))
      .sort((a: Candle, b: Candle) => a.time - b.time);

    if (!candles.length) {
      throw new Error(`Файл ${resolvedPath} не содержит свечей после нормализации.`);
    }

    out[input.symbol] = candles;
  }

  return out;
}

function printLaunchParams(candlesBySymbol: Record<string, Candle[]>): void {
  printHeader('ПАРАМЕТРЫ DAILY UNIVERSE ЗАПУСКА');

  const symbols = Object.keys(candlesBySymbol).sort();
  console.log(`Инструментов: ${symbols.length}`);
  console.log(`Universe: ${symbols.join(', ')}`);

  for (const symbol of symbols) {
    const candles = candlesBySymbol[symbol];
    const first = candles[0];
    const last = candles[candles.length - 1];

    console.log(
      `${symbol}: ${candles.length} свечей | ` +
        `${new Date(first.time).toISOString().slice(0, 10)} -> ` +
        `${new Date(last.time).toISOString().slice(0, 10)}`
    );
  }

  console.log('Стартовый баланс: 50000');
  console.log('Комиссия: 0.0005');
  console.log('Warmup: 30');
  console.log('Risk per trade: 1%');
  console.log('Stop ATR: 2.5');
  console.log('Trail ATR: 2');
  console.log('Min ATR %: 0.006');
  console.log('Min signal ATR %: 0.006');
  console.log('Max ATR %: 0.12');
  console.log('Max breakout distance %: 0.04');
  console.log('Longs: ON');
  console.log('Shorts: OFF');
  console.log('Preset default: long-only + minAtrPct=0.006');
  console.log('Лог прогресса: каждые 250 баров');
}

function printSummary(result: DailyUniverseBacktestResult): void {
  const s = result.summary;

  printHeader('ИТОГИ DAILY UNIVERSE БЭКТЕСТА');

  console.log(`Universe: ${s.universe.join(', ')}`);
  console.log(`Сделок: ${s.tradesCount}`);
  console.log(`Побед: ${s.wins}`);
  console.log(`Поражений: ${s.losses}`);
  console.log(`Win rate: ${pct(s.winRate)}`);
  console.log(`Gross profit: ${money(s.grossProfit)}`);
  console.log(`Gross loss: ${money(s.grossLoss)}`);
  console.log(`Net profit: ${money(s.netProfit)}`);
  console.log(`Avg net pnl: ${money(s.avgNetPnl)}`);
  console.log(`Avg win: ${money(s.avgWin)}`);
  console.log(`Avg loss: ${money(s.avgLoss)}`);
  console.log(
    `Profit factor: ${Number.isFinite(s.profitFactor) ? round(s.profitFactor, 3) : 'Infinity'}`
  );
  console.log(`Sharpe: ${round(s.sharpe, 3)}`);
  console.log(`Стартовый баланс: ${money(s.startBalance)}`);
  console.log(`Финальный баланс: ${money(s.endBalance)}`);
  console.log(`Доходность: ${pct(s.returnPct)}`);
  console.log(`Макс. просадка: ${money(s.maxDrawdownAbs)}`);
  console.log(`Макс. просадка %: ${pct(s.maxDrawdownPct)}`);
  console.log(`Лет в тесте: ${round(s.yearsCount, 2)}`);
}

function printSelectionStats(result: DailyUniverseBacktestResult): void {
  const s = result.selectionStats;

  printHeader('SELECTION STATS');

  console.log(`Decision days: ${s.totalDecisionDays}`);
  console.log(`No-signal days: ${s.noSignalDays}`);
  console.log(`Signals accepted: ${s.signalsAccepted}`);
  console.log(`Signals rejected: ${s.signalsRejected}`);

  const pickedSides = Object.entries(s.pickedBySide)
    .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
    .map(([side, count]: [string, number]) => `${side}=${count}`)
    .join(' | ');

  const pickedSymbols = Object.entries(s.pickedBySymbol)
    .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
    .map(([symbol, count]: [string, number]) => `${symbol}=${count}`)
    .join(' | ');

  if (pickedSides) {
    console.log(`Picked by side: ${pickedSides}`);
  }

  if (pickedSymbols) {
    console.log(`Picked by symbol: ${pickedSymbols}`);
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
    { metric: 'Opened positions', value: f.openedPositions }
  ];

  console.table(rows);

  const warmRate = f.symbolsSeen > 0 ? f.warmSymbols / f.symbolsSeen : 0;
  const atrDenom = f.atrFilterPassed + f.atrFilterRejected;
  const atrPassRate = atrDenom > 0 ? f.atrFilterPassed / atrDenom : 0;
  const acceptDenom = f.acceptedSignals + f.rejectedSignals;
  const acceptRate = acceptDenom > 0 ? f.acceptedSignals / acceptDenom : 0;
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

  const rows = months.map((m: DailyMonthStats) => ({
    month: m.month,
    decisionDays: m.decisionDays,
    acceptedSignals: m.acceptedSignals,
    rejectedSignals: m.rejectedSignals,
    selectedSignals: m.selectedSignals,
    openedPositions: m.openedPositions,
    closedTrades: m.closedTrades,
    netPnl: money(m.netPnl)
  }));

  console.table(rows);
}

function printRejectDiagnostics(result: DailyUniverseBacktestResult): void {
  const r = result.diagnostics.rejects;

  printHeader('REJECT DIAGNOSTICS');

  const byReasonRows = Object.entries(r.rejectsByReason)
    .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
    .map(([reason, count]: [string, number]) => ({ reason, count }));

  if (!byReasonRows.length) {
    console.log('No reject diagnostics.');
    return;
  }

  console.log('Reject reasons:');
  console.table(byReasonRows);

  const byConditionRows = Object.entries(r.rejectsByCondition ?? {})
    .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
    .map(([condition, count]: [string, number]) => ({ condition, count }));

  if (byConditionRows.length) {
    console.log('');
    console.log('Reject conditions:');
    console.table(byConditionRows);
  }

  const byMonthRows = Object.entries(r.rejectsByMonth)
    .sort(
      (a: [string, Record<string, number>], b: [string, Record<string, number>]) =>
        a[0].localeCompare(b[0])
    )
    .map(([month, reasons]: [string, Record<string, number>]) => ({
      month,
      total: Object.values(reasons).reduce((sum: number, n: number) => sum + n, 0),
      ...reasons
    }));

  if (byMonthRows.length) {
    console.log('');
    console.log('Reject reasons by month:');
    console.table(byMonthRows);
  }

  const bySymbolRows = Object.entries(r.rejectsBySymbol)
    .sort(
      (a: [string, Record<string, number>], b: [string, Record<string, number>]) =>
        a[0].localeCompare(b[0])
    )
    .map(([symbol, reasons]: [string, Record<string, number>]) => ({
      symbol,
      total: Object.values(reasons).reduce((sum: number, n: number) => sum + n, 0),
      ...reasons
    }));

  if (bySymbolRows.length) {
    console.log('');
    console.log('Reject reasons by symbol:');
    console.table(bySymbolRows);
  }
}

function printTradesPreview(result: DailyUniverseBacktestResult, limit = 20): void {
  const trades = result.trades.slice(-limit);

  printHeader(`ПОСЛЕДНИЕ ${trades.length} СДЕЛОК`);

  if (!trades.length) {
    console.log('No trades.');
    return;
  }

  trades.forEach((t: DailyUniverseTrade, idx: number) => {
    console.log(
      `#${result.trades.length - trades.length + idx + 1} | ` +
        `Тикер: ${t.symbol} | ` +
        `Открыта: ${new Date(t.openedAt).toISOString().slice(0, 10)} | ` +
        `Закрыта: ${new Date(t.closedAt).toISOString().slice(0, 10)} | ` +
        `Сторона: ${t.side} | ` +
        `Режим: ${t.regime} | ` +
        `Вход: ${t.entryPrice.toFixed(4)} | ` +
        `Выход: ${t.exitPrice.toFixed(4)} | ` +
        `SL: ${t.stopLossPrice.toFixed(4)} | ` +
        `Trail: ${t.trailingStopPrice.toFixed(4)} | ` +
        `Rev: ${t.reverseLevel.toFixed(4)} | ` +
        `Qty: ${t.quantity} | ` +
        `Причина: ${t.closeReason} | ` +
        `Net PnL: ${money(t.netPnl)} | ` +
        `Комиссия: ${money(t.totalCommission)} | ` +
        `Bars: ${t.barsHeld}`
    );
  });
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
      'Стратегия не активировалась ни в одном месяце: либо сигналы не генерируются, либо фильтры полностью блокируют входы.'
    );
  } else {
    console.log(`Первый месяц с активностью сигналов: ${firstActiveMonth}`);
    console.log(
      firstTradeMonth
        ? `Первый месяц с закрытыми сделками: ${firstTradeMonth}`
        : 'Закрытых сделок не было.'
    );
  }

  const symbolsSeen = f.symbolsSeen;
  const acceptedCount = f.acceptedSignals;
  const rejectedCount = f.rejectedSignals;
  const selectedCount = f.selectedSignals;
  const openedCount = f.openedPositions;

  const acceptedRate = symbolsSeen > 0 ? acceptedCount / symbolsSeen : 0;
  const rejectedRate = symbolsSeen > 0 ? rejectedCount / symbolsSeen : 0;
  const selectedFromAcceptedRate = acceptedCount > 0 ? selectedCount / acceptedCount : 0;
  const openedFromSelectedRate = selectedCount > 0 ? openedCount / selectedCount : 0;

  console.log('');
  console.log(`Symbols seen: ${symbolsSeen}`);
  console.log(`Rejected signals: ${rejectedCount} (${pct(rejectedRate)})`);
  console.log(`Accepted signals: ${acceptedCount} (${pct(acceptedRate)})`);
  console.log(
    `Selected from accepted: ${selectedCount}/${acceptedCount} (${pct(selectedFromAcceptedRate)})`
  );
  console.log(
    `Opened from selected: ${openedCount}/${selectedCount} (${pct(openedFromSelectedRate)})`
  );

  const topRejects = Object.entries(rejects)
    .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
    .slice(0, 5);

  if (topRejects.length) {
    console.log('');
    console.log(
      `Топ причин отказа: ${topRejects
        .map(([k, v]: [string, number]) => `${k}=${v}`)
        .join(', ')}`
    );
  }

  if (activeMonths.length > 0) {
    const firstHalf = months.slice(0, Math.floor(months.length / 2));
    const secondHalf = months.slice(Math.floor(months.length / 2));

    const firstHalfOpened = firstHalf.reduce(
      (sum: number, m: DailyMonthStats) => sum + m.openedPositions,
      0
    );
    const secondHalfOpened = secondHalf.reduce(
      (sum: number, m: DailyMonthStats) => sum + m.openedPositions,
      0
    );

    console.log('');
    console.log(`Opened positions, first half: ${firstHalfOpened}`);
    console.log(`Opened positions, second half: ${secondHalfOpened}`);

    if (firstHalfOpened === 0 && secondHalfOpened > 0) {
      console.log(
        'Это признак сильной зависимости от режима рынка: стратегия была пассивной в первой половине истории и активировалась только позже.'
      );
    }
  }
}

async function main(): Promise<void> {
  const cliInputs = parseCliInputs(process.argv);
  const candlesBySymbol = await loadCandlesFromJsonFiles(cliInputs);

  printLaunchParams(candlesBySymbol);

  const startedAt = Date.now();
  const result = runDailyUniverseBacktest(candlesBySymbol, {
    startingBalance: 50000,
    commissionRate: 0.0005,
    warmupCandles: 30,
    progressLogEvery: 250,
    onePositionAtTime: true,
    minSignalAtrPct: 0.0045,
    riskPerTrade: 0.01,
    stopAtrMult: 2.5,
    trailingAtrMult: 2.0,
    minAtrPct: 0.0035,
    maxAtrPct: 0.12,
    maxBreakoutDistancePct: 0.03,
    allowLongs: true,
    allowShorts: true
  });

  printHeader('ВРЕМЯ ВЫПОЛНЕНИЯ');
  console.log(`Фактическое время: ${Math.round((Date.now() - startedAt) / 1000)} сек`);

  printSummary(result);
  printSelectionStats(result);
  printFilterDiagnostics(result);
  printMonthlyStats(result);
  printRejectDiagnostics(result);
  printTradesPreview(result, 20);
  printSilenceDiagnosis(result);
}

main().catch((error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error('Backtest runner failed:', err.message);
  process.exit(1);
});
