import * as fs from 'fs';
import * as path from 'path';
import { Candle, DEFAULT_SCALP_PARAMS, ScalpParams } from '../services/momentumScalpStrategy';
import {
  runMomentumScalpBacktest,
  ScalpBacktestResult,
  ScalpTrade,
  RejectStat
} from './momentumScalpBacktest';

type PresetName = 'base' | 'presetA' | 'presetB' | 'presetC' | 'presetD';

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

function formatSignedCurrency(n: number): string {
  return `${n >= 0 ? '+' : ''}${formatCurrency(n)}`;
}

function formatPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

function formatFractionPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function buildParams(preset: PresetName): ScalpParams {
  const base: ScalpParams = { ...DEFAULT_SCALP_PARAMS };

  if (preset === 'base') {
    return base;
  }

  if (preset === 'presetA') {
    return {
      ...base,
      sessionStartHour: 10,
      sessionEndHour: 18.75,
      afternoonStartHour: 10,
      afternoonEndHour: 18.75
    };
  }

  if (preset === 'presetB') {
    return {
      ...base,
      sessionStartHour: 10,
      sessionEndHour: 18.75,
      afternoonStartHour: 10,
      afternoonEndHour: 18.75,
      minAtrPct: 0.0005
    };
  }

  if (preset === 'presetC') {
    return {
      ...base,
      sessionStartHour: 10,
      sessionEndHour: 18.75,
      afternoonStartHour: 10,
      afternoonEndHour: 18.75,
      minAtrPct: 0.0005,
      volumeMinRatio: 1.05
    };
  }

  return {
    ...base,
    sessionStartHour: 10,
    sessionEndHour: 18.75,
    afternoonStartHour: 10,
    afternoonEndHour: 18.75,
    minAtrPct: 0.0005,
    volumeMinRatio: 1.05,
    minImpulsePct: 0.00035
  };
}

function printParams(params: ScalpParams, preset: PresetName) {
  console.log('\n=== PRESET ===');
  console.log(preset);

  console.log('\n=== PARAMS ===');
  console.table([
    { name: 'riskPerTrade', value: params.riskPerTrade },
    { name: 'maxRiskPerTrade', value: params.maxRiskPerTrade },
    { name: 'commissionRate', value: params.commissionRate },
    { name: 'slippageRate', value: params.slippageRate },
    { name: 'atrPeriod', value: params.atrPeriod },
    { name: 'atrSlMult', value: params.atrSlMult },
    { name: 'atrTpMult', value: params.atrTpMult },
    { name: 'emaFastPeriod', value: params.emaFastPeriod },
    { name: 'emaSlowPeriod', value: params.emaSlowPeriod },
    { name: 'vwapPeriod', value: params.vwapPeriod },
    { name: 'volumeLookback', value: params.volumeLookback },
    { name: 'volumeMinRatio', value: params.volumeMinRatio },
    { name: 'minAtrPct', value: params.minAtrPct },
    { name: 'minImpulsePct', value: params.minImpulsePct },
    { name: 'minTargetMovePct', value: params.minTargetMovePct },
    { name: 'minCostCoverage', value: params.minCostCoverage },
    { name: 'maxPositionNotionalPct', value: params.maxPositionNotionalPct },
    { name: 'maxEntryDistanceFromVwapPct', value: params.maxEntryDistanceFromVwapPct },
    { name: 'timeStopBars', value: params.timeStopBars },
    { name: 'sessionStartHour', value: params.sessionStartHour },
    { name: 'sessionEndHour', value: params.sessionEndHour },
    { name: 'afternoonStartHour', value: params.afternoonStartHour },
    { name: 'afternoonEndHour', value: params.afternoonEndHour },
    { name: 'cooldownBars', value: params.cooldownBars }
  ]);
}

function printSummary(result: ScalpBacktestResult) {
  const startingBalance = result.equity[0] ?? 0;
  const absoluteReturn = result.finalBalance - startingBalance;
  const drawdownPct = startingBalance > 0
    ? (result.maxDrawdown / startingBalance) * 100
    : 0;

  console.log('\n=== MOMENTUM SCALP BACKTEST RESULT ===');
  console.log(`Starting Balance: ${formatCurrency(startingBalance)} ₽`);
  console.log(`Final Balance:    ${formatCurrency(result.finalBalance)} ₽`);
  console.log(`Total Return:     ${formatSignedCurrency(absoluteReturn)} ₽ (${formatPct(result.totalReturn)})`);
  console.log(`Total Trades:     ${result.totalTrades}`);
  console.log(`Win Rate:         ${formatFractionPct(result.winRate)}`);
  console.log(
    `Profit Factor:    ${Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : 'Infinity'}`
  );
  console.log(`Max Drawdown:     ${formatCurrency(result.maxDrawdown)} ₽ (${formatPct(drawdownPct)})`);
  console.log(`Avg Trade:        ${formatSignedCurrency(result.avgTrade)} ₽`);
  console.log(`Avg Bars Held:    ${result.avgBars.toFixed(1)}`);
  console.log(`Gross Profit:     ${formatCurrency(result.grossProfit)} ₽`);
  console.log(`Gross Loss:       ${formatCurrency(result.grossLoss)} ₽`);
  console.log(`Commission Total: ${formatCurrency(result.commissionTotal)} ₽`);
}

function printTradeStats(result: ScalpBacktestResult) {
  if (result.trades.length === 0) {
    console.log('\n=== TRADE STATS ===');
    console.log('No trades');
    return;
  }

  const positiveNet = result.trades.filter((t: ScalpTrade) => t.netPnl > 0).length;
  const negativeNet = result.trades.filter((t: ScalpTrade) => t.netPnl < 0).length;
  const positiveGross = result.trades.filter((t: ScalpTrade) => t.grossPnl > 0).length;
  const negativeTakeProfits = result.trades.filter(
    (t: ScalpTrade) => t.exitReason === 'take_profit' && t.netPnl < 0
  ).length;
  const longTrades = result.trades.filter((t: ScalpTrade) => t.side === 'long').length;
  const shortTrades = result.trades.filter((t: ScalpTrade) => t.side === 'short').length;

  console.log('\n=== TRADE STATS ===');
  console.log(`Positive net trades: ${positiveNet}`);
  console.log(`Negative net trades: ${negativeNet}`);
  console.log(`Positive gross trades: ${positiveGross}`);
  console.log(`Negative take_profit trades after costs: ${negativeTakeProfits}`);
  console.log(`Long trades: ${longTrades}`);
  console.log(`Short trades: ${shortTrades}`);
}

function printRejectStats(result: ScalpBacktestResult) {
  console.log('\n=== REJECT REASONS ===');

  if (!result.rejectStats || result.rejectStats.length === 0) {
    console.log('No rejects collected');
    return;
  }

  const totalRejects = result.rejectStats.reduce(
    (sum: number, row: RejectStat) => sum + row.count,
    0
  );

  const rows = result.rejectStats.map((row: RejectStat) => ({
    reason: row.reason,
    count: row.count,
    sharePct: totalRejects > 0 ? ((row.count / totalRejects) * 100).toFixed(2) : '0.00'
  }));

  console.table(rows);
  console.log(`Total rejects: ${totalRejects}`);
}

function printTopRejectComment(result: ScalpBacktestResult) {
  if (!result.rejectStats || result.rejectStats.length === 0) {
    return;
  }

  const top = result.rejectStats[0];
  const totalRejects = result.rejectStats.reduce(
    (sum: number, row: RejectStat) => sum + row.count,
    0
  );
  const share = totalRejects > 0 ? (top.count / totalRejects) * 100 : 0;

  console.log('\n=== TOP REJECT ===');
  console.log(`${top.reason}: ${top.count} (${share.toFixed(2)}%)`);
}

function printTrades(result: ScalpBacktestResult, limit: number = 200) {
  if (result.trades.length === 0) {
    return;
  }

  console.log('\n=== TRADES ===');
  console.log(
    '# | Signal Time | Entry Time | Side | Entry | Exit | Size | GrossPnL | Commission | NetPnL | PnL% | Bars | Reason'
  );

  const rows = result.trades.slice(0, limit);

  rows.forEach((t: ScalpTrade, i: number) => {
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
        formatSignedCurrency(t.grossPnl),
        formatCurrency(t.commission),
        formatSignedCurrency(t.netPnl),
        `${t.pnlPct.toFixed(3)}%`,
        t.barsHeld,
        t.exitReason
      ].join(' | ')
    );
  });

  if (result.trades.length > limit) {
    console.log(`... truncated: shown ${limit} of ${result.trades.length} trades`);
  }
}

function printExitDistribution(result: ScalpBacktestResult) {
  const counts: Record<string, number> = {};

  result.trades.forEach((t: ScalpTrade) => {
    counts[t.exitReason] = (counts[t.exitReason] || 0) + 1;
  });

  const rows = Object.entries(counts)
    .map(([reason, count]: [string, number]) => ({ reason, count }))
    .sort((a: { reason: string; count: number }, b: { reason: string; count: number }) => b.count - a.count);

  console.log('\n=== EXIT REASONS ===');

  if (rows.length === 0) {
    console.log('No exits');
    return;
  }

  console.table(rows);
}

function parsePreset(value: string | undefined): PresetName {
  if (value === 'presetA') return 'presetA';
  if (value === 'presetB') return 'presetB';
  if (value === 'presetC') return 'presetC';
  if (value === 'presetD') return 'presetD';
  return 'base';
}

function main() {
  const args = process.argv.slice(2);
  const filePath = args[0] || path.join(__dirname, 'data', 'SBER_1m.json');
  const ticker = args[1] || 'SBER';
  const preset = parsePreset(args[2]);

  console.log(`Loading 1m candles for ${ticker} from ${filePath}...`);
  const candles = loadCandles(filePath);
  console.log(`Loaded ${candles.length} candles`);

  const params = buildParams(preset);

  const startedAt = Date.now();
  const result = runMomentumScalpBacktest(candles, params);
  const elapsedMs = Date.now() - startedAt;

  printParams(params, preset);
  printSummary(result);
  printTradeStats(result);
  printRejectStats(result);
  printTopRejectComment(result);
  printTrades(result, 200);
  printExitDistribution(result);

  console.log(`\nBacktest completed in ${elapsedMs}ms`);
}

main();
