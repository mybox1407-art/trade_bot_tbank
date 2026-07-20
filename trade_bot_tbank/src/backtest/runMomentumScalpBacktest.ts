import * as fs from 'fs';
import * as path from 'path';
import {
  Candle,
  DEFAULT_SCALP_V2_PARAMS,
  MomentumScalpV2Params
} from '../services/momentumScalpStrategy';
import {
  runMomentumScalpBacktestV2,
  ScalpBacktestResultV2,
  ScalpTradeV2,
  RejectStat
} from './momentumScalpBacktest';

type PresetName = 'base' | 'balanced' | 'aggressive';
type SideFilter = 'both' | 'long' | 'short';

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

function parsePreset(value: string | undefined): PresetName {
  if (value === 'balanced') return 'balanced';
  if (value === 'aggressive') return 'aggressive';
  return 'base';
}

function parseSide(value: string | undefined): SideFilter {
  if (value === 'long') return 'long';
  if (value === 'short') return 'short';
  return 'both';
}

function buildParams(preset: PresetName): MomentumScalpV2Params {
  const base: MomentumScalpV2Params = { ...DEFAULT_SCALP_V2_PARAMS };

  if (preset === 'base') {
    return base;
  }

  if (preset === 'balanced') {
    return {
      ...base,
      volumeMinRatio1m: 1.05,
      minPullbackPct: 0.0005,
      breakoutBufferPct: 0.0001,
      trendAtrExpandRatio5m: 1.05,
      atrTpMult: 2.1,
      timeStopBars: 18
    };
  }

  return {
    ...base,
    volumeMinRatio1m: 1.0,
    minPullbackPct: 0.0004,
    breakoutBufferPct: 0.00005,
    trendAtrExpandRatio5m: 1.0,
    atrTpMult: 2.2,
    atrSlMult: 1.05,
    timeStopBars: 20
  };
}

function printParams(params: MomentumScalpV2Params, preset: PresetName, side: SideFilter) {
  console.log('\n=== PRESET ===');
  console.log(preset);

  console.log('\n=== SIDE FILTER ===');
  console.log(side);

  console.log('\n=== PARAMS ===');
  console.table([
    { name: 'riskPerTrade', value: params.riskPerTrade },
    { name: 'maxRiskPerTrade', value: params.maxRiskPerTrade },
    { name: 'commissionRate', value: params.commissionRate },
    { name: 'slippageRate', value: params.slippageRate },
    { name: 'atrPeriod1m', value: params.atrPeriod1m },
    { name: 'atrPeriod5m', value: params.atrPeriod5m },
    { name: 'emaFastPeriod5m', value: params.emaFastPeriod5m },
    { name: 'emaSlowPeriod5m', value: params.emaSlowPeriod5m },
    { name: 'vwapPeriod1m', value: params.vwapPeriod1m },
    { name: 'volumeLookback1m', value: params.volumeLookback1m },
    { name: 'trendAtrLookback5m', value: params.trendAtrLookback5m },
    { name: 'trendAtrExpandRatio5m', value: params.trendAtrExpandRatio5m },
    { name: 'pullbackLookback1m', value: params.pullbackLookback1m },
    { name: 'breakoutBufferPct', value: params.breakoutBufferPct },
    { name: 'minPullbackPct', value: params.minPullbackPct },
    { name: 'minImpulseBodyPct', value: params.minImpulseBodyPct },
    { name: 'volumeMinRatio1m', value: params.volumeMinRatio1m },
    { name: 'atrSlMult', value: params.atrSlMult },
    { name: 'atrTpMult', value: params.atrTpMult },
    { name: 'timeStopBars', value: params.timeStopBars },
    { name: 'cooldownBars', value: params.cooldownBars },
    { name: 'minTargetMovePct', value: params.minTargetMovePct },
    { name: 'minCostCoverage', value: params.minCostCoverage },
    { name: 'maxEntryDistanceFromVwapPct', value: params.maxEntryDistanceFromVwapPct },
    { name: 'maxPositionNotionalPct', value: params.maxPositionNotionalPct },
    { name: 'sessionStartHour', value: params.sessionStartHour },
    { name: 'sessionEndHour', value: params.sessionEndHour }
  ]);
}

function printSummary(result: ScalpBacktestResultV2) {
  const startingBalance = result.equity[0] ?? 0;
  const absoluteReturn = result.finalBalance - startingBalance;
  const drawdownPct = startingBalance > 0
    ? (result.maxDrawdown / startingBalance) * 100
    : 0;

  console.log('\n=== MOMENTUM SCALP V2 BACKTEST RESULT ===');
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

function printTradeStats(result: ScalpBacktestResultV2) {
  if (result.trades.length === 0) {
    console.log('\n=== TRADE STATS ===');
    console.log('No trades');
    return;
  }

  const positiveNet = result.trades.filter((t: ScalpTradeV2) => t.netPnl > 0).length;
  const negativeNet = result.trades.filter((t: ScalpTradeV2) => t.netPnl < 0).length;
  const positiveGross = result.trades.filter((t: ScalpTradeV2) => t.grossPnl > 0).length;
  const longTrades = result.trades.filter((t: ScalpTradeV2) => t.side === 'long').length;
  const shortTrades = result.trades.filter((t: ScalpTradeV2) => t.side === 'short').length;

  console.log('\n=== TRADE STATS ===');
  console.log(`Positive net trades: ${positiveNet}`);
  console.log(`Negative net trades: ${negativeNet}`);
  console.log(`Positive gross trades: ${positiveGross}`);
  console.log(`Long trades: ${longTrades}`);
  console.log(`Short trades: ${shortTrades}`);
}

function printRejectStats(result: ScalpBacktestResultV2) {
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

function printTrades(result: ScalpBacktestResultV2, limit: number = 200) {
  if (result.trades.length === 0) {
    return;
  }

  console.log('\n=== TRADES ===');
  console.log(
    '# | Signal Time | Entry Time | Side | Entry | Exit | Size | GrossPnL | Commission | NetPnL | PnL% | Bars | Reason | VolRatio | PullbackPct | BodyPct | ATR1m | ATR5m'
  );

  const rows = result.trades.slice(0, limit);

  rows.forEach((t: ScalpTradeV2, i: number) => {
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
        t.exitReason,
        t.volumeRatio.toFixed(2),
        t.pullbackPct.toFixed(4),
        t.impulseBodyPct.toFixed(4),
        t.atr1m.toFixed(4),
        t.atr5m.toFixed(4)
      ].join(' | ')
    );
  });

  if (result.trades.length > limit) {
    console.log(`... truncated: shown ${limit} of ${result.trades.length} trades`);
  }
}

function printExitDistribution(result: ScalpBacktestResultV2) {
  const counts: Record<string, number> = {};

  result.trades.forEach((t: ScalpTradeV2) => {
    counts[t.exitReason] = (counts[t.exitReason] || 0) + 1;
  });

  const rows = Object.entries(counts)
    .map(([reason, count]: [string, number]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  console.log('\n=== EXIT REASONS ===');

  if (rows.length === 0) {
    console.log('No exits');
    return;
  }

  console.table(rows);
}

function main() {
  const args = process.argv.slice(2);
  const filePath = args[0] || path.join(__dirname, 'data', 'SBER_1m.json');
  const ticker = args[1] || 'SBER';
  const preset = parsePreset(args[2]);
  const side = parseSide(args[3]);

  console.log(`Loading 1m candles for ${ticker} from ${filePath}...`);
  const candles = loadCandles(filePath);
  console.log(`Loaded ${candles.length} candles`);

  const params = buildParams(preset);

  const startedAt = Date.now();
  const result = runMomentumScalpBacktestV2(candles, params, {
    allowLongs: side !== 'short',
    allowShorts: side !== 'long'
  });
  const elapsedMs = Date.now() - startedAt;

  printParams(params, preset, side);
  printSummary(result);
  printTradeStats(result);
  printRejectStats(result);
  printTrades(result, 200);
  printExitDistribution(result);

  console.log(`\nBacktest completed in ${elapsedMs}ms`);
}

main();
