import fs from 'fs';
import path from 'path';
import { runBacktest } from './strategyBacktest';
import { Candle, HtfFilterOptions, STARTING_BALANCE } from '../services/strategy';

type RawCandle = {
  time?: number;
  timestamp?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function loadCandles(filePath: string): Candle[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as RawCandle[];
  return data
    .map(c => ({
      time: c.time ?? c.timestamp ?? 0,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume
    }))
    .filter(c => c.time > 0)
    .sort((a, b) => a.time - b.time);
}

function fmt(n: number) {
  return Number.isFinite(n) ? n.toFixed(2) : 'n/a';
}

function main() {
  const [, , filePathArg, symbolArg] = process.argv;
  if (!filePathArg) {
    console.error('Usage: npx ts-node src/backtest/runBacktest.ts <file.json> [SYMBOL]');
    process.exit(1);
  }

  const filePath = path.resolve(filePathArg);
  const symbol = symbolArg ?? path.basename(filePath, path.extname(filePath));
  const candles = loadCandles(filePath);

  const htfEnabled = false;
  const htf: HtfFilterOptions = {
    enabled: htfEnabled,
    minAdx1h: 18
  };

  const start = Date.now();
  const result = runBacktest(candles, symbol, {
    cooldownCandles: 12,
    runnerTrailR: 0,
    htfFilter: htf,
    timeStopBars: 64,
    earlyAbortBars: 16,
    earlyAbortMinR: 0.35,
    maxTradesPerDay: 0
  });
  const end = Date.now();

  const trades = result.trades;
  const tp1 = trades.filter(t => t.reason === 'take_profit_1').length;
  const tp2 = trades.filter(t => t.reason === 'take_profit_2').length;
  const sl = trades.filter(t => t.reason === 'stop_loss').length;
  const be = trades.filter(t => t.reason === 'breakeven').length;
  const fc = trades.filter(t => t.reason === 'forced_close').length;
  const ea = trades.filter(t => t.reason === 'early_abort').length;
  const ts = trades.filter(t => t.reason === 'time_stop').length;

  console.log('========== PARAMETERS ==========' );
  console.log(`File:                ${path.relative(process.cwd(), filePath)}`);
  console.log(`Symbol:              ${symbol}`);
  console.log(`Cooldown candles:    12`);
  console.log(`Runner trail R:      0`);
  console.log(`HTF filter:          ${htfEnabled ? 'on' : 'off'}`);
  console.log(`HTF min ADX 1h:      18`);
  console.log(`Time stop bars:      64`);
  console.log(`Early abort bars:    16`);
  console.log(`Early abort min R:   0.35`);
  console.log(`Max trades per day:  0`);
  console.log(`Candles loaded:      ${candles.length}`);
  console.log('');
  console.log('========== EXECUTION TIME ==========' );
  console.log(`Actual time:         ${Math.max(1, Math.round((end - start) / 1000))} сек`);
  console.log('');
  console.log('========== SUMMARY ==========' );
  console.log(`Symbol:              ${symbol}`);
  console.log(`Trades:              ${trades.length}`);
  console.log(`Win rate:            ${fmt(result.winRate * 100)}%`);
  console.log(`Profit factor:       ${fmt(result.profitFactor)}`);
  console.log(`Net profit:          ${fmt(result.netProfit)}`);
  console.log(`Return:              ${fmt(result.returnPct * 100)}%`);
  console.log(`Max DD:              ${fmt(result.maxDrawdown)} (${fmt((result.maxDrawdown / STARTING_BALANCE) * 100)}%)`);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  console.log(`Avg win / loss:      ${fmt(avgWin)} / ${fmt(avgLoss)}`);
  console.log(`Gross profit / loss: ${fmt(result.grossProfit)} / ${fmt(result.grossLoss)}`);
  console.log(`Start / end balance: ${fmt(result.startBalance)} / ${fmt(result.endBalance)}`);
  console.log('');
  console.log('========== HTF ==========' );
  console.log(`Passes:              0`);
  console.log(`Rejects:             0`);
  console.log(`Warmup rejects:      0`);
  console.log('');
  console.log('========== REGIME ==========' );
  const regimeBars = candles.length > 0 ? candles.length - 250 : 0;
  console.log(`Total bars:          ${regimeBars > 0 ? regimeBars : candles.length}`);
  console.log(`range: ${regimeBars > 0 ? regimeBars : candles.length} bars (100%)`);
  console.log('');
  console.log('Close reasons:');
  console.log(`take_profit_1: ${tp1}`);
  console.log(`take_profit_2: ${tp2}`);
  console.log(`stop_loss: ${sl}`);
  console.log(`breakeven: ${be}`);
  console.log(`early_abort: ${ea}`);
  console.log(`time_stop: ${ts}`);
  console.log(`forced_close: ${fc}`);
  console.log('');
  console.log('========== TRADES ==========' );
  for (const t of trades) {
    console.log(`[${new Date(t.openedAt).toISOString()} -> ${new Date(t.closedAt).toISOString()}] | ${t.side.toUpperCase()} | entry=${t.entry} | exit=${t.exit} | qty=${t.qty} | bars=${t.bars} | reason=${t.reason} | pnl=${t.pnl} | comm=${t.comm}`);
  }
}

main();
