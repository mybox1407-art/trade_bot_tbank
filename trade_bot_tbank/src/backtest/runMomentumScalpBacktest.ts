import * as fs from 'fs';
import * as path from 'path';
import { Candle, DEFAULT_SCALP_PARAMS } from '../services/momentumScalpStrategy';
import { runMomentumScalpBacktest, ScalpBacktestResult } from './momentumScalpBacktest';

function loadCandles(filePath: string): Candle[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  if (Array.isArray(data)) return data;
  if (data.candles && Array.isArray(data.candles)) return data.candles;
  if (data.data && Array.isArray(data.data)) return data.data;
  throw new Error('Unknown candle format');
}

function formatCurrency(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPct(n: number): string {
  return (n * 100).toFixed(2) + '%';
}

function printSummary(result: ScalpBacktestResult) {
  console.log('\n=== MOMENTUM SCALP BACKTEST RESULT ===');
  console.log(`Starting Balance: ${formatCurrency(result.equity[0])} ₽`);
  console.log(`Final Balance:    ${formatCurrency(result.finalBalance)} ₽`);
  console.log(`Total Return:     ${formatCurrency(result.finalBalance - result.equity[0])} ₽ (${result.totalReturn.toFixed(2)}%)`);
  console.log(`Total Trades:     ${result.totalTrades}`);
  console.log(`Win Rate:         ${formatPct(result.winRate)}`);
  console.log(`Profit Factor:    ${result.profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown:     ${formatCurrency(result.maxDrawdown)} ₽ (${((result.maxDrawdown / result.equity[0]) * 100).toFixed(2)}%)`);
  console.log(`Avg Trade:        ${formatCurrency(result.avgTrade)} ₽`);
  console.log(`Avg Bars Held:    ${result.avgBars.toFixed(1)}`);
  console.log(`Gross Profit:     ${formatCurrency(result.grossProfit)} ₽`);
  console.log(`Gross Loss:       ${formatCurrency(result.grossLoss)} ₽`);
  console.log(`Commission Total: ${formatCurrency(result.commissionTotal)} ₽`);
}

function printTrades(result: ScalpBacktestResult) {
  if (result.trades.length === 0) return;
  console.log('\n=== TRADES ===');
  console.log('# | Entry Time | Side | Entry | Exit | PnL | PnL% | Bars | Reason');
  result.trades.forEach((t, i) => {
    const time = new Date(t.entryTime).toISOString();
    console.log(`${i + 1} | ${time} | ${t.side.toUpperCase()} | ${t.entryPrice.toFixed(2)} | ${t.exitPrice.toFixed(2)} | ${formatCurrency(t.pnl)} | ${t.pnlPct.toFixed(3)}% | ${t.barsHeld} | ${t.exitReason}`);
  });
}

function printExitDistribution(result: ScalpBacktestResult) {
  const counts: Record<string, number> = {};
  result.trades.forEach(t => {
    counts[t.exitReason] = (counts[t.exitReason] || 0) + 1;
  });
  const rows = Object.entries(counts).map(([reason, count]) => ({ reason, count }));
  if (rows.length) {
    console.log('\n=== EXIT REASONS ===');
    console.table(rows);
  }
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
  printTrades(result);
  printExitDistribution(result);
  console.log(`\nBacktest completed in ${elapsed}ms`);
}

main();
