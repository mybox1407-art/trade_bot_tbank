import fs from 'node:fs';
import path from 'node:path';
import { runStrategyBacktest } from './strategyBacktest';
import { Candle } from '../services/strategy';

/**
 * Количество свечей паузы после убыточной сделки / стопа.
 * Можно менять через CLI четвертым аргументом.
 */
const DEFAULT_COOLDOWN_CANDLES = 4;

/**
 * Как часто печатать прогресс в консоль.
 * Например, раз в 5000 обработанных свечей.
 */
const PROGRESS_LOG_EVERY = 5000;

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
 * Это грубая эвристика, чтобы пользователь видел,
 * что процесс не завис и примерно сколько можно ждать.
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
 * Печать итоговой статистики.
 */
function printSummary(result: ReturnType<typeof runStrategyBacktest>) {
  const s = result.summary;

  console.log('\n========== ИТОГИ БЭКТЕСТА ==========');
  console.log(`Инструмент:            ${s.symbol}`);
  console.log(`Сделок:                ${s.tradesCount}`);
  console.log(`Побед:                 ${s.wins}`);
  console.log(`Поражений:             ${s.losses}`);
  console.log(`Win rate:              ${formatNumber(s.winRate * 100, 2)}%`);
  console.log(`Gross profit:          ${formatNumber(s.grossProfit, 2)}`);
  console.log(`Gross loss:            ${formatNumber(s.grossLoss, 2)}`);
  console.log(`Net profit:            ${formatNumber(s.netProfit, 2)}`);
  console.log(`Avg net pnl:           ${formatNumber(s.avgNetPnl, 2)}`);
  console.log(`Avg win:               ${formatNumber(s.avgWin, 2)}`);
  console.log(`Avg loss:              ${formatNumber(s.avgLoss, 2)}`);
  console.log(
    `Profit factor:         ${Number.isFinite(s.profitFactor) ? formatNumber(s.profitFactor, 3) : 'Infinity'}`
  );
  console.log(`Стартовый баланс:      ${formatNumber(s.startBalance, 2)}`);
  console.log(`Финальный баланс:      ${formatNumber(s.endBalance, 2)}`);
  console.log(`Доходность:            ${formatNumber(s.returnPct * 100, 2)}%`);
  console.log(`Макс. просадка:        ${formatNumber(s.maxDrawdownAbs, 2)}`);
  console.log(`Макс. просадка %:      ${formatNumber(s.maxDrawdownPct * 100, 2)}%`);
}

/**
 * Печать последних N сделок.
 */
function printLastTrades(result: ReturnType<typeof runStrategyBacktest>, limit = 10) {
  const trades = result.trades.slice(-limit);

  console.log(`\n========== ПОСЛЕДНИЕ ${trades.length} СДЕЛОК ==========`);

  if (!trades.length) {
    console.log('Сделок нет.');
    return;
  }

  for (const trade of trades) {
    console.log(
      [
        `Открыта: ${formatDate(trade.openedAt)}`,
        `Закрыта: ${formatDate(trade.closedAt)}`,
        `Сторона: ${trade.side}`,
        `Режим: ${trade.regime}`,
        `Вход: ${formatNumber(trade.entryPrice, 4)}`,
        `Выход: ${formatNumber(trade.exitPrice, 4)}`,
        `Причина: ${trade.closeReason}`,
        `Net PnL: ${formatNumber(trade.netPnl, 2)}`,
        `Комиссия: ${formatNumber(trade.totalCommission, 2)}`
      ].join(' | ')
    );
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
  console.log(`Период данных:         ${formatDate(candles[0].time)} -> ${formatDate(candles[candles.length - 1].time)}`);
  console.log(`Cooldown после убытка: ${cooldownCandles} свеч.`);
  console.log(
    `Оценка времени:        ~ ${formatDuration(estimated.minSec)} - ${formatDuration(estimated.maxSec)}`
  );
  console.log(`Лог прогресса:         каждые ${PROGRESS_LOG_EVERY} свечей`);

  /**
   * Простой heartbeat в консоль.
   * Нужен только чтобы пользователь видел, что процесс жив.
   * Он не знает реального прогресса внутри strategyBacktest,
   * но показывает, что Node не завис.
   */
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSec = (Date.now() - startedAt) / 1000;
    console.log(`[${new Date().toISOString()}] Бэктест выполняется... прошло ${formatDuration(elapsedSec)}`);
  }, 15000);

  let result: ReturnType<typeof runStrategyBacktest>;

  try {
    const progressMarkers = Math.max(1, Math.floor(candles.length / PROGRESS_LOG_EVERY));

    // Информационное сообщение перед тяжелым расчетом
    console.log(`Прогресс:              0/${candles.length} свечей`);
    console.log(`Ожидаемое число логов: ~ ${progressMarkers}`);

    result = runStrategyBacktest(symbolArg, candles, {
      startingBalance: 50000,
      commissionRate: 0.003,
      warmupCandles: 250,
      onePositionAtTime: true,
      conservativeIntrabarExecution: true,

      // Пауза после убыточной сделки / стопа.
      // Важно: strategyBacktest.ts должен уметь принимать и обрабатывать этот параметр.
      cooldownCandles
    });
  } finally {
    clearInterval(heartbeat);
  }

  const totalElapsedSec = (Date.now() - startedAt) / 1000;

  console.log('\n========== ВРЕМЯ ВЫПОЛНЕНИЯ ==========');
  console.log(`Фактическое время:     ${formatDuration(totalElapsedSec)}`);

  printSummary(result);
  printLastTrades(result, 10);
}

main();
