import {
  analyzeMarket,
  Candle,
  MarketRegime,
  PARTIAL_LOCK_R,
  TP1_FRACTION
} from '../services/strategy';

/**
 * Настройки бэктеста.
 */
export interface BacktestOptions {
  startingBalance?: number;
  /** Комиссия за одну сторону (0.0005 = 0.05%). */
  commissionRate?: number;
  warmupCandles?: number;
  onePositionAtTime?: boolean;
  /** Если на свече и SL, и TP — считаем стоп. */
  conservativeIntrabarExecution?: boolean;
  /** Пауза после ЛЮБОЙ закрытой сделки (свечи). */
  cooldownCandles?: number;
  progressLogEvery?: number;
  /**
   * Макс. новых входов за календарный день (UTC).
   * 0 = без лимита.
   */
  maxTradesPerDay?: number;
  /** Закрыть по close, если позиция живёт дольше N свечей. */
  timeStopBars?: number;
  /**
   * Early abort: если через N бар нет earlyAbortMinR * R — выход по close.
   * 0 = выключено.
   */
  earlyAbortBars?: number;
  earlyAbortMinR?: number;
  /**
   * Трейл остатка после TP1, в единицах R.
   * 0 = только lock, без трейла.
   */
  runnerTrailR?: number;
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
  /** Текущий оставшийся объём */
  quantity: number;
  initialQuantity: number;
  positionSize: number;
  balanceBefore: number;
  initialR: number;
  tp1Done: boolean;
  tp1Fraction: number;
}

export interface BacktestTrade {
  symbol: string;
  side: 'long' | 'short';
  regime: MarketRegime | string;
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
    | 'take_profit'
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

export interface BacktestSummary {
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

export interface BacktestResult {
  symbol: string;
  options: Required<BacktestOptions>;
  trades: BacktestTrade[];
  summary: BacktestSummary;
  equityCurve: Array<{ time: number; balance: number }>;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

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
  if (side === 'long') return (exitPrice - entryPrice) * quantity;
  return (entryPrice - exitPrice) * quantity;
}

/** YYYY-MM-DD UTC */
function utcDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function tryOpenPosition(params: {
  visibleCandles: Candle[];
  currentBalance: number;
}): OpenPosition | null {
  const { visibleCandles, currentBalance } = params;
  const signal = analyzeMarket(visibleCandles, currentBalance);

  if (
    signal.side === 'none' ||
    signal.quantity == null ||
    signal.positionSize == null ||
    signal.stopLossPrice == null ||
    signal.takeProfit1Price == null ||
    signal.takeProfit2Price == null ||
    signal.initialR == null
  ) {
    return null;
  }

  const lastCandle = visibleCandles[visibleCandles.length - 1];
  const entryPrice = toNumber(signal.price);
  const stopLossPrice = toNumber(signal.stopLossPrice);
  const initialR = toNumber(signal.initialR);

  if (entryPrice <= 0 || initialR <= 0) return null;

  return {
    side: signal.side,
    regime: signal.regime,
    openedAt: lastCandle.time,
    entryPrice,
    stopLossPrice,
    initialStopLossPrice: stopLossPrice,
    takeProfit1Price: toNumber(signal.takeProfit1Price),
    takeProfit2Price: toNumber(signal.takeProfit2Price),
    quantity: toNumber(signal.quantity),
    initialQuantity: toNumber(signal.quantity),
    positionSize: toNumber(signal.positionSize),
    balanceBefore: currentBalance,
    initialR,
    tp1Done: false,
    tp1Fraction: signal.tp1Fraction ?? TP1_FRACTION
  };
}

/**
 * После TP1: трейлим стоп остатка от экстремума.
 * Не опускаем стоп ниже lock (entry ± PARTIAL_LOCK_R * R).
 */
function updateRunnerTrail(params: {
  position: OpenPosition;
  candle: Candle;
  trailR: number;
}): void {
  const { position, candle, trailR } = params;
  if (!position.tp1Done || trailR <= 0) return;

  const r = position.initialR;
  if (r <= 0) return;

  const lock = r * PARTIAL_LOCK_R;

  if (position.side === 'long') {
    const floor = position.entryPrice + lock;
    const trailStop = candle.high - trailR * r;
    const next = Math.max(floor, trailStop);
    if (next > position.stopLossPrice) {
      position.stopLossPrice = next;
    }
  } else {
    const ceiling = position.entryPrice - lock;
    const trailStop = candle.low + trailR * r;
    const next = Math.min(ceiling, trailStop);
    if (next < position.stopLossPrice) {
      position.stopLossPrice = next;
    }
  }
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
  /** Комиссию на вход — только на первую ногу позиции */
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

  const openTurnover = position.entryPrice * qty;
  const closeTurnover = exitPrice * qty;
  const commissionOpen = chargeOpenCommission
    ? getCommission(openTurnover, commissionRate)
    : 0;
  const commissionClose = getCommission(closeTurnover, commissionRate);
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

/**
 * Причина закрытия по стопу после TP1: lock ≈ breakeven, дальше — trail.
 */
function stopReasonAfterTp1(position: OpenPosition): 'breakeven' | 'trail_stop' {
  const lockDist = position.initialR * PARTIAL_LOCK_R;
  const movedFromEntry = Math.abs(position.stopLossPrice - position.entryPrice);
  // Если стоп ушёл заметно дальше lock — это трейл
  if (movedFromEntry > lockDist * 1.15) {
    return 'trail_stop';
  }
  return 'breakeven';
}

/**
 * Выходы на свече: SL, TP1 (partial), TP2.
 * Conservative: при SL+TP на одной свече — SL.
 */
function processExitsOnCandle(params: {
  symbol: string;
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
  const { symbol, position, candle, commissionRate, barsHeld, conservative } =
    params;

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

  // SL приоритетнее TP при conservative
  if (hitStop && (hitTp1 || hitTp2) && conservative) {
    const reason = position.tp1Done
      ? stopReasonAfterTp1(position)
      : 'stop_loss';
    const t = buildTrade({
      symbol,
      position,
      qty: position.quantity,
      exitPrice: position.stopLossPrice,
      closedAt: candle.time,
      closeReason: reason,
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

  // TP1 — частичное закрытие
  if (hitTp1 && position.quantity > 1) {
    let qty1 = Math.floor(position.initialQuantity * position.tp1Fraction);
    qty1 = Math.max(1, Math.min(qty1, position.quantity - 1));

    const t1 = buildTrade({
      symbol,
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

    // Остаток: стоп в +PARTIAL_LOCK_R
    const lock = position.initialR * PARTIAL_LOCK_R;
    if (position.side === 'long') {
      position.stopLossPrice = Math.max(
        position.stopLossPrice,
        position.entryPrice + lock
      );
    } else {
      position.stopLossPrice = Math.min(
        position.stopLossPrice,
        position.entryPrice - lock
      );
    }
  }

  // qty=1 и hitTp1 — закрываем целиком по TP1
  if (hitTp1 && !position.tp1Done && position.quantity === 1) {
    const t = buildTrade({
      symbol,
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
    const reason = position.tp1Done
      ? stopReasonAfterTp1(position)
      : 'stop_loss';
    const t = buildTrade({
      symbol,
      position,
      qty: position.quantity,
      exitPrice: position.stopLossPrice,
      closedAt: candle.time,
      closeReason: reason,
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
    const reason = position.tp1Done
      ? stopReasonAfterTp1(position)
      : 'stop_loss';
    const t = buildTrade({
      symbol,
      position,
      qty: position.quantity,
      exitPrice: position.stopLossPrice,
      closedAt: candle.time,
      closeReason: reason,
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
      symbol,
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

function calculateDrawdown(equityCurve: Array<{ time: number; balance: number }>) {
  let peak = equityCurve.length ? equityCurve[0].balance : 0;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;

  for (const point of equityCurve) {
    if (point.balance > peak) peak = point.balance;
    const drawdownAbs = peak - point.balance;
    const drawdownPct = peak > 0 ? drawdownAbs / peak : 0;
    if (drawdownAbs > maxDrawdownAbs) maxDrawdownAbs = drawdownAbs;
    if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;
  }

  return {
    maxDrawdownAbs: round(maxDrawdownAbs),
    maxDrawdownPct: round(maxDrawdownPct, 6)
  };
}

/**
 * Сводка: группируем ноги одного входа (openedAt+side+entry).
 */
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
  const drawdown = calculateDrawdown(equityCurve);

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
    avgLoss: round(
      losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0
    ),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 6) : Infinity,
    startBalance: round(startBalance),
    endBalance: round(endBalance),
    returnPct: round(returnPct, 6),
    maxDrawdownAbs: drawdown.maxDrawdownAbs,
    maxDrawdownPct: drawdown.maxDrawdownPct
  };
}

/**
 * Основной прогон бэктеста.
 */
export function runStrategyBacktest(
  symbol: string,
  candles: Candle[],
  options: BacktestOptions = {}
): BacktestResult {
  const resolvedOptions: Required<BacktestOptions> = {
    startingBalance: options.startingBalance ?? 50000,
    commissionRate: options.commissionRate ?? 0.0005,
    warmupCandles: options.warmupCandles ?? 250,
    onePositionAtTime: options.onePositionAtTime ?? true,
    conservativeIntrabarExecution: options.conservativeIntrabarExecution ?? true,
    cooldownCandles: options.cooldownCandles ?? 6,
    progressLogEvery: options.progressLogEvery ?? 5000,
    maxTradesPerDay: options.maxTradesPerDay ?? 0,
    timeStopBars: options.timeStopBars ?? 80,
    earlyAbortBars: options.earlyAbortBars ?? 0,
    earlyAbortMinR: options.earlyAbortMinR ?? 0.25,
    runnerTrailR: options.runnerTrailR ?? 1.2
  };

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
      equityCurve: []
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

  const startedAt = Date.now();
  const totalBarsToProcess = Math.max(
    sortedCandles.length - resolvedOptions.warmupCandles,
    0
  );

  for (let i = resolvedOptions.warmupCandles; i < sortedCandles.length; i++) {
    const visibleCandles = sortedCandles.slice(0, i + 1);
    const currentCandle = sortedCandles[i];
    const barsHeld = openPosition ? i - openPositionIndex : 0;

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
        const progressPct =
          totalBarsToProcess > 0 ? (processedBars / totalBarsToProcess) * 100 : 100;

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
      // Трейл runner после TP1 (до проверки выходов)
      updateRunnerTrail({
        position: openPosition,
        candle: currentCandle,
        trailR: resolvedOptions.runnerTrailR
      });

      // Time-stop
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

      if (openPosition) {
        const result = processExitsOnCandle({
          symbol,
          position: openPosition,
          candle: currentCandle,
          balance,
          commissionRate: resolvedOptions.commissionRate,
          barsHeld,
          conservative: resolvedOptions.conservativeIntrabarExecution,
          openCommissionRemaining
        });

        balance = result.balance;
        openCommissionRemaining = result.openCommissionRemaining;

        for (const t of result.trades) {
          trades.push(t);
          equityCurve.push({ time: currentCandle.time, balance: round(balance) });
        }

        if (!result.stillOpen) {
          cooldownRemaining = resolvedOptions.cooldownCandles;
          openPosition = null;
          openPositionIndex = -1;
          openCommissionRemaining = false;
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
      const usedToday = entriesPerDay.get(dayKey) ?? 0;
      if (usedToday >= resolvedOptions.maxTradesPerDay) continue;
    }

    const maybeOpen = tryOpenPosition({
      visibleCandles,
      currentBalance: balance
    });

    if (maybeOpen) {
      openPosition = maybeOpen;
      openPositionIndex = i;
      openCommissionRemaining = true;

      if (resolvedOptions.maxTradesPerDay > 0) {
        const dayKey = utcDateKey(currentCandle.time);
        const usedToday = entriesPerDay.get(dayKey) ?? 0;
        entriesPerDay.set(dayKey, usedToday + 1);
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
    equityCurve
  };
}
