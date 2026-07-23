import fs from 'node:fs';
import path from 'node:path';
import { runStrategyBacktest, SideFilter } from './strategyBacktest';
import { Candle, STARTING_BALANCE, MAX_RISK_PER_TRADE, COMMISSION_RATE, DEFAULT_HTF_FILTER } from '../services/strategy';

const PROGRESS_LOG_EVERY = Number(process.env.BACKTEST_PROGRESS_EVERY ?? '250');
const WARMUP_CANDLES_15M = Number(process.env.BACKTEST_WARMUP ?? '300');
const CLOSE_OPEN_POSITION_ON_END =
  String(process.env.BACKTEST_CLOSE_OPEN_POSITION_ON_END ?? 'false').toLowerCase() === 'true';
const SIDE_FILTER_ENV = process.env.BACKTEST_SIDE_FILTER ?? 'both';
const TRADE_START_AT = process.env.BACKTEST_TRADE_START_AT ?? '';
const HTF_ENABLED = String(process.env.BACKTEST_HTF_ENABLED ?? 'true').toLowerCase() === 'true';
const HTF_MIN_ADX = Number(process.env.BACKTEST_HTF_MIN_ADX ?? '18');

const ANSI = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m'
} as const;

type RunResult = ReturnType<typeof runStrategyBacktest>;

function colorize(text: string, color: keyof typeof ANSI): string {
  if (!process.stdout.isTTY) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function createReportWriter() {
  const lines: string[] = [];

  return {
    log(line = ''): void {
      console.log(line);
      lines.push(stripAnsi(line));
    },
    text(): string {
      return lines.join('\n');
    }
  };
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function isValidCandle(candidate: unknown): candidate is Candle {
  if (!candidate || typeof candidate !== 'object') return false;
  const item = candidate as Record<string, unknown>;

  return (
    Number.isFinite(toNumber(item.time)) &&
    Number.isFinite(toNumber(item.open)) &&
    Number.isFinite(toNumber(item.high)) &&
    Number.isFinite(toNumber(item.low)) &&
    Number.isFinite(toNumber(item.close)) &&
    Number.isFinite(toNumber(item.volume))
  );
}

function normalizeCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) {
    throw new Error('JSON должен содержать массив свечей.');
  }

  const candles: Candle[] = raw.map((item, index) => {
    if (!isValidCandle(item)) {
      throw new Error(`Некорректная свеча в массиве, индекс ${index}.`);
    }

    return {
      time: toNumber(item.time),
      open: toNumber(item.open),
      high: toNumber(item.high),
      low: toNumber(item.low),
      close: toNumber(item.close),
      volume: toNumber(item.volume)
    };
  });

  return candles.sort((a, b) => a.time - b.time);
}

function formatNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return 'NaN';
  return value.toFixed(digits);
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toISOString();
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'неизвестно';
  if (seconds < 60) return `${Math.round(seconds)} сек`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} мин ${secs} сек`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
}

function parseSideFilter(value: string | undefined): SideFilter {
  if (!value) return 'both';
  const v = value.trim().toLowerCase();
  if (v === 'both' || v === 'all') return 'both';
  if (v === 'long' || v === 'l') return 'long';
  if (v === 'short' || v === 's') return 'short';
  return 'both';
}

function parseTradeStartTime(value: string): number {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

function estimateBacktestTime(candlesCount15m: number, candlesCount1m: number): {
  minSec: number;
  maxSec: number;
} {
  const total = candlesCount15m + candlesCount1m;
  if (total <= 20000) return { minSec: 3, maxSec: 15 };
  if (total <= 80000) return { minSec: 10, maxSec: 45 };
  if (total <= 200000) return { minSec: 20, maxSec: 120 };
  return { minSec: 60, maxSec: 300 };
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function makeReportBasePath(params: {
  symbol: string;
  sideFilter: string;
  fromTs: number;
  toTs: number;
}): string {
  const resultsDir = path.resolve(process.cwd(), 'src/backtest/results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const from = formatDate(params.fromTs).slice(0, 10);
  const to = formatDate(params.toTs).slice(0, 10);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const fileName =
    `${safeFilePart(params.symbol)}_${from}_${to}_${safeFilePart(params.sideFilter)}_${stamp}`;

  return path.join(resultsDir, fileName);
}

function printSummary(result: RunResult, out: { log: (line?: string) => void }): void {
  const s = result.summary;
  const netColor = s.netProfit > 0 ? 'green' : s.netProfit < 0 ? 'red' : 'yellow';
  const retColor = s.returnPct > 0 ? 'green' : s.returnPct < 0 ? 'red' : 'yellow';
  const pfColor = s.profitFactor >= 1.2 ? 'green' : s.profitFactor >= 1 ? 'yellow' : 'red';

  out.log('\n========== ИТОГИ БЭКТЕСТА ==========');
  out.log(`Инструмент: ${s.symbol}`);
  out.log(`Side filter: ${result.options.sideFilter}`);
  out.log(`HTF filter: ${result.options.htfFilter.enabled ? 'ON' : 'OFF'}`);
  out.log(`Сделок: ${s.tradesCount}`);
  out.log(`Побед: ${colorize(String(s.wins), 'green')}`);
  out.log(`Поражений: ${colorize(String(s.losses), 'red')}`);
  out.log(`Win rate: ${formatNumber(s.winRate * 100, 2)}%`);
  out.log(`Gross profit: ${colorize(formatNumber(s.grossProfit, 2), 'green')}`);
  out.log(`Gross loss: ${colorize(formatNumber(s.grossLoss, 2), 'red')}`);
  out.log(`Net profit: ${colorize(formatNumber(s.netProfit, 2), netColor)}`);
  out.log(`Avg net pnl: ${formatNumber(s.avgNetPnl, 2)}`);
  out.log(`Avg win: ${formatNumber(s.avgWin, 2)}`);
  out.log(`Avg loss: ${formatNumber(s.avgLoss, 2)}`);
  out.log(
    `Profit factor: ${colorize(
      Number.isFinite(s.profitFactor) ? formatNumber(s.profitFactor, 3) : 'Infinity',
      pfColor
    )}`
  );
  out.log(`Стартовый баланс: ${formatNumber(s.startBalance, 2)}`);
  out.log(`Финальный баланс: ${formatNumber(s.endBalance, 2)}`);
  out.log(`Доходность: ${colorize(formatNumber(s.returnPct * 100, 2) + '%', retColor)}`);
  out.log(`Макс. просадка: ${formatNumber(s.maxDrawdownAbs, 2)}`);
  out.log(`Макс. просадка %: ${formatNumber(s.maxDrawdownPct * 100, 2)}%`);
}

function printRegimeStats(result: RunResult, out: { log: (line?: string) => void }): void {
  const rs = result.regimeStats;

  if (!rs || rs.totalBars === 0) {
    out.log('\n========== REGIME STATS ==========');
    out.log('Баров в обработке: 0');
    return;
  }

  const order = [
    'trend_up',
    'trend_down',
    'range',
    'breakout_watch',
    'high_volatility',
    'unknown'
  ];

  out.log('\n========== REGIME STATS ==========');
  out.log(`Баров в обработке: ${rs.totalBars}`);
  out.log(`Side filter: ${result.options.sideFilter}`);

  const barParts: string[] = [];
  const regimesSeen = new Set([
    ...order,
    ...Object.keys(rs.barsByRegime),
    ...Object.keys(rs.tradesByRegime)
  ]);

  for (const reg of [...order, ...[...regimesSeen].filter(r => !order.includes(r))]) {
    const b = rs.barsByRegime[reg];
    if (!b && !rs.tradesByRegime[reg]) continue;
    const pct = b ? (b.pct * 100).toFixed(1) : '0.0';
    const bars = b ? b.bars : 0;
    barParts.push(`${reg} ${pct}% (${bars})`);
  }

  out.log(`Bars: ${barParts.join(' | ')}`);
  out.log('\nTrades by regime:');

  const tradeRegs = [
    ...order.filter(r => rs.tradesByRegime[r]),
    ...Object.keys(rs.tradesByRegime).filter(r => !order.includes(r))
  ];

  if (!tradeRegs.length) {
    out.log('нет');
  }

  for (const reg of tradeRegs) {
    const t = rs.tradesByRegime[reg];
    const pf = Number.isFinite(t.profitFactor) ? t.profitFactor.toFixed(3) : 'Infinity';
    const wr = (t.winRate * 100).toFixed(1);
    const reasons = Object.entries(t.closeReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    out.log(
      ` ${reg}: n=${t.trades} WR=${wr}% PF=${pf} net=${t.netProfit.toFixed(2)} avgBars=${t.avgBarsHeld} | ${reasons || '—'}`
    );
  }

  const allReasons = Object.entries(rs.closeReasonsAll)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' | ');

  out.log(`\nClose reasons: ${allReasons || 'нет'}`);
}

function printTrades(result: RunResult, out: { log: (line?: string) => void }): void {
  out.log(`\n========== ВСЕ СДЕЛКИ (${result.trades.length}) ==========`);

  if (!result.trades.length) {
    out.log('Сделок нет.');
    return;
  }

  for (let i = 0; i < result.trades.length; i++) {
    const trade = result.trades[i];
    const line = [
      `#${i + 1}`,
      `Открыта: ${formatDate(trade.openedAt)}`,
      `Закрыта: ${formatDate(trade.closedAt)}`,
      `Сторона: ${trade.side}`,
      `Режим: ${trade.regime}`,
      `Вход: ${formatNumber(trade.entryPrice, 4)}`,
      `Выход: ${formatNumber(trade.exitPrice, 4)}`,
      `SL: ${formatNumber(trade.stopLossPrice, 4)}`,
      `TP1: ${formatNumber(trade.takeProfit1Price, 4)}`,
      `TP2: ${formatNumber(trade.takeProfit2Price, 4)}`,
      `Qty: ${formatNumber(trade.quantity, 6)}`,
      `Notional: ${formatNumber(trade.notional, 2)}`,
      `Причина: ${trade.closeReason}`,
      `Realized PnL: ${formatNumber(trade.realizedPnL, 2)}`,
      `Net PnL: ${formatNumber(trade.netPnl, 2)}`,
      `Комиссия: ${formatNumber(trade.totalCommission, 4)}`,
      `Bars: ${trade.barsHeld}`
    ].join(' | ');

    if (trade.netPnl > 0) out.log(colorize(line, 'green'));
    else if (trade.netPnl < 0) out.log(colorize(line, 'red'));
    else out.log(colorize(line, 'yellow'));
  }
}

function printOpenPosition(result: RunResult, out: { log: (line?: string) => void }): void {
  if (!result.openPosition) return;

  const p = result.openPosition;

  out.log('\n========== ОТКРЫТАЯ ПОЗИЦИЯ ==========');
  out.log(`Сторона: ${p.side}`);
  out.log(`Режим: ${p.regime}`);
  out.log(`Открыта: ${formatDate(p.openedAt)}`);
  out.log(`Вход: ${formatNumber(p.entryPrice, 4)}`);
  out.log(`Последняя цена: ${formatNumber(p.lastPrice, 4)}`);
  out.log(`SL: ${formatNumber(p.stopLossPrice, 4)}`);
  out.log(`TP1: ${formatNumber(p.takeProfit1Price, 4)}`);
  out.log(`TP2: ${formatNumber(p.takeProfit2Price, 4)}`);
  out.log(`Qty: ${formatNumber(p.quantity, 6)}`);
  out.log(`Initial Qty: ${formatNumber(p.initialQuantity, 6)}`);
  out.log(`Notional: ${formatNumber(p.notional, 2)}`);
  out.log(`Unrealized gross: ${formatNumber(p.unrealizedGrossPnl, 2)}`);
  out.log(`Unrealized net: ${formatNumber(p.unrealizedNetPnl, 2)}`);
}

function printUsage(): void {
  console.log('npx tsx src/backtest/runBacktest.ts DATA_15M_FILE DATA_1M_FILE SYMBOL');
  console.log('Пример:');
  console.log(
    'npx tsx src/backtest/runBacktest.ts ./src/backtest/data/SBER_15m.json ./src/backtest/data/SBER_1m.json SBER'
  );
}

function main(): void {
  const [, , inputPath15mArg, inputPath1mArg, symbolArg] = process.argv;

  if (!inputPath15mArg || !inputPath1mArg || !symbolArg) {
    printUsage();
    process.exit(1);
  }

  const path15m = path.resolve(process.cwd(), inputPath15mArg);
  const path1m = path.resolve(process.cwd(), inputPath1mArg);

  if (!fs.existsSync(path15m)) {
    console.error(`Файл 15m не найден: ${path15m}`);
    process.exit(1);
  }

  if (!fs.existsSync(path1m)) {
    console.error(`Файл 1m не найден: ${path1m}`);
    process.exit(1);
  }

  let raw15m: unknown;
  let raw1m: unknown;

  try {
    raw15m = JSON.parse(fs.readFileSync(path15m, 'utf-8'));
    raw1m = JSON.parse(fs.readFileSync(path1m, 'utf-8'));
  } catch (e) {
    console.error('Ошибка чтения JSON.', e);
    process.exit(1);
  }

  let candles15m: Candle[];
  let candles1m: Candle[];

  try {
    candles15m = normalizeCandles(raw15m);
    candles1m = normalizeCandles(raw1m);
  } catch (e) {
    console.error('Ошибка в формате свечей.', e);
    process.exit(1);
    return;
  }

  const estimated = estimateBacktestTime(candles15m.length, candles1m.length);
  const tradeStartTime = parseTradeStartTime(TRADE_START_AT);
  const sideFilter = parseSideFilter(SIDE_FILTER_ENV);
  const out = createReportWriter();

  const htfFilter = {
    enabled: HTF_ENABLED,
    minAdx1h: HTF_MIN_ADX
  };

  out.log('\n========== ПАРАМЕТРЫ ЗАПУСКА ==========');
  out.log(`Файл 15m: ${path15m}`);
  out.log(`Файл 1m: ${path1m}`);
  out.log(`Инструмент: ${symbolArg}`);
  out.log(`Свечей 15m: ${candles15m.length}`);
  out.log(
    `Период 15m: ${formatDate(candles15m[0].time)} -> ${formatDate(
      candles15m[candles15m.length - 1].time
    )}`
  );
  out.log(`Свечей 1m: ${candles1m.length}`);
  out.log(
    `Период 1m: ${formatDate(candles1m[0].time)} -> ${formatDate(
      candles1m[candles1m.length - 1].time
    )}`
  );
  out.log(`Стартовый баланс: ${STARTING_BALANCE}`);
  out.log(`Риск на сделку: ${formatNumber(MAX_RISK_PER_TRADE * 100, 2)}%`);
  out.log(`Комиссия: ${formatNumber(COMMISSION_RATE * 100, 4)}%`);
  out.log(`Side filter: ${sideFilter}`);
  out.log(`HTF filter: ${htfFilter.enabled ? 'ON' : 'OFF'} (minADX1h: ${htfFilter.minAdx1h})`);
  out.log(`Оценка времени: ~ ${formatDuration(estimated.minSec)} - ${formatDuration(estimated.maxSec)}`);
  out.log(`Лог прогресса: каждые ${PROGRESS_LOG_EVERY} свечей`);
  out.log(`Signal timeframe: 15m`);
  out.log(`Execution timeframe: 1m`);
  out.log(`Warmup 15m: ${WARMUP_CANDLES_15M} бар`);
  out.log(`Trade start: ${tradeStartTime ? formatDate(tradeStartTime) : 'не задан'}`);
  out.log(`Close open position on end: ${CLOSE_OPEN_POSITION_ON_END ? 'ON' : 'OFF'}`);
  out.log(`Прогресс: 0/${candles15m.length} свечей 15m`);

  const startedAt = Date.now();

  const result = runStrategyBacktest(symbolArg, candles15m, candles1m, {
    startingBalance: STARTING_BALANCE,
    commissionRate: COMMISSION_RATE,
    warmupCandles15m: WARMUP_CANDLES_15M,
    progressLogEvery: PROGRESS_LOG_EVERY,
    sideFilter,
    tradeStartTime,
    closeOpenPositionOnEnd: CLOSE_OPEN_POSITION_ON_END,
    maxRiskPerTrade: MAX_RISK_PER_TRADE,
    htfFilter
  });

  const finishedAt = Date.now();
  const durationSec = (finishedAt - startedAt) / 1000;

  out.log('\n========== ВРЕМЯ ВЫПОЛНЕНИЯ ==========');
  out.log(`Фактическое время: ${formatDuration(durationSec)}`);

  printSummary(result, out);
  printRegimeStats(result, out);
  printTrades(result, out);
  printOpenPosition(result, out);

  const reportBasePath = makeReportBasePath({
    symbol: symbolArg,
    sideFilter,
    fromTs: candles15m[0].time,
    toTs: candles15m[candles15m.length - 1].time
  });

  const txtPath = `${reportBasePath}.txt`;
  const jsonPath = `${reportBasePath}.json`;

  fs.writeFileSync(txtPath, out.text(), 'utf-8');

  const jsonReport = {
    meta: {
      savedAt: new Date().toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationSec,
      symbol: symbolArg,
      inputFiles: {
        path15m,
        path1m
      },
      candles: {
        count15m: candles15m.length,
        count1m: candles1m.length,
        period15m: {
          from: formatDate(candles15m[0].time),
          to: formatDate(candles15m[candles15m.length - 1].time)
        },
        period1m: {
          from: formatDate(candles1m[0].time),
          to: formatDate(candles1m[candles1m.length - 1].time)
        }
      },
      options: {
        startingBalance: STARTING_BALANCE,
        maxRiskPerTrade: MAX_RISK_PER_TRADE,
        commissionRate: COMMISSION_RATE,
        progressLogEvery: PROGRESS_LOG_EVERY,
        warmupCandles15m: WARMUP_CANDLES_15M,
        closeOpenPositionOnEnd: CLOSE_OPEN_POSITION_ON_END,
        sideFilter,
        tradeStartTime: tradeStartTime ? formatDate(tradeStartTime) : null,
        htfFilter
      }
    },
    result
  };

  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf-8');

  console.log(`\nTXT отчёт сохранён: ${txtPath}`);
  console.log(`JSON отчёт сохранён: ${jsonPath}`);
}

main();
