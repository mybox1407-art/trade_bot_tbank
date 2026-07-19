import fs from 'node:fs';
import path from 'node:path';
import { runStrategyBacktest } from './strategyBacktest';
import { Candle } from '../services/strategy';

/**
 * Количество свечей паузы после убыточной сделки / стопа.
 * Можно менять через CLI четвертым аргументом.
 */
const DEFAULT_COOLDOWN_CANDLES = 6;

/**
 * Как часто печатать прогресс в консоль.
 * Например, раз в 5000 обработанных свечей.
 */
const PROGRESS_LOG_EVERY = 5000;

/** ANSI-цвета для терминала */
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
} as const;

/**
 * Окраска строки. Если stdout не TTY — без escape-кодов.
 */
function colorize(text: string, color: keyof typeof ANSI): string {
  if (!process.stdout.isTTY) {
    return text;
  }
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

/**
 * Преобразование значения в число.
 */
function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Проверка, что объект похож на свечу.
 */
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

/**
 * Нормализация массива свечей.
 * На выходе всегда числа и сортировка по времени.
 */
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

/**
 * Короткое форматирование числа для красивого вывода.
 */
function formatNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return 'NaN';
  return value.toFixed(digits);
}

/**
 * Форматирование даты для консоли.
 */
function formatDate(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toISOString();
}

/**
 * Чтение количества свечей cooldown из CLI.
 * Если аргумент не передан или некорректен — берем значение по умолчанию.
 */
function parseCooldownCandles(value: string | undefined): number {
  if (value == null) {
    return DEFAULT_COOLDOWN_CANDLES;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `Некорректный cooldownCandles="${value}", будет использовано значение по умолчанию ${DEFAULT_COOLDOWN_CANDLES}.`
    );
    return DEFAULT_COOLDOWN_CANDLES;
  }

  return parsed;
}

/**
 * Форматирование секунд в человекочитаемый вид.
 */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 'неизвестно';
  }

  if (seconds < 60) {
    return `${Math.round(seconds)} сек`;
  }

  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);

  if (minutes < 60) {
    return `${minutes} мин ${secs} сек`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  return `${hours} ч ${mins} мин`;
}

/**
 * Оценка времени выполнения бэктеста по числу свечей.
 */
function estimateBacktestTime(candlesCount: number): { minSec: number; maxSec: number } {
  if (candlesCount <= 5000) {
    return { minSec: 5, maxSec: 20 };
  }

  if (candlesCount <= 15000) {
    return { minSec: 15, maxSec: 60 };
  }

  if (candlesCount <= 30000) {
    return { minSec: 30, maxSec: 120 };
  }

  if (candlesCount <= 60000) {
    return { minSec: 60, maxSec: 300 };
  }

  return { minSec: 180, maxSec: 600 };
}

/**
 * Печать итоговой статистики (с цветом net profit / return).
 */
function printSummary(result: ReturnType<typeof runStrategyBacktest>) {
  const s = result.summary;

  const netColor = s.netProfit > 0 ? 'green' : s.netProfit < 0 ? 'red' : 'yellow';
  const retColor = s.returnPct > 0 ? 'green' : s.returnPct < 0 ? 'red' : 'yellow';
  const pfColor =
    s.profitFactor >= 1.2 ? 'green' : s.profitFactor >= 1 ? 'yellow' : 'red';

  console.log('\n========== ИТОГИ БЭКТЕСТА ==========');
  console.log(`Инструмент:            ${s.symbol}`);
  console.log(`Сделок:                ${s.tradesCount}`);
  console.log(`Побед:                 ${colorize(String(s.wins), 'green')}`);
  console.log(`Поражений:             ${colorize(String(s.losses), 'red')}`);
  console.log(`Win rate:              ${formatNumber(s.winRate * 100, 2)}%`);
  console.log(`Gross profit:          ${colorize(formatNumber(s.grossProfit, 2), 'green')}`);
  console.log(`Gross loss:            ${colorize(formatNumber(s.grossLoss, 2), 'red')}`);
  console.log(
    `Net profit:            ${colorize(formatNumber(s.netProfit, 2), netColor)}`
  );
  console.log(`Avg net pnl:           ${formatNumber(s.avgNetPnl, 2)}`);
  console.log(`Avg win:               ${colorize(formatNumber(s.avgWin, 2), 'green')}`);
  console.log(`Avg loss:              ${colorize(formatNumber(s.avgLoss, 2), 'red')}`);
  console.log(
    `Profit factor:         ${colorize(
      Number.isFinite(s.profitFactor) ? formatNumber(s.profitFactor, 3) : 'Infinity',
      pfColor
    )}`
  );
  console.log(`Стартовый баланс:      ${formatNumber(s.startBalance, 2)}`);
  console.log(`Финальный баланс:      ${formatNumber(s.endBalance, 2)}`);
  console.log(
    `Доходность:            ${colorize(formatNumber(s.returnPct * 100, 2) + '%', retColor)}`
  );
  console.log(`Макс. просадка:        ${formatNumber(s.maxDrawdownAbs, 2)}`);
  console.log(`Макс. просадка %:      ${formatNumber(s.maxDrawdownPct * 100, 2)}%`);
}

/**
 * Печать сделок.
 * Без limit — все сделки.
 * С limit — только последние N.
 *
 * Прибыльные — зелёные, убыточные — красные, BE (~0) — жёлтые.
 */
function printTrades(result: ReturnType<typeof runStrategyBacktest>, limit?: number) {
  const all = result.trades;
  const trades = limit != null && limit > 0 ? all.slice(-limit) : all;

  const title =
    limit != null && limit > 0 && limit < all.length
      ? `ПОСЛЕДНИЕ ${trades.length} ИЗ ${all.length} СДЕЛОК`
      : `ВСЕ СДЕЛКИ (${trades.length})`;

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
      `Причина: ${trade.closeReason}`,
      `Net PnL: ${formatNumber(trade.netPnl, 2)}`,
      `Комиссия: ${formatNumber(trade.totalCommission, 2)}`,
      `Bars: ${trade.barsHeld}`
    ].join(' | ');

    // > 0 — win (зелёный), < 0 — loss (красный), ≈0 — BE (жёлтый)
    if (trade.netPnl > 0) {
      console.log(colorize(line, 'green'));
    } else if (trade.netPnl < 0) {
      console.log(colorize(line, 'red'));
    } else {
      console.log(colorize(line, 'yellow'));
    }
  }
}

/**
 * Печать подсказки по запуску.
 */
function printUsage() {
  console.log(`
Использование:
  npm run backtest -- <path-to-json> <symbol> [cooldownCandles]

Пример:
  npm run backtest -- ./src/backtest/data/SBER_15m.json SBER
  npm run backtest -- ./src/backtest/data/SBER_15m.json SBER 4
`);
}

/**
 * Основная CLI-функция.
 */
function main() {
  const [, , inputPathArg, symbolArg, cooldownCandlesArg] = process.argv;

  if (!inputPathArg || !symbolArg) {
    printUsage();
    process.exit(1);
  }

  const cooldownCandles = parseCooldownCandles(cooldownCandlesArg);
  const absolutePath = path.resolve(process.cwd(), inputPathArg);

  if (!fs.existsSync(absolutePath)) {
    console.error(`Файл не найден: ${absolutePath}`);
    process.exit(1);
  }

  const fileContent = fs.readFileSync(absolutePath, 'utf-8');

  let rawJson: unknown;

  try {
    rawJson = JSON.parse(fileContent);
  } catch (error) {
    console.error('Не удалось распарсить JSON.');
    console.error(error);
    process.exit(1);
  }

  let candles: Candle[];

  try {
    candles = normalizeCandles(rawJson);
  } catch (error) {
    console.error('Ошибка в структуре данных свечей.');
    console.error(error);
    process.exit(1);
    return;
  }

  if (candles.length < 300) {
    console.warn(
      `Предупреждение: свечей всего ${candles.length}. Для стратегии с EMA200 и warmup лучше иметь заметно больше истории.`
    );
  }

  const estimated = estimateBacktestTime(candles.length);

  console.log('\n========== ПАРАМЕТРЫ ЗАПУСКА ==========');
  console.log(`Файл:                  ${absolutePath}`);
  console.log(`Инструмент:            ${symbolArg}`);
  console.log(`Свечей загружено:      ${candles.length}`);
  console.log(
    `Период данных:         ${formatDate(candles[0].time)} -> ${formatDate(candles[candles.length - 1].time)}`
  );
  console.log(`Cooldown после убытка: ${cooldownCandles} свеч.`);
  console.log(
    `Оценка времени:        ~ ${formatDuration(estimated.minSec)} - ${formatDuration(estimated.maxSec)}`
  );
  console.log(`Лог прогресса:         каждые ${PROGRESS_LOG_EVERY} свечей`);
  console.log(`Breakeven после:       1.0 R`);
  console.log(`Trail после BE:        1.2 R`);

  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSec = (Date.now() - startedAt) / 1000;
    console.log(
      `[${new Date().toISOString()}] Бэктест выполняется... прошло ${formatDuration(elapsedSec)}`
    );
  }, 15000);

  let result: ReturnType<typeof runStrategyBacktest>;

  try {
    const progressMarkers = Math.max(1, Math.floor(candles.length / PROGRESS_LOG_EVERY));

    console.log(`Прогресс:              0/${candles.length} свечей`);
    console.log(`Ожидаемое число логов: ~ ${progressMarkers}`);

    result = runStrategyBacktest(symbolArg, candles, {
      startingBalance: 50000,
      commissionRate: 0.0005,
      warmupCandles: 250,
      onePositionAtTime: true,
      conservativeIntrabarExecution: true,
      cooldownCandles,
      progressLogEvery: PROGRESS_LOG_EVERY,
      // После 1R в плюс — стоп в BE
      moveToBreakevenR: 1.0,
      // Затем трейл 1.2R от экстремума (0 = только BE)
      trailAfterBreakevenR: 1.2
    });
  } finally {
    clearInterval(heartbeat);
  }

  const totalElapsedSec = (Date.now() - startedAt) / 1000;

  console.log('\n========== ВРЕМЯ ВЫПОЛНЕНИЯ ==========');
  console.log(`Фактическое время:     ${formatDuration(totalElapsedSec)}`);

  printSummary(result);
  printTrades(result);
}

main();
