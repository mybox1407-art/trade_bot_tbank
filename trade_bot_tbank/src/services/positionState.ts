// trade_bot_tbank/src/services/positionState.ts

export type EntryMode =
  | 'none'
  | 'standard'
  | 'breakout_entry';

export type MarketRegime =
  | 'trend_up'
  | 'trend_down'
  | 'range'
  | 'breakout_watch'
  | 'trend_breakout'
  | 'high_volatility'
  | 'unknown';

export type CloseReason =
  | 'take_profit'
  | 'stop_loss'
  | 'breakout_time_fail'
  | 'session_close'
  | 'manual';

export interface VirtualPosition {
  symbol: string;
  side: 'long' | 'short';

  entryPrice: number;
  quantity: number;

  /**
   * Номинал позиции, зарезервированный из бумажного капитала.
   * Освобождается автоматически после удаления позиции при closePosition().
   */
  notional: number;

  takeProfitPrice: number;
  stopLossPrice: number;
  openedAt: string;

  /**
   * Комиссия входа уже списана из balance при openPosition().
   */
  entryCommission: number;

  /**
   * Контекст и параметры стратегии фиксируются в момент открытия.
   * Не подменяй regimeAtEntry текущим режимом при закрытии:
   * статистика должна строиться по режиму именно в момент входа.
   */
  entryMode: EntryMode;
  regimeAtEntry: MarketRegime;

  /**
   * Фактический риск на одну бумагу.
   * Рассчитывается от фактической цены исполнения:
   * abs(entryPrice - stopLossPrice).
   */
  initialR: number;

  /**
   * Параметры сопровождения breakout-позиции.
   *
   * На четвёртом закрытом 5m-баре position manager проверяет:
   * MFE < timeFailMinMfeR -> breakout_time_fail.
   */
  timeFailBars: number;
  timeFailMinMfeR: number;

  /**
   * Минимальный требуемый TP1 / initialR на входе.
   * Хранится для аудита и последующей статистики.
   */
  minTp1R: number;

  /**
   * Время сигнальной 5m-свечи, с которой был создан вход.
   * Нужно, чтобы time-fail не считал сигнальную свечу первым баром.
   */
  signalCandleTime: number | null;
}

export interface ClosedTrade {
  symbol: string;
  side: 'long' | 'short';

  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notional: number;

  /**
   * PnL сделки после комиссии выхода.
   * Комиссия входа была списана раньше, непосредственно при открытии.
   */
  realizedPnL: number;

  closedAt: string;
  reason: CloseReason;

  entryCommission: number;
  exitCommission: number;
  totalCommission: number;

  /**
   * Снимок входных условий для статистики.
   */
  entryMode: EntryMode;
  regimeAtEntry: MarketRegime;
  initialR: number;
  timeFailBars: number;
  timeFailMinMfeR: number;
  minTp1R: number;
  signalCandleTime: number | null;
}

// ============================================================================
// ЭКСПОРТИРУЕМЫЕ КОНСТАНТЫ
// ============================================================================
export const STARTING_BALANCE = 50000;
export const COMMISSION_RATE = 0.0005;
export const MAX_OPEN_POSITIONS = 3;

// ============================================================================
// ВНУТРЕННЕЕ СОСТОЯНИЕ
//
// balance:
//   Общий текущий баланс, уже с учётом уплаченных комиссий и PnL
//   закрытых сделок.
//
// positions:
//   Открытые виртуальные позиции. Их notional резервируется, но не
//   вычитается из balance: резерв виден через getAvailableBalance().
//
// availableBalance:
//   balance - sum(notional всех открытых позиций).
// ============================================================================
let balance = STARTING_BALANCE;

const positions = new Map<string, VirtualPosition>();

const lastClosedTrades = new Map<
  string,
  ClosedTrade
>();

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeEntryMode(
  entryMode: EntryMode | undefined
): EntryMode {
  if (
    entryMode === 'standard' ||
    entryMode === 'breakout_entry'
  ) {
    return entryMode;
  }

  return 'none';
}

function normalizeRegime(
  regime: MarketRegime | undefined
): MarketRegime {
  const allowed: MarketRegime[] = [
    'trend_up',
    'trend_down',
    'range',
    'breakout_watch',
    'trend_breakout',
    'high_volatility',
    'unknown'
  ];

  return regime && allowed.includes(regime)
    ? regime
    : 'unknown';
}

function normalizePositiveNumber(
  value: number | undefined | null,
  fallback: number
): number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
  )
    ? value
    : fallback;
}

function normalizeNonNegativeNumber(
  value: number | undefined | null,
  fallback: number
): number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  )
    ? value
    : fallback;
}

// ============================================================================
// БАЛАНС / РЕЗЕРВ
// ============================================================================
export function getBalance(): number {
  return roundMoney(balance);
}

export function getReservedNotional(): number {
  const reserved = Array.from(positions.values())
    .reduce(
      (sum, position) => sum + position.notional,
      0
    );

  return roundMoney(reserved);
}

export function getAvailableBalance(): number {
  return Math.max(
    0,
    roundMoney(getBalance() - getReservedNotional())
  );
}

export function getPosition(
  symbol: string
): VirtualPosition | null {
  return positions.get(normalizeSymbol(symbol)) ?? null;
}

export function getAllPositions(): VirtualPosition[] {
  return Array.from(positions.values());
}

export function getOpenPositionsCount(): number {
  return positions.size;
}

export function getLastClosedTrade(
  symbol?: string
): ClosedTrade | null {
  if (symbol) {
    return lastClosedTrades.get(
      normalizeSymbol(symbol)
    ) ?? null;
  }

  const trades = Array.from(
    lastClosedTrades.values()
  );

  if (!trades.length) return null;

  return trades.sort(
    (a, b) =>
      new Date(b.closedAt).getTime() -
      new Date(a.closedAt).getTime()
  )[0];
}

// ============================================================================
// ОТКРЫТИЕ ПОЗИЦИИ
// ============================================================================
export function openPosition(data: {
  symbol: string;
  side: 'long' | 'short';

  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;

  positionSize?: number | null;
  quantity?: number | null;

  /**
   * Контекст входа и параметры breakout-сопровождения.
   * Все поля optional ради обратной совместимости со старым кодом,
   * но autoBot.ts должен передавать их для breakout_entry.
   */
  entryMode?: EntryMode;
  regimeAtEntry?: MarketRegime;
  initialR?: number | null;
  timeFailBars?: number | null;
  timeFailMinMfeR?: number | null;
  minTp1R?: number | null;
  signalCandleTime?: number | null;
}) {
  const symbol = normalizeSymbol(data.symbol);

  if (
    !Number.isFinite(data.entryPrice) ||
    data.entryPrice <= 0
  ) {
    return {
      ok: false,
      message: 'Invalid entry price'
    };
  }

  if (
    !Number.isFinite(data.takeProfitPrice) ||
    data.takeProfitPrice <= 0
  ) {
    return {
      ok: false,
      message: 'Invalid take-profit price'
    };
  }

  if (
    !Number.isFinite(data.stopLossPrice) ||
    data.stopLossPrice <= 0
  ) {
    return {
      ok: false,
      message: 'Invalid stop-loss price'
    };
  }

  if (
    data.side === 'long' &&
    data.stopLossPrice >= data.entryPrice
  ) {
    return {
      ok: false,
      message:
        'Invalid long stop-loss: ' +
        'stop must be below entry price'
    };
  }

  if (
    data.side === 'short' &&
    data.stopLossPrice <= data.entryPrice
  ) {
    return {
      ok: false,
      message:
        'Invalid short stop-loss: ' +
        'stop must be above entry price'
    };
  }

  if (
    data.side === 'long' &&
    data.takeProfitPrice <= data.entryPrice
  ) {
    return {
      ok: false,
      message:
        'Invalid long take-profit: ' +
        'take-profit must be above entry price'
    };
  }

  if (
    data.side === 'short' &&
    data.takeProfitPrice >= data.entryPrice
  ) {
    return {
      ok: false,
      message:
        'Invalid short take-profit: ' +
        'take-profit must be below entry price'
    };
  }

  const existingPosition = positions.get(symbol);

  if (existingPosition) {
    return {
      ok: false,
      message: `Position already open for ${symbol}`,
      position: existingPosition
    };
  }

  if (positions.size >= MAX_OPEN_POSITIONS) {
    return {
      ok: false,
      message:
        `Max open positions limit reached ` +
        `(${MAX_OPEN_POSITIONS})`
    };
  }

  let quantity: number;
  let notional: number;

  if (
    data.quantity != null &&
    Number.isFinite(data.quantity) &&
    data.quantity > 0
  ) {
    quantity = Math.floor(data.quantity);
    notional = quantity * data.entryPrice;
  } else if (
    data.positionSize != null &&
    Number.isFinite(data.positionSize) &&
    data.positionSize > 0
  ) {
    quantity = Math.floor(
      data.positionSize / data.entryPrice
    );

    notional = quantity * data.entryPrice;
  } else {
    return {
      ok: false,
      message: 'quantity or positionSize is required'
    };
  }

  if (
    !Number.isFinite(quantity) ||
    !Number.isFinite(notional) ||
    quantity <= 0 ||
    notional <= 0
  ) {
    return {
      ok: false,
      message: 'Invalid position size'
    };
  }

  const reservedNotionalBefore = getReservedNotional();
  const availableBalanceBefore = getAvailableBalance();

  const entryCommission = roundMoney(
    notional * COMMISSION_RATE
  );

  /**
   * Для открытия должно хватать:
   * - полного номинала, который будет зарезервирован;
   * - входной комиссии, которая списывается немедленно.
   */
  const requiredCash = roundMoney(
    notional + entryCommission
  );

  if (requiredCash > availableBalanceBefore) {
    return {
      ok: false,
      message:
        `Insufficient available balance: ` +
        `required=${requiredCash.toFixed(2)}, ` +
        `available=${availableBalanceBefore.toFixed(2)}`,

      balance: getBalance(),
      reservedNotional: reservedNotionalBefore,
      availableBalance: availableBalanceBefore,
      requiredCash,
      notional,
      entryCommission
    };
  }

  /**
   * Номинал не вычитается из balance.
   * Он становится резервом после positions.set().
   *
   * Входная комиссия списывается немедленно.
   */
  balance = roundMoney(balance - entryCommission);

  const calculatedInitialR = Math.abs(
    data.entryPrice - data.stopLossPrice
  );

  const initialR = normalizePositiveNumber(
    data.initialR,
    calculatedInitialR
  );

  const entryMode = normalizeEntryMode(
    data.entryMode
  );

  const regimeAtEntry = normalizeRegime(
    data.regimeAtEntry
  );

  const timeFailBars = Math.floor(
    normalizeNonNegativeNumber(
      data.timeFailBars,
      entryMode === 'breakout_entry'
        ? 4
        : 0
    )
  );

  const timeFailMinMfeR = normalizeNonNegativeNumber(
    data.timeFailMinMfeR,
    entryMode === 'breakout_entry'
      ? 0.25
      : 0
  );

  const minTp1R = normalizeNonNegativeNumber(
    data.minTp1R,
    entryMode === 'breakout_entry'
      ? 1.15
      : 0
  );

  const signalCandleTime =
    data.signalCandleTime != null &&
    Number.isFinite(data.signalCandleTime) &&
    data.signalCandleTime > 0
      ? data.signalCandleTime
      : null;

  const position: VirtualPosition = {
    symbol,
    side: data.side,

    entryPrice: data.entryPrice,
    quantity,

    notional: roundMoney(notional),

    takeProfitPrice: data.takeProfitPrice,
    stopLossPrice: data.stopLossPrice,
    openedAt: new Date().toISOString(),

    entryCommission,

    entryMode,
    regimeAtEntry,

    initialR,

    timeFailBars,
    timeFailMinMfeR,

    minTp1R,
    signalCandleTime
  };

  positions.set(symbol, position);

  const reservedNotionalAfter = getReservedNotional();
  const availableBalanceAfter = getAvailableBalance();

  return {
    ok: true,
    balance: getBalance(),

    reservedNotionalBefore,
    reservedNotionalAfter,

    availableBalanceBefore,
    availableBalance: availableBalanceAfter,

    entryCommission,
    requiredCash,

    position
  };
}

// ============================================================================
// ЗАКРЫТИЕ ПОЗИЦИИ
// ============================================================================
export function closePosition(
  symbol: string,
  exitPrice: number,
  reason: CloseReason
) {
  const normalizedSymbol = normalizeSymbol(symbol);

  if (
    !Number.isFinite(exitPrice) ||
    exitPrice <= 0
  ) {
    return {
      ok: false,
      message: 'Invalid exit price'
    };
  }

  const position = positions.get(normalizedSymbol);

  if (!position) {
    return {
      ok: false,
      message:
        `No open position for ${normalizedSymbol}`
    };
  }

  const balanceBefore = getBalance();
  const reservedNotionalBefore = getReservedNotional();
  const availableBalanceBefore = getAvailableBalance();

  const grossPnL =
    position.side === 'long'
      ? (exitPrice - position.entryPrice) *
        position.quantity
      : (position.entryPrice - exitPrice) *
        position.quantity;

  const exitNotional = exitPrice * position.quantity;

  const exitCommission = roundMoney(
    exitNotional * COMMISSION_RATE
  );

  /**
   * Entry commission уже списана из balance при openPosition().
   * Поэтому здесь добавляем PnL минус только exit commission.
   */
  const realizedPnL = roundMoney(
    grossPnL - exitCommission
  );

  const totalCommission = roundMoney(
    position.entryCommission +
    exitCommission
  );

  const closedTrade: ClosedTrade = {
    symbol: position.symbol,
    side: position.side,

    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity,
    notional: position.notional,

    realizedPnL,

    closedAt: new Date().toISOString(),
    reason,

    entryCommission: position.entryCommission,
    exitCommission,
    totalCommission,

    entryMode: position.entryMode,
    regimeAtEntry: position.regimeAtEntry,

    initialR: position.initialR,
    timeFailBars: position.timeFailBars,
    timeFailMinMfeR: position.timeFailMinMfeR,

    minTp1R: position.minTp1R,
    signalCandleTime: position.signalCandleTime
  };

  /**
   * При удалении позиции её notional автоматически перестаёт входить
   * в getReservedNotional(), то есть резерв освобождается.
   */
  positions.delete(normalizedSymbol);

  /**
   * Добавляем финансовый результат закрытия.
   * Входная комиссия второй раз не вычитается.
   */
  balance = roundMoney(balance + realizedPnL);

  lastClosedTrades.set(
    normalizedSymbol,
    closedTrade
  );

  const reservedNotionalAfter = getReservedNotional();
  const availableBalanceAfter = getAvailableBalance();

  return {
    ok: true,

    balanceBefore,
    balance: getBalance(),

    reservedNotionalBefore,
    reservedNotionalAfter,

    availableBalanceBefore,
    availableBalance: availableBalanceAfter,

    grossPnL: roundMoney(grossPnL),
    realizedPnL,
    exitCommission,
    totalCommission,

    lastClosedTrade: closedTrade
  };
}
