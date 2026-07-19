import fs from 'node:fs';
import path from 'node:path';
import { runStrategyBacktest } from './strategyBacktest';
import {
  Candle,
  PARTIAL_LOCK_R,
  RUNNER_TRAIL_ATR_MULT,
  TP1_FRACTION,
  TP1_R
} from '../services/strategy';

const DEFAULT_COOLDOWN_CANDLES = 12;
const DEFAULT_RUNNER_TRAIL_ATR_MULT = RUNNER_TRAIL_ATR_MULT;
const PROGRESS_LOG_EVERY = 5000;

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

function parseRunnerTrailAtrMult(value: string | undefined): number {
  if (value == null) return DEFAULT_RUNNER_TRAIL_ATR_MULT;

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `Некорректный runnerTrailAtrMult="${value}", default ${DEFAULT_RUNNER_TRAIL_ATR_MULT}.`
    );
    return DEFAULT_RUNNER_TRAIL_ATR_MULT;
  }

  return parsed;
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

function printSummary(result: ReturnType<typeof runStrategyBacktest>) {
  const s = result.summary;

  const netColor =
    s.netProfit > 0 ? 'green' : s.netProfit < 0 ? 'red' : 'yellow';

  const retColor =
    s.returnPct > 0 ? 'green' : s.returnPct < 0 ? 'red' : 'yellow';

  const pfColor =
    s.profitFactor >= 1.2
      ? 'green'
      : s.profitFactor >= 1
        ? 'yellow'
        : 'red';

  console.log('\n========== ИТОГИ БЭКТЕСТА ==========');
  console.log(`Инструмент:            ${s.symbol}`);
  console.log(`Сделок (групп):        ${s.tradesCount}`);
  console.log(`Побед:                 ${colorize(String(s.wins), 'green')}`);
  console.log(`Поражений:             ${colorize(String(s.losses), 'red')}`);
  console.log(`Win rate:              ${formatNumber(s.winRate * 100, 2)}%`);
  console.log(
    `Gross profit:          ${colorize(formatNumber(s.grossProfit, 2), 'green')}`
  );
  console.log(
    `Gross loss:            ${colorize(formatNumber(s.grossLoss, 2), 'red')}`
  );
  console.log(
    `Net profit:            ${colorize(formatNumber(s.netProfit, 2), netColor)}`
  );
  console.log(`Avg net pnl:           ${formatNumber(s.avgNetPnl, 2)}`);
  console.log(
    `Avg win:               ${colorize(formatNumber(s.avgWin, 2), 'green')}`
  );
  console.log(
    `Avg loss:              ${colorize(formatNumber(s.avgLoss, 2), 'red')}`
  );
  console.log(
    `Profit factor:         ${colorize(
      Number.isFinite(s.profitFactor)
        ? formatNumber(s.profitFactor, 3)
        : 'Infinity',
      pfColor
    )}`
  );
  console.log(`Стартовый баланс:      ${formatNumber(s.startBalance, 2)}`);
  console.log(`Финальный баланс:      ${formatNumber(s.endBalance, 2)}`);
  console.log(
    `Доходность:            ${colorize(
      `${formatNumber(s.returnPct * 100, 2)}%`,
      retColor
    )}`
  );
  console.log(`Макс. просадка:        ${formatNumber(s.maxDrawdownAbs, 2)}`);
  console.log(
    `Макс. просадка %:      ${formatNumber(s.maxDrawdownPct * 100, 2)}%`
  );
}

function printTrades(
  result: ReturnType<typeof runStrategyBacktest>,
  limit?: number
) {
  const all = result.trades;
  const trades =
    limit != null && limit > 0
      ? all.slice(-limit)
      : all;

  const title =
    limit != null && limit > 0 && limit < all.length
      ? `ПОСЛЕДНИЕ ${trades.length} ИЗ ${all.length} НОГ`
      : `ВСЕ НОГИ СДЕЛОК (${trades.length})`;

  console.log(`\n========== ${title} ==========`);

  if (!trades.length) {
    console.log('Сделок нет.');
    return;
  }

  for (let i = 0; i < trades.length; i += 1) {
    const trade = trades[i];

    const num =
      limit != null && limit > 0 && limit < all.length
        ? all.length - trades.length + i + 1
        : i + 1;

    const tpText =
      trade.takeProfitPrice == null
        ? 'n/a'
        : formatNumber(trade.takeProfitPrice, 4);

    const line = [
      `#${num}`,
      `Открыта: ${formatDate(trade.openedAt)}`,
      `Закрыта: ${formatDate(trade.closedAt)}`,
      `Сторона: ${trade.side}`,
      `Режим: ${trade.regime}`,
      `Вход: ${formatNumber(trade.entryPrice, 4)}`,
      `Выход: ${formatNumber(trade.exitPrice, 4)}`,
      `SL: ${formatNumber(trade.stopLossPrice, 4)}`,
      `TP: ${tpText}`,
      `Qty: ${formatNumber(trade.quantity, 0)}`,
      `Leg: ${trade.leg}`,
      `Причина: ${trade.closeReason}`,
      `Net PnL: ${formatNumber(trade.netPnl, 2)}`,
      `Комиссия: ${formatNumber(trade.totalCommission, 2)}`,
      `Bars: ${trade.barsHeld}`
    ].join(' | ');

    if (trade.netPnl > 0) {
      console.log(colorize(line, 'green'));
    } else if (trade.netPnl < 0) {
      console.log(colorize(line, 'red'));
    } else {
      console.log(colorize(line, 'yellow'));
    }
  }
}

function printUsage() {
  console.log(`
Использование:
  npm run backtest -- <path-to-json> <symbol> [cooldownCandles] [runnerTrailAtrMult]

Примеры:
  npm run backtest -- ./src/backtest/data/SBER_15m.json SBER
  npm run backtest -- ./src/backtest/data/SBER_15m.json SBER 12
  npm run backtest -- ./src/backtest/data/SBER_15m.json SBER 12 2.5
  npm run backtest -- ./src/backtest/data/SBER_15m.json SBER 12 3.0
`);
}

function main() {
  const [
    ,
    ,
    inputPathArg,
    symbolArg,
    cooldownCandlesArg,
    runnerTrailAtrMultArg
  ] = process.argv;

  if (!inputPathArg || !symbolArg) {
    printUsage();
    process.exit(1);
  }

  const cooldownCandles = parseCooldownCandles(cooldownCandlesArg);
  const runnerTrailAtrMult = parseRunnerTrailAtrMult(runnerTrailAtrMultArg);

  const absolutePath = path.resolve(process.cwd(), inputPathArg);

  if (!fs.existsSync(absolutePath)) {
    console.error(`Файл не найден: ${absolutePath}`);
    process.exit(1);
  }

  let rawJson: unknown;

  try {
    rawJson = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
  } catch (error) {
    console.error('Не удалось распарсить JSON.', error);
    process.exit(1);
  }

  let candles: Candle[];

  try {
    candles = normalizeCandles(rawJson);
  } catch (error) {
    console.error('Ошибка структуры свечей.', error);
    process.exit(1);
    return;
  }

  if (candles.length < 300) {
    console.warn(`Мало свечей: ${candles.length}.`);
  }

  const estimated = estimateBacktestTime(candles.length);

  console.log('\n========== ПАРАМЕТРЫ ЗАПУСКА ==========');
  console.log(`Файл:                  ${absolutePath}`);
  console.log(`Инструмент:            ${symbolArg}`);
  console.log(`Свечей загружено:      ${candles.length}`);
  console.log(
    `Период данных:         ${formatDate(candles[0].time)} -> ${formatDate(
      candles[candles.length - 1].time
    )}`
  );
  console.log(
    `Cooldown после сделки:  ${cooldownCandles} свеч. (после любой)`
  );
  console.log(
    `Оценка времени:        ~ ${formatDuration(estimated.minSec)} - ${formatDuration(
      estimated.maxSec
    )}`
  );
  console.log(`Лог прогресса:         каждые ${PROGRESS_LOG_EVERY} свечей`);
  console.log(`Риск на сделку:        1%`);
  console.log(
    `Модель выхода:         TP1 ${formatNumber(TP1_FRACTION * 100, 0)}%@${formatNumber(TP1_R, 1)}R → lock ${formatNumber(PARTIAL_LOCK_R, 1)}R → ATR trail x${formatNumber(runnerTrailAtrMult, 2)}`
  );
  console.log(`Лимит входов в день:   выкл.`);
  console.log(`Time-stop / abort:     120 бар / выкл.`);
  console.log(`Кап стопа:             ≤ 1.2% цены`);
  console.log(`Runner ATR mult:       ${formatNumber(runnerTrailAtrMult, 2)}`);

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
    console.log(`Прогресс:              0/${candles.length} свечей`);

    result = runStrategyBacktest(symbolArg, candles, {
      startingBalance: 50000,
      commissionRate: 0.0005,
      warmupCandles: 250,
      onePositionAtTime: true,
      conservativeIntrabarExecution: true,
      cooldownCandles,
      progressLogEvery: PROGRESS_LOG_EVERY,
      maxTradesPerDay: 0,
      timeStopBars: 120,
      earlyAbortBars: 0,
      earlyAbortMinR: 0.25,
      runnerTrailAtrMult
    });
  } finally {
    clearInterval(heartbeat);
  }

  console.log('\n========== ВРЕМЯ ВЫПОЛНЕНИЯ ==========');
  console.log(
    `Фактическое время:     ${formatDuration((Date.now() - startedAt) / 1000)}`
  );

  printSummary(result);
  printTrades(result);
}

main();
