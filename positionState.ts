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

const STARTING_BALANCE = 500;
const POSITION_PERCENT = 0.10;

let balance = STARTING_BALANCE;
let currentPosition: VirtualPosition | null = null;
let lastClosedTrade: ClosedTrade | null = null;

export function getBalance() {
  return balance;
}

export function getPosition() {
  return currentPosition;
}

export function getLastClosedTrade() {
  return lastClosedTrade;
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
}) {
  if (currentPosition) {
    return { ok: false, message: 'Position already open', position: currentPosition };
  }

  const notional = getPositionNotional();
  const quantity = notional / data.entryPrice;

  currentPosition = {
    symbol: data.symbol,
    side: data.side,
    entryPrice: data.entryPrice,
    quantity,
    notional,
    takeProfitPrice: data.takeProfitPrice,
    stopLossPrice: data.stopLossPrice,
    openedAt: new Date().toISOString()
  };

  return { ok: true, balance, position: currentPosition };
}

export function closePosition(exitPrice: number, reason: 'take_profit' | 'stop_loss' | 'manual') {
  if (!currentPosition) {
    return { ok: false, message: 'No open position' };
  }

  const realizedPnL = currentPosition.side === 'long'
    ? (exitPrice - currentPosition.entryPrice) * currentPosition.quantity
    : (currentPosition.entryPrice - exitPrice) * currentPosition.quantity;

  lastClosedTrade = {
    symbol: currentPosition.symbol,
    side: currentPosition.side,
    entryPrice: currentPosition.entryPrice,
    exitPrice,
    quantity: currentPosition.quantity,
    notional: currentPosition.notional,
    realizedPnL,
    closedAt: new Date().toISOString(),
    reason
  };

  balance = balance + realizedPnL;
  currentPosition = null;

  return { ok: true, balance, lastClosedTrade };
}
