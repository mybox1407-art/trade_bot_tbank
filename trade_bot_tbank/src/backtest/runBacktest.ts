import fs from 'node:fs';
import path from 'node:path';
import { runStrategyBacktest } from './strategyBacktest';

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const DEFAULT_COOLDOWN_CANDLES = 12;
const PROGRESS_LOG_EVERY = 5000;

const ANSI = {
  reset: '\u001b[0m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
  bold: '\u001b[1m'
};

function isTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

function color(text: string, code: keyof typeof ANSI): string {
  if (!isTty()) return text;
  return `${ANSI[code]}${text}${ANSI.reset}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'неизвестно';
  if (seconds < 60) return `${Math.round(seconds)} сек`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} мин ${secs} сек`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours} ч ${mins} мин`;
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function readCandlesFromJson(filePath: string): Candle[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error('Файл должен содержать массив свечей');
  }
  return data.map((c: any) => ({
    time: Number(c.time),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume ?? 0)
  }));
}

function printSummary(result: any): void {
  const s = result.summary;
  const h = result.htfStats;
  const r = result.regimeStats;

  const winRatePct = round((s.winRate ?? 0) * 100, 2);
  const returnPct = round((s.returnPct ?? 0) * 100, 2);
  const maxDdPct = round((s.maxDrawdownPct ?? 0) * 100, 2);

  console.log('\n' + color('========== SUMMARY ==========', 'bold'));
  console.log(`Symbol:              ${result.symbol}`);
  console.log(`Trades:              ${s.tradesCount}`);
  console.log(`Win rate:            ${winRatePct}%`);
  console.log(`Profit factor:       ${Number.isFinite(s.profitFactor) ? round(s.profitFactor, 4) : 'Infinity'}`);
  console.log(`Net profit:          ${round(s.netProfit, 2)}`);
  console.log(`Return:              ${returnPct}%`);
  console.log(`Max DD:              ${round(s.maxDrawdownAbs, 2)} (${maxDdPct}%)`);
  console.log(`Avg win / loss:      ${round(s.avgWin, 2)} / ${round(s.avgLoss, 2)}`);
  console.log(`Gross profit / loss: ${round(s.grossProfit, 2)} / ${round(s.grossLoss, 2)}`);
  console.log(`Start / end balance: ${round(s.startBalance, 2)} / ${round(s.endBalance, 2)}`);

  console.log('\n' + color('========== HTF ==========', 'bold'));
  console.log(`Passes:              ${h.passes ?? 0}`);
  console.log(`Rejects:             ${h.rejects ?? 0}`);
  console.log(`Warmup rejects:      ${h.warmupRejects ?? 0}`);

  console.log('\n' + color('========== REGIME ==========', 'bold'));
  console.log(`Total bars:          ${r.totalBars ?? 0}`);
  for (const [regime, bucket] of Object.entries(r.barsByRegime ?? {}) as Array<[string, { bars: number; pct: number }]>) {
    console.log(`${regime}: ${bucket.bars} bars (${round((bucket.pct ?? 0) * 100, 2)}%)`);
  }

  console.log('\n' + color('Close reasons:', 'bold'));
  for (const [reason, count] of Object.entries(r.closeReasonsAll ?? {})) {
    console.log(`${reason}: ${count}`);
  }
}

function printTrades(result: any): void {
  console.log('\n' + color('========== TRADES ==========', 'bold'));
  if (!result.trades?.length) {
    console.log('No trades');
    return;
  }

  for (const t of result.trades) {
    const pnl = round(t.netPnl, 2);
    const coloredPnl =
      pnl > 0 ? color(String(pnl), 'green') : pnl < 0 ? color(String(pnl), 'red') : color(String(pnl), 'yellow');
    const reasonColor =
      t.closeReason === 'take_profit_2' || t.closeReason === 'take_profit_1'
        ? 'green'
        : t.closeReason === 'stop_loss'
          ? 'red'
          : 'yellow';

    console.log(
      [
        `[${new Date(t.openedAt).toISOString()} -> ${new Date(t.closedAt).toISOString()}]`,
        t.side.toUpperCase(),
        `entry=${round(t.entryPrice, 4)}`,
        `exit=${round(t.exitPrice, 4)}`,
        `qty=${round(t.quantity, 4)}`,
        `bars=${t.barsHeld}`,
        `reason=${color(t.closeReason, reasonColor as any)}`,
        `pnl=${coloredPnl}`,
        `comm=${round(t.totalCommission, 2)}`
      ].join(' | ')
    );
  }
}

function parseArg(args: string[], idx: number, fallback: string): string {
  return args[idx] ?? fallback;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log(
      'Usage: tsx src/backtest/runBacktest.ts <candles.json> <SYMBOL> [cooldownCandles] [runnerTrailR] [htfFilter 0|1] [htfMinAdx1h] [timeStopBars] [earlyAbortBars] [earlyAbortMinR] [maxTradesPerDay] [sideFilter both|long|short]'
    );
    process.exit(1);
  }

  const filePath = args[0];
  const symbol = args[1];
  const cooldownCandles = Number.parseInt(parseArg(args, 2, String(DEFAULT_COOLDOWN_CANDLES)), 10);
  const runnerTrailR = Number.parseFloat(parseArg(args, 3, '0'));
  const htfFilter = parseArg(args, 4, '0') === '1';
  const htfMinAdx1h = Number.parseFloat(parseArg(args, 5, '18'));
  const timeStopBars = Number.parseInt(parseArg(args, 6, '64'), 10);
  const earlyAbortBars = Number.parseInt(parseArg(args, 7, '16'), 10);
  const earlyAbortMinR = Number.parseFloat(parseArg(args, 8, '0.35'));
  const maxTradesPerDay = Number.parseInt(parseArg(args, 9, '0'), 10);
  const sideFilter = parseArg(args, 10, 'both') as 'both' | 'long' | 'short';

  const candles = readCandlesFromJson(path.resolve(filePath));

  console.log(color('========== PARAMETERS ==========', 'bold'));
  console.log(`File:                ${filePath}`);
  console.log(`Symbol:              ${symbol}`);
  console.log(`Cooldown candles:    ${cooldownCandles}`);
  console.log(`Runner trail R:      ${runnerTrailR}`);
  console.log(`HTF filter:          ${htfFilter ? 'on' : 'off'}`);
  console.log(`HTF min ADX 1h:      ${htfMinAdx1h}`);
  console.log(`Time stop bars:      ${timeStopBars}`);
  console.log(`Early abort bars:    ${earlyAbortBars}`);
  console.log(`Early abort min R:   ${earlyAbortMinR}`);
  console.log(`Max trades per day:  ${maxTradesPerDay}`);
  console.log(`Side filter:         ${sideFilter}`);
  console.log(`Candles loaded:      ${candles.length}`);

  const startedAt = Date.now();

  const result = runStrategyBacktest(symbol, candles, {
    cooldownCandles,
    runnerTrailR,
    htfFilter,
    htfMinAdx1h,
    timeStopBars,
    earlyAbortBars,
    earlyAbortMinR,
    maxTradesPerDay,
    sideFilter,
    progressLogEvery: PROGRESS_LOG_EVERY
  });

  const totalElapsedSec = (Date.now() - startedAt) / 1000;

  console.log('\n' + color('========== EXECUTION TIME ==========', 'bold'));
  console.log(`Actual time:         ${formatDuration(totalElapsedSec)}`);

  printSummary(result);
  printTrades(result);
}

main().catch(err => {
  console.error(color(`Error: ${err?.message ?? err}`, 'red'));
  process.exit(1);
});
