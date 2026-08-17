// trade_bot_tbank/src/services/positionState.ts

export interface VirtualPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  notional: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  openedAt: string;
  entryCommission: number;
}

export interface ClosedTrade {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notional: number;
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
// ============================================================================
let balance = STARTING_BALANCE;
const positions = new Map<string, VirtualPosition>();
const lastClosedTrades = new Map<string, ClosedTrade>();

function normalizeSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

export function getBalance() {
  return balance;
}

export function getPosition(symbol: string) {
  return positions.get(normalizeSymbol(symbol)) ?? null;
}

export function getAllPositions() {
  return Array.from(positions.values());
}

export function getOpenPositionsCount() {
  return positions.size;
}

export function getReservedNotional() {
  return Array.from(positions.values()).reduce((sum, p) => sum + p.notional, 0);
}

export function getAvailableBalance() {
  return Math.max(0, balance - getReservedNotional());
}

export function getLastClosedTrade(symbol?: string) {
  if (symbol) {
    return lastClosedTrades.get(normalizeSymbol(symbol)) ?? null;
  }

  const trades = Array.from(lastClosedTrades.values());
  if (!trades.length) return null;

  return trades.sort(
    (a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime()
  )[0];
}

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
      message: `Max open positions limit reached (${MAX_OPEN_POSITIONS})`
    };
  }

  let quantity: number;
  let notional: number;

  if (data.quantity != null && data.quantity > 0) {
    quantity = Math.floor(data.quantity);
    notional = quantity * data.entryPrice;
  } else if (data.positionSize != null && data.positionSize > 0) {
    quantity = Math.floor(data.positionSize / data.entryPrice);
    notional = quantity * data.entryPrice;
  } else {
    return {
      ok: false,
      message: 'quantity or positionSize is required'
    };
  }

  if (quantity <= 0 || notional <= 0) {
    return {
      ok: false,
      message: 'Invalid position size'
    };
  }

  const entryCommission = notional * COMMISSION_RATE;
  const requiredCash = notional + entryCommission;
  const availableBalance = getAvailableBalance();

  if (requiredCash > availableBalance) {
    return {
      ok: false,
      message: `Insufficient available balance: required=${requiredCash.toFixed(2)}, available=${availableBalance.toFixed(2)}`
    };
  }

  balance -= entryCommission;

  const position: VirtualPosition = {
    symbol,
    side: data.side,
    entryPrice: data.entryPrice,
    quantity,
    notional,
    takeProfitPrice: data.takeProfitPrice,
    stopLossPrice: data.stopLossPrice,
    openedAt: new Date().toISOString(),
    entryCommission
  };

  positions.set(symbol, position);

  return {
    ok: true,
    balance,
    availableBalance: getAvailableBalance(),
    position
  };
}

export function closePosition(
  symbol: string,
  exitPrice: number,
  reason: 'take_profit' | 'stop_loss' | 'manual'
) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const position = positions.get(normalizedSymbol);

  if (!position) {
    return {
      ok: false,
      message: `No open position for ${normalizedSymbol}`
    };
  }

  const grossPnL =
    position.side === 'long'
      ? (exitPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - exitPrice) * position.quantity;

  const exitNotional = exitPrice * position.quantity;
  const exitCommission = exitNotional * COMMISSION_RATE;
  const realizedPnL = grossPnL - exitCommission;
  const totalCommission = position.entryCommission + exitCommission;

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

  balance += realizedPnL;
  positions.delete(normalizedSymbol);
  lastClosedTrades.set(normalizedSymbol, closedTrade);

  return {
    ok: true,
    balance,
    availableBalance: getAvailableBalance(),
    lastClosedTrade: closedTrade
  };
}
