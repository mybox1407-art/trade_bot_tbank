import { ATR } from 'technicalindicators';
import {
  analyzeMarket,
  Candle,
  MarketRegime,
  PARTIAL_LOCK_R,
  RUNNER_TRAIL_ATR_MULT,
  TP1_FRACTION
} from '../services/strategy';

export interface BacktestOptions {
  startingBalance?: number;
  commissionRate?: number;
  warmupCandles?: number;
  onePositionAtTime?: boolean;
  conservativeIntrabarExecution?: boolean;
  /** Пауза после ЛЮБОЙ закрытой сделки */
  cooldownCandles?: number;
  progressLogEvery?: number;
  /** 0 = без лимита входов в день */
  maxTradesPerDay?: number;
  timeStopBars?: number;
  /** 0 = early abort выкл. */
  earlyAbortBars?: number;
  earlyAbortMinR?: number;

  /**
   * Множитель ATR для runner после TP1.
   * 0 = использовать RUNNER_TRAIL_ATR_MULT из strategy.ts.
   */
  runnerTrailAtrMult?: number;
}

interface OpenPosition {
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  entryPrice: number;
  stopLossPrice: number;
  initialStopLossPrice: number;
  takeProfit1Price: number;

  /**
   * Фиксированный TP2 больше не используется.
   * Поле оставлено, чтобы не ломать структуру логов и BacktestTrade.
   */
  takeProfit2Price: number | null;

  quantity: number;
  initialQuantity: number;
  positionSize: number;
  balanceBefore: number;
  initialR: number;
  tp1Done: boolean;
  tp1Fraction: number;

  /**
   * Максимум/минимум фиксируются только после TP1.
   * По ним строится ATR trailing-stop.
   */
  highestHighSinceEntry: number;
  lowestLowSinceEntry: number;
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

  /**
   * Для partial leg — TP1.
   * Для runner — null, потому что фиксированного TP2 больше нет.
   */
  takeProfitPrice: number | null;

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

  if (side === 'long') {
    return (exitPrice - entryPrice) * quantity;
  }

  return (entryPrice - exitPrice) * quantity;
}

function utcDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function getLastAtr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;

  const values = ATR.calculate({
    period,
    high: candles.map(candle => candle.high),
    low: candles.map(candle => candle.low),
    close: candles.map(candle => candle.close)
  });

  return values[values.length - 1] ?? 0;
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
    signal.initialR == null
  ) {
    return null;
  }

  const lastCandle = visibleCandles[visibleCandles.length - 1];

  const entryPrice = toNumber(signal.price);
  const stopLossPrice = toNumber(signal.stopLossPrice);
  const initialR = toNumber(signal.initialR);
  const quantity = toNumber(signal.quantity);

  if (
    entryPrice <= 0 ||
    stopLossPrice <= 0 ||
    initialR <= 0 ||
    quantity < 1
  ) {
    return null;
  }

  return {
    side: signal.side,
    regime: signal.regime,
    openedAt: lastCandle.time,
    entryPrice,
    stopLossPrice,
    initialStopLossPrice: stopLossPrice,
    takeProfit1Price: toNumber(signal.takeProfit1Price),
    takeProfit2Price: null,
    quantity,
    initialQuantity: quantity,
    positionSize: toNumber(signal.positionSize),
    balanceBefore: currentBalance,
    initialR,
    tp1Done: false,
    tp1Fraction: signal.tp1Fraction ?? TP1_FRACTION,

    highestHighSinceEntry: lastCandle.high,
    lowestLowSinceEntry: lastCandle.low
  };
}

/**
 * ATR trailing-stop обновляется только после TP1.
 *
 * ВАЖНО:
 * Эта функция вызывается после проверки TP/SL на текущей свече.
 * Значит, новый стоп начинает действовать только на следующем баре,
 * что исключает look-ahead bias.
 */
function updateRunnerTrail(params: {
  position: OpenPosition;
  candle: Candle;
  atr: number;
  trailAtrMult: number;
}): void {
  const { position, candle, atr, trailAtrMult } = params;

  if (!position.tp1Done || atr <= 0 || trailAtrMult <= 0) {
    return;
  }

  position.highestHighSinceEntry = Math.max(
    position.highestHighSinceEntry,
    candle.high
  );

  position.lowestLowSinceEntry = Math.min(
    position.lowestLowSinceEntry,
    candle.low
  );

  const lock = position.initialR * PARTIAL_LOCK_R;

  if (position.side === 'long') {
    const protectedStop = position.entryPrice + lock;
    const atrStop =
      position.highestHighSinceEntry - atr * trailAtrMult;

    position.stopLossPrice = Math.max(
      position.stopLossPrice,
      protectedStop,
      atrStop
    );

    return;
  }

  const protectedStop = position.entryPrice - lock;
  const atrStop =
    position.lowestLowSinceEntry + atr * trailAtrMult;

  position.stopLossPrice = Math.min(
    position.stopLossPrice,
    protectedStop,
    atrStop
  );
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

  const commissionOpen = chargeOpenCommission
    ? getCommission(position.entryPrice * qty, commissionRate)
    : 0;

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

    takeProfitPrice:
      leg === 'partial'
        ? round(position.takeProfit1Price)
        : null,

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

function stopReasonAfterTp1(position: OpenPosition): 'breakeven' | 'trail_stop' {
  const lockDist = position.initialR * PARTIAL_LOCK_R;
  const moved = Math.abs(position.stopLossPrice - position.entryPrice);

  return moved > lockDist * 1.15
    ? 'trail_stop'
    : 'breakeven';
}

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
  const {
    symbol,
    position,
    candle,
    commissionRate,
    barsHeld,
    conservative
  } = params;

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

  /**
   * На одной свече могли быть достигнуты и SL, и TP1.
   * В conservative-режиме предполагаем, что сначала был исполнен SL.
   */
  if (hitStop && hitTp1 && conservative) {
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

    return {
      trades,
      balance,
      stillOpen: false,
      openCommissionRemaining: false
    };
  }

  /**
   * TP1: закрываем 25% (или фактическую tp1Fraction) и оставляем
   * минимум одну акцию для ATR-runner.
   */
  if (hitTp1 && position.quantity > 1) {
    let qty1 = Math.floor(position.initialQuantity * position.tp1Fraction);

    qty1 = Math.max(
      1,
      Math.min(qty1, position.quantity - 1)
    );

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

    /**
     * Базовая защита runner.
     * ATR trail начнёт обновлять этот стоп после завершения
     * текущей свечи и будет действовать со следующей.
     */
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

    /**
     * С момента TP1 максимум/минимум для trailing reset-ится.
     * Это защищает от неявного использования high/low до TP1.
     */
    position.highestHighSinceEntry = candle.high;
    position.lowestLowSinceEntry = candle.low;
  }

  /**
   * Если всего одна акция, частичный выход невозможен.
   * Закрываем всю позицию на TP1.
   */
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

    return {
      trades,
      balance,
      stillOpen: false,
      openCommissionRemaining: false
    };
  }

  /**
   * Если TP1 был достигнут на текущей свече, обновлённый защитный стоп
   * не должен срабатывать в этой же свече: иначе используется неизвестный
   * внутрисвечной порядок движения. Он начнёт работать со следующего бара.
   */
  if (hitTp1 && position.tp1Done) {
    return {
      trades,
      balance,
      stillOpen: position.quantity > 0,
      openCommissionRemaining
    };
  }

  /**
   * После TP1 и без TP2 runner закрывается только по стопу,
   * time-stop, early-abort либо forced-close.
   */
  if (position.quantity > 0 && hitStop) {
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

    return {
      trades,
      balance,
      stillOpen: false,
      openCommissionRemaining: false
    };
  }

  return {
    trades,
    balance,
    stillOpen: position.quantity > 0,
    openCommissionRemaining
  };
}

function calculateDrawdown(
  equityCurve: Array<{ time: number; balance: number }>
) {
  let peak = equityCurve.length ? equityCurve[0].balance : 0;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;

  for (const point of equityCurve) {
    if (point.balance > peak) {
      peak = point.balance;
    }

    const d = peak - point.balance;
    const dp = peak > 0 ? d / peak : 0;

    if (d > maxDrawdownAbs) {
      maxDrawdownAbs = d;
    }

    if (dp > maxDrawdownPct) {
      maxDrawdownPct = dp;
    }
  }

  return {
    maxDrawdownAbs: round(maxDrawdownAbs),
    maxDrawdownPct: round(maxDrawdownPct, 6)
  };
}

function buildSummary(params: {
  symbol: string;
  trades: BacktestTrade[];
  startBalance: number;
  endBalance: number;
  equityCurve: Array<{ time: number; balance: number }>;
}): BacktestSummary {
  const {
    symbol,
    trades,
    startBalance,
    endBalance,
    equityCurve
  } = params;

  const groups = new Map<string, number>();

  for (const trade of trades) {
    const key = `${trade.openedAt}|${trade.side}|${trade.entryPrice}`;

    groups.set(
      key,
      (groups.get(key) ?? 0) + trade.netPnl
    );
  }

  const groupPnls = [...groups.values()];

  const wins = groupPnls.filter(pnl => pnl > 0);
  const losses = groupPnls.filter(pnl => pnl <= 0);

  const grossProfit = wins.reduce((sum, pnl) => sum + pnl, 0);
  const grossLossAbs = Math.abs(
    losses.reduce((sum, pnl) => sum + pnl, 0)
  );

  const netProfit = groupPnls.reduce((sum, pnl) => sum + pnl, 0);

  const profitFactor =
    grossLossAbs > 0
      ? grossProfit / grossLossAbs
      : grossProfit > 0
        ? Infinity
        : 0;

  const returnPct =
    startBalance > 0
      ? (endBalance - startBalance) / startBalance
      : 0;

  const dd = calculateDrawdown(equityCurve);

  return {
    symbol,
    tradesCount: groupPnls.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(
      groupPnls.length ? wins.length / groupPnls.length : 0,
      6
    ),
    grossProfit: round(grossProfit),
    grossLoss: round(-grossLossAbs),
    netProfit: round(netProfit),
    avgNetPnl: round(
      groupPnls.length ? netProfit / groupPnls.length : 0
    ),
    avgWin: round(
      wins.length ? grossProfit / wins.length : 0
    ),
    avgLoss: round(
      losses.length
        ? losses.reduce((sum, pnl) => sum + pnl, 0) / losses.length
        : 0
    ),
    profitFactor: Number.isFinite(profitFactor)
      ? round(profitFactor, 6)
      : Infinity,
    startBalance: round(startBalance),
    endBalance: round(endBalance),
    returnPct: round(returnPct, 6),
    maxDrawdownAbs: dd.maxDrawdownAbs,
    maxDrawdownPct: dd.maxDrawdownPct
  };
}

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
    conservativeIntrabarExecution:
      options.conservativeIntrabarExecution ?? true,
    cooldownCandles: options.cooldownCandles ?? 12,
    progressLogEvery: options.progressLogEvery ?? 5000,
    maxTradesPerDay: options.maxTradesPerDay ?? 0,

    /** 120 баров 15m — примерно 2.5 торговых сессии */
    timeStopBars: options.timeStopBars ?? 120,

    earlyAbortBars: options.earlyAbortBars ?? 0,
    earlyAbortMinR: options.earlyAbortMinR ?? 0.25,

    /**
     * По умолчанию используется значение из strategy.ts.
     * Для сетки тестов можно передать 2, 2.5 или 3.
     */
    runnerTrailAtrMult:
      options.runnerTrailAtrMult ?? RUNNER_TRAIL_ATR_MULT
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

  const sortedCandles = [...candles].sort(
    (left, right) => left.time - right.time
  );

  let balance = resolvedOptions.startingBalance;
  let openPosition: OpenPosition | null = null;
  let openPositionIndex = -1;
  let openCommissionRemaining = false;
  let cooldownRemaining = 0;

  const entriesPerDay = new Map<string, number>();
  const trades: BacktestTrade[] = [];

  const equityCurve: Array<{ time: number; balance: number }> = [
    {
      time: sortedCandles[0].time,
      balance: round(balance)
    }
  ];

  const startedAt = Date.now();

  const totalBarsToProcess = Math.max(
    sortedCandles.length - resolvedOptions.warmupCandles,
    0
  );

  for (
    let i = resolvedOptions.warmupCandles;
    i < sortedCandles.length;
    i += 1
  ) {
    const visibleCandles = sortedCandles.slice(0, i + 1);
    const currentCandle = sortedCandles[i];
    const barsHeld = openPosition
      ? i - openPositionIndex
      : 0;

    if (resolvedOptions.progressLogEvery > 0) {
      const processedBars = i - resolvedOptions.warmupCandles;

      const shouldLog =
        processedBars > 0 &&
        (
          processedBars % resolvedOptions.progressLogEvery === 0 ||
          i === sortedCandles.length - 1
        );

      if (shouldLog) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const speed = processedBars / Math.max(elapsedSec, 1e-9);
        const remainingBars = Math.max(
          totalBarsToProcess - processedBars,
          0
        );
        const etaSec = remainingBars / Math.max(speed, 1e-9);

        const progressPct =
          totalBarsToProcess > 0
            ? (processedBars / totalBarsToProcess) * 100
            : 100;

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
      if (barsHeld >= resolvedOptions.timeStopBars) {
        const trade = buildTrade({
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

        balance = trade.balanceAfter;
        trades.push(trade);

        equityCurve.push({
          time: currentCandle.time,
          balance: round(balance)
        });

        cooldownRemaining = resolvedOptions.cooldownCandles;
        openPosition = null;
        openPositionIndex = -1;
        openCommissionRemaining = false;
      } else if (
        resolvedOptions.earlyAbortBars > 0 &&
        barsHeld >= resolvedOptions.earlyAbortBars &&
        !openPosition.tp1Done
      ) {
        const favorableMove =
          openPosition.side === 'long'
            ? currentCandle.close - openPosition.entryPrice
            : openPosition.entryPrice - currentCandle.close;

        if (
          favorableMove <
          resolvedOptions.earlyAbortMinR * openPosition.initialR
        ) {
          const trade = buildTrade({
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

          balance = trade.balanceAfter;
          trades.push(trade);

          equityCurve.push({
            time: currentCandle.time,
            balance: round(balance)
          });

          cooldownRemaining = resolvedOptions.cooldownCandles;
          openPosition = null;
          openPositionIndex = -1;
          openCommissionRemaining = false;
        }
      }

      if (openPosition) {
        /**
         * Сначала обрабатываем старые SL и TP1.
         * Новый ATR-stop не может сработать на баре,
         * из которого он был построен.
         */
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

        for (const trade of result.trades) {
          trades.push(trade);

          equityCurve.push({
            time: currentCandle.time,
            balance: round(balance)
          });
        }

        if (!result.stillOpen) {
          cooldownRemaining = resolvedOptions.cooldownCandles;
          openPosition = null;
          openPositionIndex = -1;
          openCommissionRemaining = false;
        }
      }

      /**
       * Обновляем trailing только после выхода/TP-проверок текущего бара.
       * Его обновлённое значение будет применяться на следующей свече.
       */
      if (openPosition && openPosition.tp1Done) {
        const currentAtr = getLastAtr(visibleCandles);

        updateRunnerTrail({
          position: openPosition,
          candle: currentCandle,
          atr: currentAtr,
          trailAtrMult: resolvedOptions.runnerTrailAtrMult
        });
      }
    }

    if (openPosition && resolvedOptions.onePositionAtTime) {
      continue;
    }

    if (cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      continue;
    }

    if (resolvedOptions.maxTradesPerDay > 0) {
      const dayKey = utcDateKey(currentCandle.time);
      const used = entriesPerDay.get(dayKey) ?? 0;

      if (used >= resolvedOptions.maxTradesPerDay) {
        continue;
      }
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

        entriesPerDay.set(
          dayKey,
          (entriesPerDay.get(dayKey) ?? 0) + 1
        );
      }
    }
  }

  if (openPosition) {
    const lastCandle = sortedCandles[sortedCandles.length - 1];

    const trade = buildTrade({
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

    balance = trade.balanceAfter;
    trades.push(trade);

    equityCurve.push({
      time: lastCandle.time,
      balance: round(balance)
    });
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
