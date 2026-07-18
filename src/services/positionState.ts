export interface VirtualPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  notional: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  openedAt: string;
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
}

const STARTING_BALANCE = 50000;
const POSITION_PERCENT = 0.10;
const COMMISSION_RATE = 0.003; // 0.3% за сделку, тариф "Инвестор"

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

export function getPositionNotional() {
  return balance * POSITION_PERCENT;
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

  let quantity: number;
  let notional: number;

  if (data.quantity != null && data.quantity > 0) {
    quantity = data.quantity;
    notional = quantity * data.entryPrice;
  } else if (data.positionSize != null && data.positionSize > 0) {
    notional = data.positionSize;
    quantity = notional / data.entryPrice;
  } else {
    notional = getPositionNotional();
    quantity = notional / data.entryPrice;
  }

  const position: VirtualPosition = {
    symbol,
    side: data.side,
    entryPrice: data.entryPrice,
    quantity,
    notional,
    takeProfitPrice: data.takeProfitPrice,
    stopLossPrice: data.stopLossPrice,
    openedAt: new Date().toISOString()
  };

  positions.set(symbol, position);

  return {
    ok: true,
    balance,
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

  const entryCommission = position.notional * COMMISSION_RATE;
  const exitNotional = exitPrice * position.quantity;
  const exitCommission = exitNotional * COMMISSION_RATE;
  const totalCommission = entryCommission + exitCommission;

  const realizedPnL = grossPnL - totalCommission;

  const closedTrade: ClosedTrade = {
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity,
    notional: position.notional,
    realizedPnL,
    closedAt: new Date().toISOString(),
    reason
  };

  balance += realizedPnL;
  positions.delete(normalizedSymbol);
  lastClosedTrades.set(normalizedSymbol, closedTrade);

  return {
    ok: true,
    balance,
    lastClosedTrade: closedTrade
  };
}
