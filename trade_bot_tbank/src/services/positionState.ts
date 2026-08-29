// trade_bot_tbank/src/services/positionState.ts

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
   * Комиссия входа была списана ранее, непосредственно при открытии.
   */
  realizedPnL: number;

  closedAt: string;
  reason: 'take_profit' | 'stop_loss' | 'manual';
  entryCommission: number;
  exitCommission: number;
  totalCommission: number;
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

  const position: VirtualPosition = {
    symbol,
    side: data.side,
    entryPrice: data.entryPrice,
    quantity,
    notional: roundMoney(notional),
    takeProfitPrice: data.takeProfitPrice,
    stopLossPrice: data.stopLossPrice,
    openedAt: new Date().toISOString(),
    entryCommission
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
  reason: 'take_profit' | 'stop_loss' | 'manual'
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
    totalCommission
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
