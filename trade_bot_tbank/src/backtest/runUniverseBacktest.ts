import fs from 'node:fs';
import path from 'node:path';
import { Candle, MAX_RISK_PER_TRADE, STARTING_BALANCE } from '../services/strategy';
import { runUniverseBacktest } from './universeBacktest';

const DEFAULT_COOLDOWN_CANDLES = 12;
const DEFAULT_WARMUP = 250;
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

function parseMinScore(value: string | undefined): number {
  if (value == null || value === '') return 4.0;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    console.warn(`Некорректный minScore="${value}", default 4.0`);
    return 4.0;
  }
  return n;
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
  if (candlesCount <= 5000) return { minSec: 5, maxSec: 20 };
  if (candlesCount <= 15000) return { minSec: 15, maxSec: 60 };
  if (candlesCount <= 30000) return { minSec: 30, maxSec: 120 };
  if (candlesCount <= 60000) return { minSec: 60, maxSec: 300 };
  return { minSec: 180, maxSec: 600 };
}

function printSummary(result: ReturnType<typeof runUniverseBacktest>): void {
  const s = result.summary;
  const netColor = s.netProfit > 0 ? 'green' : s.netProfit < 0 ? 'red' : 'yellow';
  const retColor = s.returnPct > 0 ? 'green' : s.returnPct < 0 ? 'red' : 'yellow';
  const pfColor =
    s.profitFactor >= 1.2 ? 'green' : s.profitFactor >= 1 ? 'yellow' : 'red';

  console.log('\n========== ИТОГИ UNIVERSE БЭКТЕСТА ==========');
  console.log(`Universe: ${s.universe.join(', ')}`);
  console.log(`Сделок (групп): ${s.tradesCount}`);
  console.log(`Побед: ${colorize(String(s.wins), 'green')}`);
  console.log(`Поражений: ${colorize(String(s.losses), 'red')}`);
  console.log(`Win rate: ${formatNumber(s.winRate * 100, 2)}%`);
  console.log(
    `Gross profit: ${colorize(formatNumber(s.grossProfit, 2), 'green')}`
  );
  console.log(`Gross loss: ${colorize(formatNumber(s.grossLoss, 2), 'red')}`);
  console.log(
    `Net profit: ${colorize(formatNumber(s.netProfit, 2), netColor)}`
  );
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
  console.log(
    `Доходность: ${colorize(formatNumber(s.returnPct * 100, 2) + '%', retColor)}`
  );
  console.log(`Средняя месячная доходность: ${formatNumber(s.avgMonthlyReturnPct * 100, 2)}%`);
  console.log(`Месяцев в тесте: ${s.monthsCount}`);
  console.log(`Макс. просадка: ${formatNumber(s.maxDrawdownAbs, 2)}`);
  console.log(`Макс. просадка %: ${formatNumber(s.maxDrawdownPct * 100, 2)}%`);
}

function printSelectionStats(result: ReturnType<typeof runUniverseBacktest>): void {
  const st = result.selectionStats;
  console.log('\n========== SELECTION STATS ==========');
  console.log(`Decision bars: ${st.totalDecisionBars}`);
  console.log(`No-signal bars: ${st.noSignalBars}`);
  console.log(`Picked by side: ${Object.entries(st.pickedBySide).map(([k, v]) => `${k}=${v}`).join(' | ') || '—'}`);
  console.log(`Picked by symbol: ${Object.entries(st.pickedBySymbol).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' | ') || '—'}`);
}

function printRegimeStats(result: ReturnType<typeof runUniverseBacktest>): void {
  const rs = result.regimeStats;
  console.log('\n========== REGIME STATS ==========');
  if (!rs || rs.totalBars === 0) {
    console.log('Нет данных по режимам.');
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

  console.log(`Баров решений: ${rs.totalBars}`);
  const barParts: string[] = [];
  const seen = new Set([
    ...order,
    ...Object.keys(rs.barsByRegime),
    ...Object.keys(rs.tradesByRegime)
  ]);
  for (const reg of [...order, ...[...seen].filter(r => !order.includes(r))]) {
    const b = rs.barsByRegime[reg];
    if (!b && !rs.tradesByRegime[reg]) continue;
    const pct = b ? (b.pct * 100).toFixed(1) : '0.0';
    const bars = b ? b.bars : 0;
    barParts.push(`${reg} ${pct}% (${bars})`);
  }
  console.log(`Bars: ${barParts.join(' | ')}`);

  console.log('\nTrades by regime:');
  const tradeRegs = [
    ...order.filter(r => rs.tradesByRegime[r]),
    ...Object.keys(rs.tradesByRegime).filter(r => !order.includes(r))
  ];
  if (!tradeRegs.length) {
    console.log('  (сделок нет)');
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
      `  ${reg}: n=${t.trades} WR=${wr}% PF=${pf} net=${t.netProfit.toFixed(2)} avgBars=${t.avgBarsHeld} | ${reasons || '—'}`
    );
  }

  const allReasons = Object.entries(rs.closeReasonsAll)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' | ');
  console.log(`\nClose reasons: ${allReasons || '—'}`);
}

function printTrades(
  result: ReturnType<typeof runUniverseBacktest>,
  limit = 20
): void {
  const all = result.trades;
  const trades = limit > 0 ? all.slice(-limit) : all;

  console.log(`\n========== ПОСЛЕДНИЕ ${trades.length} НОГ ==========`);

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
npx tsx src/backtest/runUniverseBacktest.ts <json1:symbol1> <json2:symbol2> ... [--cooldown=12] [--minScore=4]

Примеры:
npx tsx src/backtest/runUniverseBacktest.ts ./src/backtest/data/SBER_15m.json:SBER ./src/backtest/data/NVTK_15m.json:NVTK
npx tsx src/backtest/runUniverseBacktest.ts ./src/backtest/data/SBER_15m.json:SBER ./src/backtest/data/GAZP_15m.json:GAZP ./src/backtest/data/MTSS_15m.json:MTSS --cooldown=12 --minScore=4.2
`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (!args.length) {
    printUsage();
    process.exit(1);
  }

  const pairArgs = args.filter(a => !a.startsWith('--'));
  const cooldownArg = args.find(a => a.startsWith('--cooldown='));
  const minScoreArg = args.find(a => a.startsWith('--minScore='));

  if (pairArgs.length < 2) {
    console.error('Нужно минимум 2 инструмента в формате path:symbol');
    process.exit(1);
  }

  const cooldownCandles = parseCooldownCandles(cooldownArg?.split('=')[1]);
  const minScore = parseMinScore(minScoreArg?.split('=')[1]);

  const candlesBySymbol: Record<string, Candle[]> = {};
  const loadedInfo: Array<{ symbol: string; path: string; count: number; from: number; to: number }> = [];

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

  const estimated = estimateBacktestTime(
    Math.min(...loadedInfo.map(x => x.count))
  );

  console.log('\n========== ПАРАМЕТРЫ UNIVERSE ЗАПУСКА ==========');
  console.log(`Инструментов: ${loadedInfo.length}`);
  console.log(`Universe: ${loadedInfo.map(x => x.symbol).join(', ')}`);
  for (const info of loadedInfo) {
    console.log(
      `${info.symbol}: ${info.count} свечей | ${formatDate(info.from)} -> ${formatDate(info.to)}`
    );
  }
  console.log(`Cooldown после сделки: ${cooldownCandles} свеч. (после любой)`);
  console.log(`Min score: ${minScore}`);
  console.log(`Warmup: ${DEFAULT_WARMUP} бар`);
  console.log(`Риск на сделку: ${MAX_RISK_PER_TRADE * 100}%`);
  console.log(`Модель выхода: TP1 40%@1.5R → lock 0R → TP2@2.2R | abort 16b/0.35R | TS 64`);
  console.log(
    `Оценка времени: ~ ${formatDuration(estimated.minSec)} - ${formatDuration(
      estimated.maxSec
    )}`
  );
  console.log(`Лог прогресса: каждые ${PROGRESS_LOG_EVERY} баров`);

  const startedAt = Date.now();

  const result = runUniverseBacktest(candlesBySymbol, {
    startingBalance: STARTING_BALANCE,
    commissionRate: 0.0005,
    warmupCandles: DEFAULT_WARMUP,
    cooldownCandles,
    progressLogEvery: PROGRESS_LOG_EVERY,
    timeStopBars: 64,
    earlyAbortBars: 16,
    earlyAbortMinR: 0.35,
    runnerTrailR: 0,
    minScore,
    onePositionAtTime: true
  });

  console.log('\n========== ВРЕМЯ ВЫПОЛНЕНИЯ ==========');
  console.log(
    `Фактическое время: ${formatDuration((Date.now() - startedAt) / 1000)}`
  );

  printSummary(result);
  printSelectionStats(result);
  printRegimeStats(result);
  printTrades(result, 20);
}

main();
