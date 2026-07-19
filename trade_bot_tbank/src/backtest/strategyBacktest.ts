import { analyzeMarket, Candle, MarketRegime } from '../services/strategy';

/**
 * Настройки бэктеста.
 */
export interface BacktestOptions {
  /**
   * Начальный баланс.
   */
  startingBalance?: number;

  /**
   * Комиссия за одну сторону сделки.
   * Например 0.003 = 0.3%
   */
  commissionRate?: number;

  /**
   * Сколько свечей нужно минимум для "разогрева" индикаторов
   * перед первым вызовом стратегии.
   */
  warmupCandles?: number;

  /**
   * Разрешать ли только одну открытую позицию одновременно.
   * Пока по умолчанию true.
   */
  onePositionAtTime?: boolean;

  /**
   * Консервативный режим:
   * если на одной свече коснулись и стопа, и тейка,
   * считаем, что сработал стоп.
   */
  conservativeIntrabarExecution?: boolean;

  /**
   * Количество свечей паузы после убыточной сделки / стопа.
   * Пока пауза активна, новые входы запрещены.
   */
  cooldownCandles?: number;

  /**
   * Как часто печатать прогресс в консоль.
   * Например 5000 = лог каждые 5000 свечей.
   * 0 или отрицательное значение отключает лог прогресса.
   */
  progressLogEvery?: number;
}

/**
 * Данные об открытой виртуальной позиции в бэктесте.
 */
interface OpenPosition {
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  quantity: number;
  positionSize: number;
  balanceBefore: number;
}

/**
 * Запись о завершенной сделке.
 */
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

  closeReason: 'stop_loss' | 'take_profit' | 'forced_close';

  grossPnl: number;
  commissionOpen: number;
  commissionClose: number;
  totalCommission: number;
  netPnl: number;

  balanceBefore: number;
  balanceAfter: number;

  barsHeld: number;
}

/**
 * Агрегированная статистика по прогону.
 */
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

/**
 * Полный результат бэктеста.
 */
export interface BacktestResult {
  symbol: string;
  options: Required<BacktestOptions>;
  trades: BacktestTrade[];
  summary: BacktestSummary;
  equityCurve: Array<{
    time: number;
    balance: number;
  }>;
}

/**
 * Безопасное число.
 */
function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Округление для красоты отчетов.
 */
function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Форматирование продолжительности для логов прогресса.
 */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 'неизвестно';
  }

  if (seconds < 60) {
    return `${Math.round(seconds)} сек`;
  }

  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);

  if (minutes < 60) {
    return `${minutes} мин ${secs} сек`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  return `${hours} ч ${mins} мин`;
}

/**
 * Расчет комиссии за одну сторону сделки.
 */
function getCommission(turnover: number, commissionRate: number): number {
  return turnover * commissionRate;
}

/**
 * Расчет PnL по позиции без комиссии.
 */
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

/**
 * Проверяем, нужно ли открыть новую сделку на текущей свече.
 */
function tryOpenPosition(params: {
  visibleCandles: Candle[];
  currentBalance: number;
}): OpenPosition | null {
  const { visibleCandles, currentBalance } = params;
  const signal = analyzeMarket(visibleCandles);

  if (
    signal.side === 'none' ||
    signal.positionSize == null ||
    signal.quantity == null ||
    signal.stopLossPrice == null ||
    signal.takeProfitPrice == null
  ) {
    return null;
  }

  const lastCandle = visibleCandles[visibleCandles.length - 1];
  const entryPrice = toNumber(signal.price);

  if (entryPrice <= 0) {
    return null;
  }

  return {
    side: signal.side,
    regime: signal.regime,
    openedAt: lastCandle.time,
    entryPrice,
    stopLossPrice: toNumber(signal.stopLossPrice),
    takeProfitPrice: toNumber(signal.takeProfitPrice),
    quantity: toNumber(signal.quantity),
    positionSize: toNumber(signal.positionSize),
    balanceBefore: currentBalance
  };
}

/**
 * Проверка выхода из позиции на текущей свече.
 *
 * Логика:
 * - long: если low <= stop => стоп, если high >= take => тейк
 * - short: если high >= stop => стоп, если low <= take => тейк
 *
 * Если и стоп, и тейк задеты на одной свече:
 * - в conservative режиме считаем, что сработал стоп
 * - иначе можно выбрать тейк, но по умолчанию лучше стоп
 */
function checkExitOnCandle(params: {
  position: OpenPosition;
  candle: Candle;
  conservativeIntrabarExecution: boolean;
}): { exitPrice: number; closeReason: 'stop_loss' | 'take_profit' } | null {
  const { position, candle, conservativeIntrabarExecution } = params;

  if (position.side === 'long') {
    const stopHit = candle.low <= position.stopLossPrice;
    const takeHit = candle.high >= position.takeProfitPrice;

    if (stopHit && takeHit) {
      return conservativeIntrabarExecution
        ? { exitPrice: position.stopLossPrice, closeReason: 'stop_loss' }
        : { exitPrice: position.takeProfitPrice, closeReason: 'take_profit' };
    }

    if (stopHit) {
      return { exitPrice: position.stopLossPrice, closeReason: 'stop_loss' };
    }

    if (takeHit) {
      return { exitPrice: position.takeProfitPrice, closeReason: 'take_profit' };
    }

    return null;
  }

  const stopHit = candle.high >= position.stopLossPrice;
  const takeHit = candle.low <= position.takeProfitPrice;

  if (stopHit && takeHit) {
    return conservativeIntrabarExecution
      ? { exitPrice: position.stopLossPrice, closeReason: 'stop_loss' }
      : { exitPrice: position.takeProfitPrice, closeReason: 'take_profit' };
  }

  if (stopHit) {
    return { exitPrice: position.stopLossPrice, closeReason: 'stop_loss' };
  }

  if (takeHit) {
    return { exitPrice: position.takeProfitPrice, closeReason: 'take_profit' };
  }

  return null;
}

/**
 * Закрытие позиции с расчетом комиссий и итогового PnL.
 */
function closePosition(params: {
  symbol: string;
  position: OpenPosition;
  closeReason: 'stop_loss' | 'take_profit' | 'forced_close';
  exitPrice: number;
  closedAt: number;
  balanceBeforeClose: number;
  commissionRate: number;
  barsHeld: number;
}): BacktestTrade {
  const {
    symbol,
    position,
    closeReason,
    exitPrice,
    closedAt,
    balanceBeforeClose,
    commissionRate,
    barsHeld
  } = params;

  const openTurnover = position.entryPrice * position.quantity;
  const closeTurnover = exitPrice * position.quantity;

  const commissionOpen = getCommission(openTurnover, commissionRate);
  const commissionClose = getCommission(closeTurnover, commissionRate);
  const totalCommission = commissionOpen + commissionClose;

  const grossPnl = getGrossPnl({
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity
  });

  const netPnl = grossPnl - totalCommission;
  const balanceAfter = balanceBeforeClose + netPnl;

  return {
    symbol,
    side: position.side,
    regime: position.regime,
    openedAt: position.openedAt,
    closedAt,
    entryPrice: round(position.entryPrice),
    exitPrice: round(exitPrice),
    stopLossPrice: round(position.stopLossPrice),
    takeProfitPrice: round(position.takeProfitPrice),
    quantity: round(position.quantity, 12),
    positionSize: round(position.positionSize, 8),
    closeReason,
    grossPnl: round(grossPnl),
    commissionOpen: round(commissionOpen),
    commissionClose: round(commissionClose),
    totalCommission: round(totalCommission),
    netPnl: round(netPnl),
    balanceBefore: round(position.balanceBefore),
    balanceAfter: round(balanceAfter),
    barsHeld
  };
}

/**
 * Подсчет максимальной просадки по equity curve.
 */
function calculateDrawdown(equityCurve: Array<{ time: number; balance: number }>) {
  let peak = equityCurve.length ? equityCurve[0].balance : 0;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;

  for (const point of equityCurve) {
    if (point.balance > peak) {
      peak = point.balance;
    }

    const drawdownAbs = peak - point.balance;
    const drawdownPct = peak > 0 ? drawdownAbs / peak : 0;

    if (drawdownAbs > maxDrawdownAbs) {
      maxDrawdownAbs = drawdownAbs;
    }

    if (drawdownPct > maxDrawdownPct) {
      maxDrawdownPct = drawdownPct;
    }
  }

  return {
    maxDrawdownAbs: round(maxDrawdownAbs),
    maxDrawdownPct: round(maxDrawdownPct, 6)
  };
}

/**
 * Сбор итоговой статистики по журналу сделок.
 */
function buildSummary(params: {
  symbol: string;
  trades: BacktestTrade[];
  startBalance: number;
  endBalance: number;
  equityCurve: Array<{ time: number; balance: number }>;
}): BacktestSummary {
  const { symbol, trades, startBalance, endBalance, equityCurve } = params;

  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);

  const grossProfit = wins.reduce((sum, t) => sum + t.netPnl, 0);
  const grossLossAbs = Math.abs(losses.reduce((sum, t) => sum + t.netPnl, 0));
  const netProfit = trades.reduce((sum, t) => sum + t.netPnl, 0);

  const avgNetPnl = trades.length ? netProfit / trades.length : 0;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length
    ? losses.reduce((sum, t) => sum + t.netPnl, 0) / losses.length
    : 0;

  const profitFactor = grossLossAbs > 0 ? grossProfit / grossLossAbs : (grossProfit > 0 ? Infinity : 0);
  const returnPct = startBalance > 0 ? (endBalance - startBalance) / startBalance : 0;

  const drawdown = calculateDrawdown(equityCurve);

  return {
    symbol,
    tradesCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(trades.length ? wins.length / trades.length : 0, 6),
    grossProfit: round(grossProfit),
    grossLoss: round(-grossLossAbs),
    netProfit: round(netProfit),
    avgNetPnl: round(avgNetPnl),
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 6) : Infinity,
    startBalance: round(startBalance),
    endBalance: round(endBalance),
    returnPct: round(returnPct, 6),
    maxDrawdownAbs: drawdown.maxDrawdownAbs,
    maxDrawdownPct: drawdown.maxDrawdownPct
  };
}

/**
 * Основная функция прогона бэктеста по одному инструменту.
 */
export function runStrategyBacktest(
  symbol: string,
  candles: Candle[],
  options: BacktestOptions = {}
): BacktestResult {
  const resolvedOptions: Required<BacktestOptions> = {
    startingBalance: options.startingBalance ?? 50000,
    commissionRate: options.commissionRate ?? 0.003,
    warmupCandles: options.warmupCandles ?? 250,
    onePositionAtTime: options.onePositionAtTime ?? true,
    conservativeIntrabarExecution: options.conservativeIntrabarExecution ?? true,
    cooldownCandles: options.cooldownCandles ?? 4,
    progressLogEvery: options.progressLogEvery ?? 5000
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

  // Счетчик свечей паузы после убыточной сделки / стопа
  let cooldownRemaining = 0;

  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ time: number; balance: number }> = [
    { time: sortedCandles[0].time, balance: round(balance) }
  ];

  // Метрики прогресса для долгого прогона
  const startedAt = Date.now();
  const totalBarsToProcess = Math.max(sortedCandles.length - resolvedOptions.warmupCandles, 0);

  for (let i = resolvedOptions.warmupCandles; i < sortedCandles.length; i++) {
    const visibleCandles = sortedCandles.slice(0, i + 1);
    const currentCandle = sortedCandles[i];

    // Печать реального прогресса по циклу.
    // Это помогает понять, что бэктест не завис, а действительно работает.
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
        const remainingBars = Math.max(totalBarsToProcess - processedBars, 0);
        const etaSec = remainingBars / Math.max(speed, 1e-9);
        const progressPct = totalBarsToProcess > 0
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

    // Если есть открытая позиция — сначала проверяем выход
    if (openPosition) {
      const exit = checkExitOnCandle({
        position: openPosition,
        candle: currentCandle,
        conservativeIntrabarExecution: resolvedOptions.conservativeIntrabarExecution
      });

      if (exit) {
        const trade = closePosition({
          symbol,
          position: openPosition,
          closeReason: exit.closeReason,
          exitPrice: exit.exitPrice,
          closedAt: currentCandle.time,
          balanceBeforeClose: balance,
          commissionRate: resolvedOptions.commissionRate,
          barsHeld: i - openPositionIndex
        });

        balance = trade.balanceAfter;
        trades.push(trade);
        equityCurve.push({ time: currentCandle.time, balance: round(balance) });

        // Если получили стоп или убыточную сделку —
        // включаем паузу на заданное число следующих свечей
        if (trade.closeReason === 'stop_loss' || trade.netPnl <= 0) {
          cooldownRemaining = resolvedOptions.cooldownCandles;
        }

        openPosition = null;
        openPositionIndex = -1;
      }
    }

    // Пока есть открытая позиция — новую не открываем
    if (openPosition && resolvedOptions.onePositionAtTime) {
      continue;
    }

    // Если активен cooldown — пропускаем входы на этой свече
    if (cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      continue;
    }

    if (!openPosition || !resolvedOptions.onePositionAtTime) {
      const maybeOpen = tryOpenPosition({
        visibleCandles,
        currentBalance: balance
      });

      if (maybeOpen && !openPosition) {
        openPosition = maybeOpen;
        openPositionIndex = i;
      }
    }
  }

  /**
   * Если в конце истории позиция все еще открыта,
   * закрываем ее по close последней свечи.
   */
  if (openPosition) {
    const lastCandle = sortedCandles[sortedCandles.length - 1];

    const trade = closePosition({
      symbol,
      position: openPosition,
      closeReason: 'forced_close',
      exitPrice: lastCandle.close,
      closedAt: lastCandle.time,
      balanceBeforeClose: balance,
      commissionRate: resolvedOptions.commissionRate,
      barsHeld: sortedCandles.length - 1 - openPositionIndex
    });

    balance = trade.balanceAfter;
    trades.push(trade);
    equityCurve.push({ time: lastCandle.time, balance: round(balance) });
  }

  const summary = buildSummary({
    symbol,
    trades,
    startBalance: resolvedOptions.startingBalance,
    endBalance: balance,
    equityCurve
  });

  return {
    symbol,
    options: resolvedOptions,
    trades,
    summary,
    equityCurve
  };
}
