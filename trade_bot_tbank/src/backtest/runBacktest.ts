import fs from 'node:fs';
import path from 'node:path';
import { runStrategyBacktest, SideFilter } from './strategyBacktest';
import {
  Candle,
  HTF_WARMUP_15M,
  MAX_RISK_PER_TRADE,
  STARTING_BALANCE
} from '../services/strategy';

const DEFAULT_COOLDOWN_CANDLES = 12;
const PROGRESS_LOG_EVERY = 250;

const ANSI = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m'
} as const;

function colorize(text: string, color: keyof typeof ANSI): string {
  if (!process.stdout.isTTY) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
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
  if (!Array.isArray(raw)) throw new Error('JSON должен содержать массив свечей.');
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

function parseCooldownCandles(value: string | undefined): number {
  if (value == null) return DEFAULT_COOLDOWN_CANDLES;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `Некорректный cooldownCandles="${value}", default ${DEFAULT_COOLDOWN_CANDLES}.`
    );
    return DEFAULT_COOLDOWN_CANDLES;
  }
  return parsed;
}

/** argv: htf | htf=18 | htf=0 | nohtf */
function parseHtfArg(value: string | undefined): {
  htfFilter: boolean;
  htfMinAdx1h: number;
} {
  if (value == null || value === '') {
    return { htfFilter: false, htfMinAdx1h: 18 };
  }

  const v = value.trim().toLowerCase();
  if (v === 'htf' || v === 'htf=on' || v === '1' || v === 'true') {
    return { htfFilter: true, htfMinAdx1h: 18 };
  }

  if (v.startsWith('htf=')) {
    const n = Number(v.slice(4));
    if (!Number.isFinite(n) || n < 0) {
      console.warn(`Некорректный htf="${value}", используем htf=18`);
      return { htfFilter: true, htfMinAdx1h: 18 };
    }
    return { htfFilter: true, htfMinAdx1h: n };
  }

  if (v === 'nohtf' || v === 'htf=off' || v === '0' || v === 'false') {
    return { htfFilter: false, htfMinAdx1h: 18 };
  }

  console.warn(`Неизвестный HTF-аргумент "${value}", HTF выкл.`);
  return { htfFilter: false, htfMinAdx1h: 18 };
}

/** argv: both | long | short (default both) */
function parseSideFilter(value: string | undefined): SideFilter {
  if (value == null || value === '') return 'both';
  const v = value.trim().toLowerCase();
  if (v === 'both' || v === 'all') return 'both';
  if (v === 'long' || v === 'l') return 'long';
  if (v === 'short' || v === 's') return 'short';
  console.warn(`Неизвестный sideFilter="${value}", default both`);
  return 'both';
}

/**
 * 4-й и 5-й argv: htf и/или side в любом порядке.
 * Примеры: htf short | short htf | htf=18 long | both
 */
function parseHtfAndSide(
  arg4: string | undefined,
  arg5: string | undefined
): {
  htfFilter: boolean;
  htfMinAdx1h: number;
  sideFilter: SideFilter;
} {
  let htfFilter = false;
  let htfMinAdx1h = 18;
  let sideFilter: SideFilter = 'both';
  let htfSet = false;
  let sideSet = false;

  const apply = (raw: string | undefined) => {
    if (raw == null || raw === '') return;
    const v = raw.trim().toLowerCase();

    if (
      v === 'both' ||
      v === 'all' ||
      v === 'long' ||
      v === 'l' ||
      v === 'short' ||
      v === 's'
    ) {
      sideFilter = parseSideFilter(v);
      sideSet = true;
      return;
    }

    if (
      v === 'htf' ||
      v === 'htf=on' ||
      v.startsWith('htf=') ||
      v === 'nohtf' ||
      v === 'htf=off'
    ) {
      const p = parseHtfArg(v);
      htfFilter = p.htfFilter;
      htfMinAdx1h = p.htfMinAdx1h;
      htfSet = true;
      return;
    }

    if (!htfSet && (v === '1' || v === 'true' || v === '0' || v === 'false')) {
      const p = parseHtfArg(v);
      htfFilter = p.htfFilter;
      htfMinAdx1h = p.htfMinAdx1h;
      htfSet = true;
      return;
    }

    console.warn(`Неизвестный аргумент "${raw}", игнор`);
  };

  apply(arg4);
  apply(arg5);

  void htfSet;
  void sideSet;

  return { htfFilter, htfMinAdx1h, sideFilter };
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

function estimateBacktestTime(candlesCount: number): {
  minSec: number;
  maxSec: number;
} {
  if (candlesCount <= 5000) return { minSec: 5, maxSec: 20 };
  if (candlesCount <= 15000) return { minSec: 15, maxSec: 60 };
  if (candlesCount <= 30000) return { minSec: 30, maxSec: 120 };
  if (candlesCount <= 60000) return { minSec: 60, maxSec: 300 };
  return { minSec: 180, maxSec: 600 };
}

function printSummary(result: ReturnType<typeof runStrategyBacktest>): void {
  const s = result.summary;
  const netColor = s.netProfit > 0 ? 'green' : s.netProfit < 0 ? 'red' : 'yellow';
  const retColor = s.returnPct > 0 ? 'green' : s.returnPct < 0 ? 'red' : 'yellow';
  const pfColor = s.profitFactor >= 1.2 ? 'green' : s.profitFactor >= 1 ? 'yellow' : 'red';

  console.log('\n========== ИТОГИ БЭКТЕСТА ==========');
  console.log(`Инструмент: ${s.symbol}`);
  console.log(`Side filter: ${result.options.sideFilter}`);
  console.log(`Сделок (групп): ${s.tradesCount}`);
  console.log(`Побед: ${colorize(String(s.wins), 'green')}`);
  console.log(`Поражений: ${colorize(String(s.losses), 'red')}`);
  console.log(`Win rate: ${formatNumber(s.winRate * 100, 2)}%`);
  console.log(`Gross profit: ${colorize(formatNumber(s.grossProfit, 2), 'green')}`);
  console.log(`Gross loss: ${colorize(formatNumber(s.grossLoss, 2), 'red')}`);
  console.log(`Net profit: ${colorize(formatNumber(s.netProfit, 2), netColor)}`);
  console.log(`Avg net pnl: ${formatNumber(s.avgNetPnl, 2)}`);
  console.log(`Avg win: ${colorize(formatNumber(s.avgWin, 2), 'green')}`);
  console.log(`Avg loss: ${colorize(formatNumber(s.avgLoss, 2), 'red')}`);
  console.log(
    `Profit factor: ${colorize(
      Number.isFinite(s.profitFactor) ? formatNumber(s.profitFactor, 3) : 'Infinity',
      pfColor
    )}`
  );
  console.log(`Стартовый баланс: ${formatNumber(s.startBalance, 2)}`);
  console.log(`Финальный баланс: ${formatNumber(s.endBalance, 2)}`);
  console.log(`Доходность: ${colorize(formatNumber(s.returnPct * 100, 2) + '%', retColor)}`);
  console.log(`Макс. просадка: ${formatNumber(s.maxDrawdownAbs, 2)}`);
  console.log(`Макс. просадка %: ${formatNumber(s.maxDrawdownPct * 100, 2)}%`);

  if (result.options.htfFilter) {
    const h = result.htfStats;
    console.log(
      `HTF rejects / passes / warmup: ${h.rejects} / ${h.passes} / ${h.warmupRejects}`
    );
  }
}

function printRegimeStats(result: ReturnType<typeof runStrategyBacktest>): void {
  const rs = result.regimeStats;
  if (!rs || rs.totalBars === 0) {
    console.log('\n========== REGIME STATS ==========');
    console.log('Нет данных по режимам (totalBars=0).');
    return;
  }

  const order = [
    'trend_up',
    'trend_down',
    'range',
    'high_volatility',
    'breakout_watch',
    'unknown'
  ];

  console.log('\n========== REGIME STATS ==========');
  console.log(`Баров после warmup: ${rs.totalBars}`);
  console.log(`Side filter: ${result.options.sideFilter}`);

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

  console.log(`Bars: ${barParts.join(' | ')}`);

  console.log('\nTrades by regime (группы, как в summary):');
  const tradeRegs = [
    ...order.filter(r => rs.tradesByRegime[r]),
    ...Object.keys(rs.tradesByRegime).filter(r => !order.includes(r))
  ];
  if (!tradeRegs.length) {
    console.log(' (сделок нет)');
  }

  for (const reg of tradeRegs) {
    const t = rs.tradesByRegime[reg];
    const pf = Number.isFinite(t.profitFactor) ? t.profitFactor.toFixed(3) : 'Infinity';
    const wr = (t.winRate * 100).toFixed(1);
    const reasons = Object.entries(t.closeReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    console.log(
      ` ${reg}: n=${t.trades} WR=${wr}% PF=${pf} net=${t.netProfit.toFixed(2)} ` +
        `avgBars=${t.avgBarsHeld} | ${reasons || '—'}`
    );
  }

  const allReasons = Object.entries(rs.closeReasonsAll)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' | ');
  console.log(`\nClose reasons (все ноги): ${allReasons || '—'}`);

  const trendBars =
    (rs.barsByRegime['trend_up']?.bars ?? 0) + (rs.barsByRegime['trend_down']?.bars ?? 0);
  const trendPct = rs.totalBars > 0 ? (100 * trendBars) / rs.totalBars : 0;
  console.log(
    `\nNote: trend_up+trend_down ≈ ${trendPct.toFixed(1)}% баров ` +
      `(стратегия торгует только там; side=${result.options.sideFilter}).`
  );
}

function printTrades(result: ReturnType<typeof runStrategyBacktest>, limit?: number): void {
  const all = result.trades;
  const trades = limit != null && limit > 0 ? all.slice(-limit) : all;
  const title =
    limit != null && limit > 0 && limit < all.length
      ? `ПОСЛЕДНИЕ ${trades.length} ИЗ ${all.length} НОГ`
      : `ВСЕ НОГИ СДЕЛОК (${trades.length})`;

  console.log(`\n========== ${title} ==========`);
  if (!trades.length) {
    console.log('Сделок нет.');
    return;
  }

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    const num =
      limit != null && limit > 0 && limit < all.length
        ? all.length - trades.length + i + 1
        : i + 1;
    const line = [
      `#${num}`,
      `Открыта: ${formatDate(trade.openedAt)}`,
      `Закрыта: ${formatDate(trade.closedAt)}`,
      `Сторона: ${trade.side}`,
      `Режим: ${trade.regime}`,
      `Вход: ${formatNumber(trade.entryPrice, 4)}`,
      `Выход: ${formatNumber(trade.exitPrice, 4)}`,
      `SL: ${formatNumber(trade.stopLossPrice, 4)}`,
      `TP: ${formatNumber(trade.takeProfitPrice, 4)}`,
      `Qty: ${formatNumber(trade.quantity, 0)}`,
      `Leg: ${trade.leg}`,
      `Причина: ${trade.closeReason}`,
      `Net PnL: ${formatNumber(trade.netPnl, 2)}`,
      `Комиссия: ${formatNumber(trade.totalCommission, 2)}`,
      `Bars: ${trade.barsHeld}`
    ].join(' | ');

    if (trade.netPnl > 0) console.log(colorize(line, 'green'));
    else if (trade.netPnl < 0) console.log(colorize(line, 'red'));
    else console.log(colorize(line, 'yellow'));
  }
}

function printUsage(): void {
  console.log(`
Использование:
npx ts-node src/backtest/runBacktest.ts <file.json> [SYMBOL] [cooldown] [htf|nohtf] [both|long|short]

htf и side — в любом порядке (4-й / 5-й аргумент).

Примеры:
npx ts-node src/backtest/runBacktest.ts ./src/backtest/data/SBER_15m.json SBER 12 htf
npx ts-node src/backtest/runBacktest.ts ./src/backtest/data/SBER_15m.json SBER 12 htf short
npx ts-node src/backtest/runBacktest.ts ./src/backtest/data/SBER_15m.json SBER 12 short htf
npx ts-node src/backtest/runBacktest.ts ./src/backtest/data/NVTK_15m.json NVTK 12 htf long
npx ts-node src/backtest/runBacktest.ts ./src/backtest/data/NVTK_15m.json NVTK 12 htf=18 both
`);
}

function main(): void {
  const [, , inputPathArg, symbolArg, cooldownCandlesArg, arg4, arg5] = process.argv;
  if (!inputPathArg || !symbolArg) {
    printUsage();
    process.exit(1);
  }

  const cooldownCandles = parseCooldownCandles(cooldownCandlesArg);
  const { htfFilter, htfMinAdx1h, sideFilter } = parseHtfAndSide(arg4, arg5);
  const absolutePath = path.resolve(process.cwd(), inputPathArg);
  if (!fs.existsSync(absolutePath)) {
    console.error(`Файл не найден: ${absolutePath}`);
    process.exit(1);
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
  } catch (e) {
    console.error('Не удалось распарсить JSON.', e);
    process.exit(1);
  }

  let candles: Candle[];
  try {
    candles = normalizeCandles(rawJson);
  } catch (e) {
    console.error('Ошибка структуры свечей.', e);
    process.exit(1);
    return;
  }

  if (candles.length < 300) {
    console.warn(`Мало свечей: ${candles.length}.`);
  }

  const estimated = estimateBacktestTime(candles.length);
  const warmup = htfFilter ? Math.max(250, HTF_WARMUP_15M) : 250;

  console.log('\n========== ПАРАМЕТРЫ ЗАПУСКА ==========');
  console.log(`Файл: ${absolutePath}`);
  console.log(`Инструмент: ${symbolArg}`);
  console.log(`Свечей загружено: ${candles.length}`);
  console.log(
    `Период данных: ${formatDate(candles[0].time)} -> ${formatDate(
      candles[candles.length - 1].time
    )}`
  );
  console.log(`Cooldown после сделки: ${cooldownCandles} свеч. (после любой)`);
  console.log(`Side filter: ${sideFilter}`);
  console.log(
    `Оценка времени: ~ ${formatDuration(estimated.minSec)} - ${formatDuration(
      estimated.maxSec
    )}`
  );
  console.log(`Лог прогресса: каждые ${PROGRESS_LOG_EVERY} свечей`);
  console.log(`Риск на сделку: ${MAX_RISK_PER_TRADE * 100}%`);
  console.log(
    `Модель выхода: TP1 40%@1.5R → lock 0R → TP2@2.0R | abort 16b/0.35R | TS 64`
  );
  console.log(`Лимит входов в день: выкл.`);
  console.log(`Time-stop / abort: 64 бар / 16 бар @ 0.35R`);
  console.log(`Кап стопа: ≤ 1.2% цены`);
  console.log(`Warmup: ${warmup} бар`);
  console.log(htfFilter ? `HTF 1h filter: ON (minAdx1h=${htfMinAdx1h})` : 'HTF 1h filter: OFF');

  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    console.log(
      `[${new Date().toISOString()}] Бэктест... ${formatDuration(
        (Date.now() - startedAt) / 1000
      )}`
    );
  }, 15000);

  let result: ReturnType<typeof runStrategyBacktest>;
  try {
    console.log(`Прогресс: 0/${candles.length} свечей`);
    result = runStrategyBacktest(symbolArg, candles, {
      startingBalance: STARTING_BALANCE,
      commissionRate: 0.0005,
      warmupCandles: warmup,
      onePositionAtTime: true,
      conservativeIntrabarExecution: true,
      cooldownCandles,
      progressLogEvery: PROGRESS_LOG_EVERY,
      maxTradesPerDay: 0,
      timeStopBars: 64,
      earlyAbortBars: 16,
      earlyAbortMinR: 0.35,
      runnerTrailR: 0,
      htfFilter,
      htfMinAdx1h,
      sideFilter
    });
  } finally {
    clearInterval(heartbeat);
  }

  console.log('\n========== ВРЕМЯ ВЫПОЛНЕНИЯ ==========');
  console.log(`Фактическое время: ${formatDuration((Date.now() - startedAt) / 1000)}`);
  printSummary(result);
  printRegimeStats(result);
  printTrades(result);
}

main();
