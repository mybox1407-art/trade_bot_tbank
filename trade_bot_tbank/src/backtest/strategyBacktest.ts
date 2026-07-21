type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type SideFilter = 'both' | 'long' | 'short';
type MarketRegime = 'trend_up' | 'trend_down' | 'range' | 'high_volatility' | 'unknown';
type HtfBias = 'up' | 'down' | 'neutral';

interface HtfBarState {
  time: number;
  bias: HtfBias;
  adx: number;
  ema20: number;
  ema50: number;
  ema200: number;
  close: number;
}

interface HtfStats {
  rejects: number;
  passes: number;
  warmupRejects: number;
}

interface RegimeBarBucket {
  bars: number;
  pct: number;
}

interface RegimeTradeBucket {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  avgBarsHeld: number;
  closeReasons: Record<string, number>;
}

interface RegimeStats {
  totalBars: number;
  barsByRegime: Record<string, RegimeBarBucket>;
  tradesByRegime: Record<string, RegimeTradeBucket>;
  closeReasonsAll: Record<string, number>;
}

interface BacktestTrade {
  symbol: string;
  side: 'long' | 'short';
  regime: string;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  quantity: number;
  positionSize: number;
  closeReason:
    | 'stop_loss'
    | 'take_profit_1'
    | 'take_profit_2'
    | 'forced_close'
    | 'time_stop'
    | 'early_abort'
    | 'breakeven'
    | 'trail_stop';
  grossPnl: number;
  commissionOpen: number;
  commissionClose: number;
  totalCommission: number;
  netPnl: number;
  balanceBefore: number;
  balanceAfter: number;
  barsHeld: number;
  leg: 'partial' | 'full';
}

interface BacktestSummary {
  symbol: string;
  tradesCount: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  avgNetPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  startBalance: number;
  endBalance: number;
  returnPct: number;
  maxDrawdownAbs: number;
  maxDrawdownPct: number;
}

interface BacktestOptions {
  startingBalance?: number;
  commissionRate?: number;
  warmupCandles?: number;
  onePositionAtTime?: boolean;
  conservativeIntrabarExecution?: boolean;
  cooldownCandles?: number;
  progressLogEvery?: number;
  maxTradesPerDay?: number;
  timeStopBars?: number;
  earlyAbortBars?: number;
  earlyAbortMinR?: number;
  runnerTrailR?: number;
  htfFilter?: boolean;
  htfMinAdx1h?: number;
  sideFilter?: SideFilter;
}

interface BacktestResult {
  symbol: string;
  options: Required<BacktestOptions>;
  trades: BacktestTrade[];
  summary: BacktestSummary;
  equityCurve: Array<{ time: number; balance: number }>;
  htfStats: HtfStats;
  regimeStats: RegimeStats;
}

interface OpenPosition {
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  entryPrice: number;
  stopLossPrice: number;
  initialStopLossPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  quantity: number;
  initialQuantity: number;
  positionSize: number;
  balanceBefore: number;
  initialR: number;
  tp1Done: boolean;
  tp1Fraction: number;
  timeFailBars: number;
}

const STARTING_BALANCE = 50000;
const MAX_RISK_PER_TRADE = 0.01;
const COMMISSION_RATE = 0.0005;
const ROUND_TRIP_COMMISSION_RATE = COMMISSION_RATE * 2;
const TP1_FRACTION = 0.4;
const TP1_R = 1.5;
const TP2_R = 2.0;
const PARTIAL_LOCK_R = 0;
const DEFAULT_TIME_FAIL_BARS = 4;
const DEFAULT_COOLDOWN_CANDLES = 12;
const PROGRESS_LOG_EVERY = 5000;
const MIN_QUANTITY = 2;
const MAX_POSITION_FRAC = 0.3;
const MAX_COMMISSION_SHARE_OF_RISK = 0.28;
const TRADING_HOUR_UTC_FROM = 7;
const TRADING_HOUR_UTC_TO = 15;

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function prev<T>(arr: T[]): T {
  return arr[arr.length - 2];
}

function isTradingHour(timestamp: number): boolean {
  const hourUtc = new Date(timestamp).getUTCHours();
  return hourUtc >= TRADING_HOUR_UTC_FROM && hourUtc < TRADING_HOUR_UTC_TO;
}

function utcDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function getCommission(turnover: number, commissionRate: number): number {
  return turnover * commissionRate;
}

function getGrossPnl(params: {
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
}): number {
  const { side, entryPrice, exitPrice, quantity } = params;
  return side === 'long'
    ? (exitPrice - entryPrice) * quantity
    : (entryPrice - exitPrice) * quantity;
}

function calculateDrawdown(equityCurve: Array<{ time: number; balance: number }>) {
  let peak = equityCurve.length ? equityCurve[0].balance : 0;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    if (point.balance > peak) peak = point.balance;
    const d = peak - point.balance;
    const dp = peak > 0 ? d / peak : 0;
    if (d > maxDrawdownAbs) maxDrawdownAbs = d;
    if (dp > maxDrawdownPct) maxDrawdownPct = dp;
  }
  return {
    maxDrawdownAbs: round(maxDrawdownAbs),
    maxDrawdownPct: round(maxDrawdownPct, 6)
  };
}

function emptyRegimeStats(): RegimeStats {
  return {
    totalBars: 0,
    barsByRegime: {},
    tradesByRegime: {},
    closeReasonsAll: {}
  };
}

function incReason(map: Record<string, number>, reason: string, n = 1): void {
  map[reason] = (map[reason] ?? 0) + n;
}

function buildRegimeStats(trades: BacktestTrade[], barCounts: Record<string, number>): RegimeStats {
  const totalBars = Object.values(barCounts).reduce((a, b) => a + b, 0);
  const barsByRegime: Record<string, RegimeBarBucket> = {};
  for (const [reg, bars] of Object.entries(barCounts)) {
    barsByRegime[reg] = {
      bars,
      pct: totalBars > 0 ? round(bars / totalBars, 6) : 0
    };
  }

  type Agg = {
    regime: string;
    net: number;
    barsMax: number;
    reasons: Record<string, number>;
  };

  const groups = new Map<string, Agg>();

  for (const t of trades) {
    const key = `${t.openedAt}|${t.side}|${t.entryPrice}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        regime: String(t.regime ?? 'unknown'),
        net: 0,
        barsMax: 0,
        reasons: {}
      };
      groups.set(key, g);
    }
    g.net += t.netPnl;
    g.barsMax = Math.max(g.barsMax, t.barsHeld);
    incReason(g.reasons, t.closeReason);
  }

  const tradesByRegime: Record<string, RegimeTradeBucket> = {};
  const closeReasonsAll: Record<string, number> = {};

  for (const g of groups.values()) {
    const reg = g.regime || 'unknown';
    let b = tradesByRegime[reg];
    if (!b) {
      b = {
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        netProfit: 0,
        grossProfit: 0,
        grossLoss: 0,
        profitFactor: 0,
        avgBarsHeld: 0,
        closeReasons: {}
      };
      tradesByRegime[reg] = b;
    }

    b.trades += 1;
    b.netProfit += g.net;
    if (g.net > 0) {
      b.wins += 1;
      b.grossProfit += g.net;
    } else {
      b.losses += 1;
      b.grossLoss += g.net;
    }
    b.avgBarsHeld += g.barsMax;

    for (const [reason, n] of Object.entries(g.reasons)) {
      incReason(b.closeReasons, reason, n);
      incReason(closeReasonsAll, reason, n);
    }
  }

  for (const b of Object.values(tradesByRegime)) {
    const gl = Math.abs(b.grossLoss);
    b.winRate = b.trades > 0 ? round(b.wins / b.trades, 6) : 0;
    b.netProfit = round(b.netProfit);
    b.grossProfit = round(b.grossProfit);
    b.grossLoss = round(b.grossLoss);
    b.profitFactor = gl > 0 ? round(b.grossProfit / gl, 6) : b.grossProfit > 0 ? Infinity : 0;
    b.avgBarsHeld = b.trades > 0 ? round(b.avgBarsHeld / b.trades, 2) : 0;
  }

  return { totalBars, barsByRegime, tradesByRegime, closeReasonsAll };
}

function buildSummary(params: {
  symbol: string;
  trades: BacktestTrade[];
  startBalance: number;
  endBalance: number;
  equityCurve: Array<{ time: number; balance: number }>;
}): BacktestSummary {
  const { symbol, trades, startBalance, endBalance, equityCurve } = params;
  const groups = new Map<string, number>();
  for (const t of trades) {
    const key = `${t.openedAt}|${t.side}|${t.entryPrice}`;
    groups.set(key, (groups.get(key) ?? 0) + t.netPnl);
  }

  const groupPnls = [...groups.values()];
  const wins = groupPnls.filter(p => p > 0);
  const losses = groupPnls.filter(p => p <= 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLossAbs = Math.abs(losses.reduce((a, b) => a + b, 0));
  const netProfit = groupPnls.reduce((a, b) => a + b, 0);
  const profitFactor =
    grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? Infinity : 0;
  const returnPct = startBalance > 0 ? (endBalance - startBalance) / startBalance : 0;
  const dd = calculateDrawdown(equityCurve);

  return {
    symbol,
    tradesCount: groupPnls.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(groupPnls.length ? wins.length / groupPnls.length : 0, 6),
    grossProfit: round(grossProfit),
    grossLoss: round(-grossLossAbs),
    netProfit: round(netProfit),
    avgNetPnl: round(groupPnls.length ? netProfit / groupPnls.length : 0),
    avgWin: round(wins.length ? grossProfit / wins.length : 0),
    avgLoss: round(losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 6) : Infinity,
    startBalance: round(startBalance),
    endBalance: round(endBalance),
    returnPct: round(returnPct, 6),
    maxDrawdownAbs: dd.maxDrawdownAbs,
    maxDrawdownPct: dd.maxDrawdownPct
  };
}

function processExitsOnCandle(params: {
  position: OpenPosition;
  candle: Candle;
  balance: number;
  commissionRate: number;
  barsHeld: number;
  conservative: boolean;
  openCommissionRemaining: boolean;
}): {
  trades: BacktestTrade[];
  balance: number;
  stillOpen: boolean;
  openCommissionRemaining: boolean;
} {
  const { position, candle, commissionRate, barsHeld, conservative } = params;
  let { balance, openCommissionRemaining } = params;
  const trades: BacktestTrade[] = [];

  const hitStop =
    position.side === 'long'
      ? candle.low <= position.stopLossPrice
      : candle.high >= position.stopLossPrice;

  const hitTp1 =
    !position.tp1Done &&
    (position.side === 'long'
      ? candle.high >= position.takeProfit1Price
      : candle.low <= position.takeProfit1Price);

  const hitTp2 =
    position.side === 'long'
      ? candle.high >= position.takeProfit2Price
      : candle.low <= position.takeProfit2Price;

  if (hitStop && (hitTp1 || hitTp2) && conservative) {
    const t = buildTrade({
      symbol: '',
      position,
      qty: position.quantity,
      exitPrice: position.stopLossPrice,
      closedAt: candle.time,
      closeReason: position.tp1Done ? 'breakeven' : 'stop_loss',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      leg: 'full',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t.balanceAfter;
    trades.push(t);
    position.quantity = 0;
    return { trades, balance, stillOpen: false, openCommissionRemaining: false };
  }

  if (hitTp1 && position.quantity > 1) {
    let qty1 = Math.floor(position.initialQuantity * position.tp1Fraction);
    qty1 = Math.max(1, Math.min(qty1, position.quantity - 1));

    const t1 = buildTrade({
      symbol: '',
      position,
      qty: qty1,
      exitPrice: position.takeProfit1Price,
      closedAt: candle.time,
      closeReason: 'take_profit_1',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      leg: 'partial',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t1.balanceAfter;
    trades.push(t1);
    openCommissionRemaining = false;
    position.quantity -= qty1;
    position.tp1Done = true;
  }

  if (hitTp1 && !position.tp1Done && position.quantity === 1) {
    const t = buildTrade({
      symbol: '',
      position,
      qty: 1,
      exitPrice: position.takeProfit1Price,
      closedAt: candle.time,
      closeReason: 'take_profit_1',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      leg: 'full',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t.balanceAfter;
    trades.push(t);
    position.quantity = 0;
    return { trades, balance, stillOpen: false, openCommissionRemaining: false };
  }

  const hitStop2 =
    position.side === 'long'
      ? candle.low <= position.stopLossPrice
      : candle.high >= position.stopLossPrice;

  const hitTp2b =
    position.side === 'long'
      ? candle.high >= position.takeProfit2Price
      : candle.low <= position.takeProfit2Price;

  if (position.quantity > 0 && hitStop2 && hitTp2b && conservative) {
    const t = buildTrade({
      symbol: '',
      position,
      qty: position.quantity,
      exitPrice: position.stopLossPrice,
      closedAt: candle.time,
      closeReason: position.tp1Done ? 'breakeven' : 'stop_loss',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      leg: 'full',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t.balanceAfter;
    trades.push(t);
    position.quantity = 0;
    return { trades, balance, stillOpen: false, openCommissionRemaining: false };
  }

  if (position.quantity > 0 && hitStop2) {
    const t = buildTrade({
      symbol: '',
      position,
      qty: position.quantity,
      exitPrice: position.stopLossPrice,
      closedAt: candle.time,
      closeReason: position.tp1Done ? 'breakeven' : 'stop_loss',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      leg: 'full',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t.balanceAfter;
    trades.push(t);
    position.quantity = 0;
    return { trades, balance, stillOpen: false, openCommissionRemaining: false };
  }

  if (position.quantity > 0 && hitTp2b) {
    const t = buildTrade({
      symbol: '',
      position,
      qty: position.quantity,
      exitPrice: position.takeProfit2Price,
      closedAt: candle.time,
      closeReason: 'take_profit_2',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld,
      leg: 'full',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t.balanceAfter;
    trades.push(t);
    position.quantity = 0;
    return { trades, balance, stillOpen: false, openCommissionRemaining: false };
  }

  return {
    trades,
    balance,
    stillOpen: position.quantity > 0,
    openCommissionRemaining
  };
}

function buildTrade(params: {
  symbol: string;
  position: OpenPosition;
  qty: number;
  exitPrice: number;
  closedAt: number;
  closeReason: BacktestTrade['closeReason'];
  balanceBeforeClose: number;
  commissionRate: number;
  barsHeld: number;
  leg: 'partial' | 'full';
  chargeOpenCommission: boolean;
}): BacktestTrade {
  const {
    symbol,
    position,
    qty,
    exitPrice,
    closedAt,
    closeReason,
    balanceBeforeClose,
    commissionRate,
    barsHeld,
    leg,
    chargeOpenCommission
  } = params;

  const commissionOpen = chargeOpenCommission ? getCommission(position.entryPrice * qty, commissionRate) : 0;
  const commissionClose = getCommission(exitPrice * qty, commissionRate);
  const totalCommission = commissionOpen + commissionClose;
  const grossPnl = getGrossPnl({
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: qty
  });
  const netPnl = grossPnl - totalCommission;

  return {
    symbol,
    side: position.side,
    regime: position.regime,
    openedAt: position.openedAt,
    closedAt,
    entryPrice: round(position.entryPrice),
    exitPrice: round(exitPrice),
    stopLossPrice: round(position.stopLossPrice),
    takeProfitPrice: round(
      leg === 'partial' ? position.takeProfit1Price : position.takeProfit2Price
    ),
    quantity: round(qty, 12),
    positionSize: round(position.entryPrice * qty, 8),
    closeReason,
    grossPnl: round(grossPnl),
    commissionOpen: round(commissionOpen),
    commissionClose: round(commissionClose),
    totalCommission: round(totalCommission),
    netPnl: round(netPnl),
    balanceBefore: round(position.balanceBefore),
    balanceAfter: round(balanceBeforeClose + netPnl),
    barsHeld,
    leg
  };
}

function tryOpenPosition(params: {
  visibleCandles: Candle[];
  currentBalance: number;
  htfEnabled: boolean;
  htfStats: HtfStats;
  sideFilter: SideFilter;
}): OpenPosition | null {
  const { visibleCandles, currentBalance, htfEnabled, htfStats, sideFilter } = params;

  const lastCandle = visibleCandles[visibleCandles.length - 1];
  const price = lastCandle.close;
  const side: 'long' | 'short' = lastCandle.close >= lastCandle.open ? 'long' : 'short';

  if (sideFilter === 'long' && side !== 'long') return null;
  if (sideFilter === 'short' && side !== 'short') return null;

  if (htfEnabled) htfStats.passes += 1;

  const stopLossPrice = side === 'long' ? price * 0.99 : price * 1.01;
  const initialR = Math.abs(price - stopLossPrice);
  if (initialR <= 0) return null;

  const riskCapital = currentBalance * MAX_RISK_PER_TRADE;
  const commPerShare = price * ROUND_TRIP_COMMISSION_RATE;
  const riskPerShare = initialR + commPerShare;
  if (commPerShare / riskPerShare > MAX_COMMISSION_SHARE_OF_RISK) return null;

  let quantity = Math.floor(riskCapital / riskPerShare);
  const maxQty = Math.floor((currentBalance * MAX_POSITION_FRAC) / price);
  quantity = Math.min(quantity, maxQty);
  if (quantity < MIN_QUANTITY) return null;

  return {
    side,
    regime: 'unknown',
    openedAt: lastCandle.time,
    entryPrice: price,
    stopLossPrice,
    initialStopLossPrice: stopLossPrice,
    takeProfit1Price: side === 'long' ? price + TP1_R * initialR : price - TP1_R * initialR,
    takeProfit2Price: side === 'long' ? price + TP2_R * initialR : price - TP2_R * initialR,
    quantity,
    initialQuantity: quantity,
    positionSize: quantity * price,
    balanceBefore: currentBalance,
    initialR,
    tp1Done: false,
    tp1Fraction: TP1_FRACTION,
    timeFailBars: DEFAULT_TIME_FAIL_BARS
  };
}

export function runStrategyBacktest(
  symbol: string,
  candles: Candle[],
  options: BacktestOptions = {}
): BacktestResult {
  const resolvedOptions: Required<BacktestOptions> = {
    startingBalance: options.startingBalance ?? STARTING_BALANCE,
    commissionRate: options.commissionRate ?? COMMISSION_RATE,
    warmupCandles: options.warmupCandles ?? 250,
    onePositionAtTime: options.onePositionAtTime ?? true,
    conservativeIntrabarExecution: options.conservativeIntrabarExecution ?? true,
    cooldownCandles: options.cooldownCandles ?? DEFAULT_COOLDOWN_CANDLES,
    progressLogEvery: options.progressLogEvery ?? PROGRESS_LOG_EVERY,
    maxTradesPerDay: options.maxTradesPerDay ?? 0,
    timeStopBars: options.timeStopBars ?? 64,
    earlyAbortBars: options.earlyAbortBars ?? 16,
    earlyAbortMinR: options.earlyAbortMinR ?? 0.35,
    runnerTrailR: options.runnerTrailR ?? 0,
    htfFilter: options.htfFilter ?? false,
    htfMinAdx1h: options.htfMinAdx1h ?? 18,
    sideFilter: options.sideFilter ?? 'both'
  };

  const emptyHtf: HtfStats = { rejects: 0, passes: 0, warmupRejects: 0 };

  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      symbol,
      options: resolvedOptions,
      trades: [],
      summary: buildSummary({
        symbol,
        trades: [],
        startBalance: resolvedOptions.startingBalance,
        endBalance: resolvedOptions.startingBalance,
        equityCurve: []
      }),
      equityCurve: [],
      htfStats: emptyHtf,
      regimeStats: emptyRegimeStats()
    };
  }

  const sortedCandles = [...candles].sort((a, b) => a.time - b.time);
  let balance = resolvedOptions.startingBalance;
  let openPosition: OpenPosition | null = null;
  let openPositionIndex = -1;
  let openCommissionRemaining = false;
  let cooldownRemaining = 0;
  const entriesPerDay = new Map<string, number>();
  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ time: number; balance: number }> = [
    { time: sortedCandles[0].time, balance: round(balance) }
  ];
  const htfStats: HtfStats = { rejects: 0, passes: 0, warmupRejects: 0 };
  const barCounts: Record<string, number> = {};

  const startedAt = Date.now();
  const totalBarsToProcess = Math.max(sortedCandles.length - resolvedOptions.warmupCandles, 0);

  for (let i = resolvedOptions.warmupCandles; i < sortedCandles.length; i++) {
    const currentCandle = sortedCandles[i];
    const visibleCandles = sortedCandles.slice(0, i + 1);
    const barsHeld = openPosition ? i - openPositionIndex : 0;

    const hour = new Date(currentCandle.time).getUTCHours();
    const regName: MarketRegime =
      hour >= 7 && hour < 15 ? 'trend_up' : 'range';
    barCounts[regName] = (barCounts[regName] ?? 0) + 1;

    if (resolvedOptions.progressLogEvery > 0) {
      const processedBars = i - resolvedOptions.warmupCandles;
      const shouldLog =
        processedBars > 0 &&
        (processedBars % resolvedOptions.progressLogEvery === 0 ||
          i === sortedCandles.length - 1);
      if (shouldLog) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const speed = processedBars / Math.max(elapsedSec, 1e-9);
        const remainingBars = Math.max(totalBarsToProcess - processedBars, 0);
        const etaSec = remainingBars / Math.max(speed, 1e-9);
        const progressPct = totalBarsToProcess > 0 ? (processedBars / totalBarsToProcess) * 100 : 100;
        console.log(
          [
            `[${symbol}]`,
            `Прогресс: ${processedBars}/${totalBarsToProcess}`,
            `${round(progressPct, 2)}%`,
            `Скорость: ${round(speed, 2)} свеч/сек`,
            `ETA: ${formatDuration(etaSec)}`,
            `Сделок: ${trades.length}`,
            `Баланс: ${round(balance, 2)}`
          ].join(' | ')
        );
      }
    }

    if (openPosition) {
      if (barsHeld >= openPosition.timeFailBars && !openPosition.tp1Done) {
        const fav =
          openPosition.side === 'long'
            ? currentCandle.close - openPosition.entryPrice
            : openPosition.entryPrice - currentCandle.close;
        if (fav < 0.45 * openPosition.initialR) {
          const t = buildTrade({
            symbol,
            position: openPosition,
            qty: openPosition.quantity,
            exitPrice: currentCandle.close,
            closedAt: currentCandle.time,
            closeReason: 'early_abort',
            balanceBeforeClose: balance,
            commissionRate: resolvedOptions.commissionRate,
            barsHeld,
            leg: 'full',
            chargeOpenCommission: openCommissionRemaining
          });
          balance = t.balanceAfter;
          trades.push(t);
          equityCurve.push({ time: currentCandle.time, balance: round(balance) });
          cooldownRemaining = resolvedOptions.cooldownCandles;
          openPosition = null;
          openPositionIndex = -1;
          openCommissionRemaining = false;
        }
      }

      if (openPosition) {
        if (barsHeld >= resolvedOptions.timeStopBars) {
          const t = buildTrade({
            symbol,
            position: openPosition,
            qty: openPosition.quantity,
            exitPrice: currentCandle.close,
            closedAt: currentCandle.time,
            closeReason: 'time_stop',
            balanceBeforeClose: balance,
            commissionRate: resolvedOptions.commissionRate,
            barsHeld,
            leg: 'full',
            chargeOpenCommission: openCommissionRemaining
          });
          balance = t.balanceAfter;
          trades.push(t);
          equityCurve.push({ time: currentCandle.time, balance: round(balance) });
          cooldownRemaining = resolvedOptions.cooldownCandles;
          openPosition = null;
          openPositionIndex = -1;
          openCommissionRemaining = false;
        } else if (
          resolvedOptions.earlyAbortBars > 0 &&
          barsHeld >= resolvedOptions.earlyAbortBars &&
          !openPosition.tp1Done
        ) {
          const fav =
            openPosition.side === 'long'
              ? currentCandle.close - openPosition.entryPrice
              : openPosition.entryPrice - currentCandle.close;
          if (fav < resolvedOptions.earlyAbortMinR * openPosition.initialR) {
            const t = buildTrade({
              symbol,
              position: openPosition,
              qty: openPosition.quantity,
              exitPrice: currentCandle.close,
              closedAt: currentCandle.time,
              closeReason: 'early_abort',
              balanceBeforeClose: balance,
              commissionRate: resolvedOptions.commissionRate,
              barsHeld,
              leg: 'full',
              chargeOpenCommission: openCommissionRemaining
            });
            balance = t.balanceAfter;
            trades.push(t);
            equityCurve.push({ time: currentCandle.time, balance: round(balance) });
            cooldownRemaining = resolvedOptions.cooldownCandles;
            openPosition = null;
            openPositionIndex = -1;
            openCommissionRemaining = false;
          }
        }
      }
    }

    if (openPosition && resolvedOptions.onePositionAtTime) continue;
    if (cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      continue;
    }

    if (resolvedOptions.maxTradesPerDay > 0) {
      const dayKey = utcDateKey(currentCandle.time);
      const used = entriesPerDay.get(dayKey) ?? 0;
      if (used >= resolvedOptions.maxTradesPerDay) continue;
    }

    const maybeOpen = tryOpenPosition({
      visibleCandles,
      currentBalance: balance,
      htfEnabled: resolvedOptions.htfFilter,
      htfStats,
      sideFilter: resolvedOptions.sideFilter
    });

    if (maybeOpen) {
      openPosition = maybeOpen;
      openPositionIndex = i;
      openCommissionRemaining = true;
      if (resolvedOptions.maxTradesPerDay > 0) {
        const dayKey = utcDateKey(currentCandle.time);
        entriesPerDay.set(dayKey, (entriesPerDay.get(dayKey) ?? 0) + 1);
      }
    }
  }

  if (openPosition) {
    const lastCandle = sortedCandles[sortedCandles.length - 1];
    const t = buildTrade({
      symbol,
      position: openPosition,
      qty: openPosition.quantity,
      exitPrice: lastCandle.close,
      closedAt: lastCandle.time,
      closeReason: 'forced_close',
      balanceBeforeClose: balance,
      commissionRate: resolvedOptions.commissionRate,
      barsHeld: sortedCandles.length - 1 - openPositionIndex,
      leg: 'full',
      chargeOpenCommission: openCommissionRemaining
    });
    balance = t.balanceAfter;
    trades.push(t);
    equityCurve.push({ time: lastCandle.time, balance: round(balance) });
  }

  return {
    symbol,
    options: resolvedOptions,
    trades,
    summary: buildSummary({
      symbol,
      trades,
      startBalance: resolvedOptions.startingBalance,
      endBalance: balance,
      equityCurve
    }),
    equityCurve,
    htfStats,
    regimeStats: buildRegimeStats(trades, barCounts)
  };
}

export { HTF_WARMUP_15M };
