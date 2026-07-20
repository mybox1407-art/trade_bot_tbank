import fs from 'node:fs';
import path from 'node:path';
import { Candle } from '../services/dailyBreakoutStrategy';
import { runDailyUniverseBacktest } from './dailyUniverseBacktest';

const DEFAULT_PROGRESS_LOG_EVERY = 250;

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
  return d.toISOString().slice(0, 10);
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

function estimateBacktestTime(candlesCount: number): { minSec: number; maxSec: number } {
  if (candlesCount <= 1000) return { minSec: 2, maxSec: 8 };
  if (candlesCount <= 2500) return { minSec: 5, maxSec: 20 };
  if (candlesCount <= 5000) return { minSec: 10, maxSec: 35 };
  return { minSec: 20, maxSec: 60 };
}

function parseNumberArg(args: string[], name: string, fallback: number): number {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  if (!arg) return fallback;

  const n = Number(arg.split('=')[1]);
  if (!Number.isFinite(n)) {
    console.warn(`Некорректный --${name}, default ${fallback}`);
    return fallback;
  }
  return n;
}

function parseBoolArg(args: string[], name: string, fallback: boolean): boolean {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  if (!arg) return fallback;

  const raw = arg.split('=')[1]?.trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;

  console.warn(`Некорректный --${name}, default ${fallback}`);
  return fallback;
}

function printSummary(result: ReturnType<typeof runDailyUniverseBacktest>): void {
  const s = result.summary;
  const netColor = s.netProfit > 0 ? 'green' : s.netProfit < 0 ? 'red' : 'yellow';
  const retColor = s.returnPct > 0 ? 'green' : s.returnPct < 0 ? 'red' : 'yellow';
  const pfColor =
    s.profitFactor >= 1.2 ? 'green' : s.profitFactor >= 1 ? 'yellow' : 'red';
  const sharpeColor =
    s.sharpe >= 1 ? 'green' : s.sharpe >= 0.5 ? 'yellow' : 'red';

  console.log('\n========== ИТОГИ DAILY UNIVERSE БЭКТЕСТА ==========');
  console.log(`Universe: ${s.universe.join(', ')}`);
  console.log(`Сделок: ${s.tradesCount}`);
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
  console.log(`Sharpe: ${colorize(formatNumber(s.sharpe, 3), sharpeColor)}`);
  console.log(`Стартовый баланс: ${formatNumber(s.startBalance, 2)}`);
  console.log(`Финальный баланс: ${formatNumber(s.endBalance, 2)}`);
  console.log(
    `Доходность: ${colorize(formatNumber(s.returnPct * 100, 2) + '%', retColor)}`
  );
  console.log(`Макс. просадка: ${formatNumber(s.maxDrawdownAbs, 2)}`);
  console.log(`Макс. просадка %: ${formatNumber(s.maxDrawdownPct * 100, 2)}%`);
  console.log(`Лет в тесте: ${formatNumber(s.yearsCount, 2)}`);
}

function printSelectionStats(result: ReturnType<typeof runDailyUniverseBacktest>): void {
  const st = result.selectionStats;
  console.log('\n========== SELECTION STATS ==========');
  console.log(`Decision days: ${st.totalDecisionDays}`);
  console.log(`No-signal days: ${st.noSignalDays}`);
  console.log(`Signals accepted: ${st.signalsAccepted}`);
  console.log(`Signals rejected: ${st.signalsRejected}`);
  console.log(
    `Picked by side: ${
      Object.entries(st.pickedBySide)
        .map(([k, v]) => `${k}=${v}`)
        .join(' | ') || '—'
    }`
  );
  console.log(
    `Picked by symbol: ${
      Object.entries(st.pickedBySymbol)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(' | ') || '—'
    }`
  );
}

function printTrades(
  result: ReturnType<typeof runDailyUniverseBacktest>,
  limit = 20
): void {
  const all = result.trades;
  const trades = limit > 0 ? all.slice(-limit) : all;

  console.log(`\n========== ПОСЛЕДНИЕ ${trades.length} СДЕЛОК ==========`);

  if (!trades.length) {
    console.log('Сделок нет.');
    return;
  }

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    const line = [
      `#${all.length - trades.length + i + 1}`,
      `Тикер: ${trade.symbol}`,
      `Открыта: ${formatDate(trade.openedAt)}`,
      `Закрыта: ${formatDate(trade.closedAt)}`,
      `Сторона: ${trade.side}`,
      `Режим: ${trade.regime}`,
      `Вход: ${formatNumber(trade.entryPrice, 4)}`,
      `Выход: ${formatNumber(trade.exitPrice, 4)}`,
      `SL: ${formatNumber(trade.stopLossPrice, 4)}`,
      `Trail: ${formatNumber(trade.trailingStopPrice, 4)}`,
      `Rev: ${formatNumber(trade.reverseLevel, 4)}`,
      `Qty: ${formatNumber(trade.quantity, 0)}`,
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
npx tsx src/backtest/runDailyUniverseBacktest.ts <json1:symbol1> <json2:symbol2> ... [опции]

Формат инструмента:
  ./src/backtest/data/SBER_D.json:SBER

Опции:
  --balance=50000
  --commission=0.0005
  --warmup=30
  --risk=0.01
  --stopAtr=2.5
  --trailAtr=2.0
  --minAtrPct=0.008
  --maxAtrPct=0.12
  --maxBreakoutDistancePct=0.04
  --allowLongs=true
  --allowShorts=true

Пример:
npx tsx src/backtest/runDailyUniverseBacktest.ts \
  ./src/backtest/data/SBER_D.json:SBER \
  ./src/backtest/data/GAZP_D.json:GAZP \
  ./src/backtest/data/LKOH_D.json:LKOH \
  --balance=50000 \
  --risk=0.01 \
  --stopAtr=2.5 \
  --trailAtr=2.0
`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (!args.length) {
    printUsage();
    process.exit(1);
  }

  const pairArgs = args.filter(a => !a.startsWith('--'));
  if (pairArgs.length < 2) {
    console.error('Нужно минимум 2 инструмента в формате path:symbol');
    process.exit(1);
  }

  const startingBalance = parseNumberArg(args, 'balance', 50000);
  const commissionRate = parseNumberArg(args, 'commission', 0.0005);
  const warmupCandles = parseNumberArg(args, 'warmup', 30);
  const riskPerTrade = parseNumberArg(args, 'risk', 0.01);
  const stopAtrMult = parseNumberArg(args, 'stopAtr', 2.5);
  const trailingAtrMult = parseNumberArg(args, 'trailAtr', 2.0);
  const minAtrPct = parseNumberArg(args, 'minAtrPct', 0.008);
  const maxAtrPct = parseNumberArg(args, 'maxAtrPct', 0.12);
  const maxBreakoutDistancePct = parseNumberArg(args, 'maxBreakoutDistancePct', 0.04);
  const allowLongs = parseBoolArg(args, 'allowLongs', true);
  const allowShorts = parseBoolArg(args, 'allowShorts', true);

  const candlesBySymbol: Record<string, Candle[]> = {};
  const loadedInfo: Array<{
    symbol: string;
    path: string;
    count: number;
    from: number;
    to: number;
  }> = [];

  for (const pairArg of pairArgs) {
    const sep = pairArg.lastIndexOf(':');
    if (sep <= 0) {
      console.error(`Неверный аргумент "${pairArg}". Нужен формат path:symbol`);
      process.exit(1);
    }

    const filePath = pairArg.slice(0, sep);
    const symbol = pairArg.slice(sep + 1).trim().toUpperCase();
    const absolutePath = path.resolve(process.cwd(), filePath);

    if (!fs.existsSync(absolutePath)) {
      console.error(`Файл не найден: ${absolutePath}`);
      process.exit(1);
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
    } catch (e) {
      console.error(`Не удалось распарсить JSON: ${absolutePath}`, e);
      process.exit(1);
    }

    let candles: Candle[];
    try {
      candles = normalizeCandles(rawJson);
    } catch (e) {
      console.error(`Ошибка структуры свечей: ${absolutePath}`, e);
      process.exit(1);
      return;
    }

    candlesBySymbol[symbol] = candles;
    loadedInfo.push({
      symbol,
      path: absolutePath,
      count: candles.length,
      from: candles[0]?.time ?? 0,
      to: candles[candles.length - 1]?.time ?? 0
    });
  }

  const estimated = estimateBacktestTime(Math.min(...loadedInfo.map(x => x.count)));

  console.log('\n========== ПАРАМЕТРЫ DAILY UNIVERSE ЗАПУСКА ==========');
  console.log(`Инструментов: ${loadedInfo.length}`);
  console.log(`Universe: ${loadedInfo.map(x => x.symbol).join(', ')}`);
  for (const info of loadedInfo) {
    console.log(
      `${info.symbol}: ${info.count} свечей | ${formatDate(info.from)} -> ${formatDate(info.to)}`
    );
  }
  console.log(`Стартовый баланс: ${startingBalance}`);
  console.log(`Комиссия: ${commissionRate}`);
  console.log(`Warmup: ${warmupCandles}`);
  console.log(`Risk per trade: ${riskPerTrade * 100}%`);
  console.log(`Stop ATR: ${stopAtrMult}`);
  console.log(`Trail ATR: ${trailingAtrMult}`);
  console.log(`Min ATR %: ${minAtrPct}`);
  console.log(`Max ATR %: ${maxAtrPct}`);
  console.log(`Max breakout distance %: ${maxBreakoutDistancePct}`);
  console.log(`Longs: ${allowLongs ? 'ON' : 'OFF'}`);
  console.log(`Shorts: ${allowShorts ? 'ON' : 'OFF'}`);
  console.log(
    `Оценка времени: ~ ${formatDuration(estimated.minSec)} - ${formatDuration(
      estimated.maxSec
    )}`
  );
  console.log(`Лог прогресса: каждые ${DEFAULT_PROGRESS_LOG_EVERY} баров`);

  const startedAt = Date.now();

  const result = runDailyUniverseBacktest(candlesBySymbol, {
    startingBalance,
    commissionRate,
    warmupCandles,
    progressLogEvery: DEFAULT_PROGRESS_LOG_EVERY,
    onePositionAtTime: true,
    minSignalAtrPct: minAtrPct,
    riskPerTrade,
    stopAtrMult,
    trailingAtrMult,
    smaPeriod: 20,
    atrPeriod: 14,
    minAtrPct,
    maxAtrPct,
    maxBreakoutDistancePct,
    allowLongs,
    allowShorts
  });

  console.log('\n========== ВРЕМЯ ВЫПОЛНЕНИЯ ==========');
  console.log(
    `Фактическое время: ${formatDuration((Date.now() - startedAt) / 1000)}`
  );

  printSummary(result);
  printSelectionStats(result);
  printTrades(result, 20);
}

main();
