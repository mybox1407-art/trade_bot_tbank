import fs from 'node:fs';
import path from 'node:path';
import { Candle } from '../services/dailyBreakoutStrategy';
import { runDailyUniverseBacktest } from './dailyUniverseBacktest';

type SideMode = 'long-only' | 'short-only' | 'long+short';

interface MatrixRow {
  mode: SideMode;
  minAtrPct: number;
  trades: number;
  winRatePct: number;
  profitFactor: number;
  sharpe: number;
  returnPct: number;
  maxDrawdownPct: number;
  netProfit: number;
  endBalance: number;
  picked: string;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
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

function parseNumberArg(args: string[], name: string, fallback: number): number {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  if (!arg) return fallback;

  const n = Number(arg.split('=')[1]);
  if (!Number.isFinite(n)) return fallback;
  return n;
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

function loadCandlesFromArgs(args: string[]): Record<string, Candle[]> {
  const pairArgs = args.filter(a => !a.startsWith('--'));
  if (pairArgs.length < 2) {
    throw new Error('Нужно минимум 2 инструмента в формате path:symbol');
  }

  const candlesBySymbol: Record<string, Candle[]> = {};

  for (const pairArg of pairArgs) {
    const sep = pairArg.lastIndexOf(':');
    if (sep <= 0) {
      throw new Error(`Неверный аргумент "${pairArg}". Нужен формат path:symbol`);
    }

    const filePath = pairArg.slice(0, sep);
    const symbol = pairArg.slice(sep + 1).trim().toUpperCase();
    const absolutePath = path.resolve(process.cwd(), filePath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Файл не найден: ${absolutePath}`);
    }

    const rawJson = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
    candlesBySymbol[symbol] = normalizeCandles(rawJson);
  }

  return candlesBySymbol;
}

function modeToFlags(mode: SideMode): { allowLongs: boolean; allowShorts: boolean } {
  if (mode === 'long-only') return { allowLongs: true, allowShorts: false };
  if (mode === 'short-only') return { allowLongs: false, allowShorts: true };
  return { allowLongs: true, allowShorts: true };
}

function pickedToString(pickedBySymbol: Record<string, number>): string {
  const entries = Object.entries(pickedBySymbol) as Array<[string, number]>;
  if (!entries.length) return '—';
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([symbol, count]) => `${symbol}=${count}`)
    .join(', ');
}

function printDatasetInfo(candlesBySymbol: Record<string, Candle[]>): void {
  const symbols = Object.keys(candlesBySymbol).sort();
  console.log('\n========== DATASET ==========');
  console.log(`Universe: ${symbols.join(', ')}`);

  for (const symbol of symbols) {
    const candles = candlesBySymbol[symbol];
    const first = candles[0];
    const last = candles[candles.length - 1];
    console.log(
      `${symbol}: ${candles.length} свечей | ${formatDate(first.time)} -> ${formatDate(last.time)}`
    );
  }
}

function printResults(rows: MatrixRow[]): void {
  console.log('\n========== MATRIX RESULTS ==========');

  const header = [
    'Mode'.padEnd(12),
    'minAtr'.padEnd(8),
    'Trades'.padEnd(8),
    'WinRate'.padEnd(10),
    'PF'.padEnd(8),
    'Sharpe'.padEnd(9),
    'Ret%'.padEnd(9),
    'DD%'.padEnd(8),
    'Net'.padEnd(12),
    'EndBal'.padEnd(12)
  ].join(' | ');

  console.log(header);
  console.log('-'.repeat(header.length));

  for (const row of rows) {
    console.log(
      [
        row.mode.padEnd(12),
        formatNumber(row.minAtrPct, 3).padEnd(8),
        String(row.trades).padEnd(8),
        (formatNumber(row.winRatePct, 2) + '%').padEnd(10),
        formatNumber(row.profitFactor, 3).padEnd(8),
        formatNumber(row.sharpe, 3).padEnd(9),
        (formatNumber(row.returnPct, 2) + '%').padEnd(9),
        (formatNumber(row.maxDrawdownPct, 2) + '%').padEnd(8),
        formatNumber(row.netProfit, 2).padEnd(12),
        formatNumber(row.endBalance, 2).padEnd(12)
      ].join(' | ')
    );
  }

  console.log('\n========== PICKED BY SYMBOL ==========');
  for (const row of rows) {
    console.log(
      `${row.mode} | minAtr=${formatNumber(row.minAtrPct, 3)} | ${row.picked}`
    );
  }
}

function main(): void {
  const args = process.argv.slice(2);

  if (!args.length) {
    console.log(`
Использование:
npx tsx src/backtest/runDailyMatrix.ts <json1:symbol1> <json2:symbol2> ... [опции]

Пример:
npx tsx src/backtest/runDailyMatrix.ts \
  ./src/backtest/data/SBER_15m.json:SBER \
  ./src/backtest/data/GAZP_15m.json:GAZP \
  ./src/backtest/data/LKOH_15m.json:LKOH \
  ./src/backtest/data/ROSN_15m.json:ROSN \
  --balance=50000 \
  --risk=0.01 \
  --stopAtr=2.5 \
  --trailAtr=2.0 \
  --maxAtrPct=0.12 \
  --warmup=30
`);
    process.exit(1);
  }

  const candlesBySymbol = loadCandlesFromArgs(args);

  const startingBalance = parseNumberArg(args, 'balance', 50000);
  const commissionRate = parseNumberArg(args, 'commission', 0.0005);
  const warmupCandles = parseNumberArg(args, 'warmup', 30);
  const riskPerTrade = parseNumberArg(args, 'risk', 0.01);
  const stopAtrMult = parseNumberArg(args, 'stopAtr', 2.5);
  const trailingAtrMult = parseNumberArg(args, 'trailAtr', 2.0);
  const maxAtrPct = parseNumberArg(args, 'maxAtrPct', 0.12);
  const maxBreakoutDistancePct = parseNumberArg(args, 'maxBreakoutDistancePct', 0.04);

  const atrGrid = [0.005, 0.006, 0.008];
  const modes: SideMode[] = ['long-only', 'short-only', 'long+short'];

  printDatasetInfo(candlesBySymbol);

  console.log('\n========== RUN MATRIX ==========');
  console.log(`Start balance: ${startingBalance}`);
  console.log(`Commission: ${commissionRate}`);
  console.log(`Risk per trade: ${riskPerTrade}`);
  console.log(`Stop ATR: ${stopAtrMult}`);
  console.log(`Trail ATR: ${trailingAtrMult}`);
  console.log(`Max ATR %: ${maxAtrPct}`);
  console.log(`Max breakout distance %: ${maxBreakoutDistancePct}`);
  console.log(`Warmup: ${warmupCandles}`);
  console.log(`Grid: minAtrPct = ${atrGrid.join(', ')}`);
  console.log(`Modes: ${modes.join(', ')}`);

  const rows: MatrixRow[] = [];

  for (const mode of modes) {
    for (const minAtrPct of atrGrid) {
      const flags = modeToFlags(mode);

      console.log(
        `\n[RUN] mode=${mode} | minAtrPct=${formatNumber(minAtrPct, 3)}`
      );

      const result = runDailyUniverseBacktest(candlesBySymbol, {
        startingBalance,
        commissionRate,
        warmupCandles,
        progressLogEvery: 0,
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
        allowLongs: flags.allowLongs,
        allowShorts: flags.allowShorts
      });

      rows.push({
        mode,
        minAtrPct,
        trades: result.summary.tradesCount,
        winRatePct: result.summary.winRate * 100,
        profitFactor: result.summary.profitFactor,
        sharpe: result.summary.sharpe,
        returnPct: result.summary.returnPct * 100,
        maxDrawdownPct: result.summary.maxDrawdownPct * 100,
        netProfit: result.summary.netProfit,
        endBalance: result.summary.endBalance,
        picked: pickedToString(result.selectionStats.pickedBySymbol)
      });
    }
  }

  rows.sort((a, b) => {
    if (b.returnPct !== a.returnPct) return b.returnPct - a.returnPct;
    if (b.profitFactor !== a.profitFactor) return b.profitFactor - a.profitFactor;
    return b.sharpe - a.sharpe;
  });

  printResults(rows);
}

main();
