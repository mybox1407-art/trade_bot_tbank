import * as fs from 'fs';
import * as path from 'path';
import { Candle, DEFAULT_SCALP_PARAMS } from '../services/momentumScalpStrategy';
import {
  runMomentumScalpBacktest,
  ScalpBacktestResult,
  ScalpTrade
} from './momentumScalpBacktest';

function loadCandles(filePath: string): Candle[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);

  if (Array.isArray(data)) {
    return data as Candle[];
  }

  if (data.candles && Array.isArray(data.candles)) {
    return data.candles as Candle[];
  }

  if (data.data && Array.isArray(data.data)) {
    return data.data as Candle[];
  }

  throw new Error('Unknown candle format');
}

function formatCurrency(n: number): string {
  return n.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatPctFromFraction(n: number): string {
  return (n * 100).toFixed(2) + '%';
}

function formatSigned(n: number): string {
  return `${n >= 0 ? '+' : ''}${formatCurrency(n)}`;
}

function printSummary(result: ScalpBacktestResult) {
  const startingBalance = result.equity[0] ?? 0;
  const ddPct = startingBalance > 0
    ? (result.maxDrawdown / startingBalance) * 100
    : 0;

  console.log('\n=== MOMENTUM SCALP BACKTEST RESULT ===');
  console.log(`Starting Balance: ${formatCurrency(startingBalance)} ₽`);
  console.log(`Final Balance:    ${formatCurrency(result.finalBalance)} ₽`);
  console.log(
    `Total Return:     ${formatSigned(result.finalBalance - startingBalance)} ₽ (${result.totalReturn.toFixed(2)}%)`
  );
  console.log(`Total Trades:     ${result.totalTrades}`);
  console.log(`Win Rate:         ${formatPctFromFraction(result.winRate)}`);
  console.log(`Profit Factor:    ${Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : 'Infinity'}`);
  console.log(`Max Drawdown:     ${formatCurrency(result.maxDrawdown)} ₽ (${ddPct.toFixed(2)}%)`);
  console.log(`Avg Trade:        ${formatSigned(result.avgTrade)} ₽`);
  console.log(`Avg Bars Held:    ${result.avgBars.toFixed(1)}`);
  console.log(`Gross Profit:     ${formatCurrency(result.grossProfit)} ₽`);
  console.log(`Gross Loss:       ${formatCurrency(result.grossLoss)} ₽`);
  console.log(`Commission Total: ${formatCurrency(result.commissionTotal)} ₽`);
}

function printTrades(result: ScalpBacktestResult) {
  if (result.trades.length === 0) {
    return;
  }

  console.log('\n=== TRADES ===');
  console.log(
    '# | Signal Time | Entry Time | Side | Entry | Exit | Size | GrossPnL | Commission | NetPnL | PnL% | Bars | Reason'
  );

  result.trades.forEach((t: ScalpTrade, i: number) => {
    const signalTime = new Date(t.signalTime).toISOString();
    const entryTime = new Date(t.entryTime).toISOString();

    console.log(
      [
        i + 1,
        signalTime,
        entryTime,
        t.side.toUpperCase(),
        t.entryPrice.toFixed(2),
        t.exitPrice.toFixed(2),
        t.size.toFixed(4),
        formatSigned(t.grossPnl),
        formatCurrency(t.commission),
        formatSigned(t.netPnl),
        `${t.pnlPct.toFixed(3)}%`,
        t.barsHeld,
        t.exitReason
      ].join(' | ')
    );
  });
}

function printExitDistribution(result: ScalpBacktestResult) {
  const counts: Record<string, number> = {};

  result.trades.forEach((t: ScalpTrade) => {
    counts[t.exitReason] = (counts[t.exitReason] || 0) + 1;
  });

  const rows = Object.entries(counts)
    .map(([reason, count]: [string, number]) => ({ reason, count }))
    .sort((a: { reason: string; count: number }, b: { reason: string; count: number }) => b.count - a.count);

  if (rows.length > 0) {
    console.log('\n=== EXIT REASONS ===');
    console.table(rows);
  }
}

function printTradeStats(result: ScalpBacktestResult) {
  if (result.trades.length === 0) {
    return;
  }

  const positiveNet = result.trades.filter((t: ScalpTrade) => t.netPnl > 0).length;
  const negativeNet = result.trades.filter((t: ScalpTrade) => t.netPnl < 0).length;
  const positiveGross = result.trades.filter((t: ScalpTrade) => t.grossPnl > 0).length;
  const negativeTakeProfits = result.trades.filter(
    (t: ScalpTrade) => t.exitReason === 'take_profit' && t.netPnl < 0
  ).length;

  console.log('\n=== TRADE STATS ===');
  console.log(`Positive net trades: ${positiveNet}`);
  console.log(`Negative net trades: ${negativeNet}`);
  console.log(`Positive gross trades: ${positiveGross}`);
  console.log(`Negative take_profit trades after costs: ${negativeTakeProfits}`);
}

function main() {
  const args = process.argv.slice(2);
  const filePath = args[0] || path.join(__dirname, 'data', 'SBER_1m.json');
  const ticker = args[1] || 'SBER';

  console.log(`Loading 1m candles for ${ticker} from ${filePath}...`);
  const candles = loadCandles(filePath);
  console.log(`Loaded ${candles.length} candles`);

  const params = { ...DEFAULT_SCALP_PARAMS };

  const startTime = Date.now();
  const result = runMomentumScalpBacktest(candles, params);
  const elapsed = Date.now() - startTime;

  printSummary(result);
  printTradeStats(result);
  printTrades(result);
  printExitDistribution(result);

  console.log(`\nBacktest completed in ${elapsed}ms`);
}

main();
