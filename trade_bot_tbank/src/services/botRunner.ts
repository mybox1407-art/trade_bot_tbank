// trade_bot_tbank/src/services/botRunner.ts

import { getCandles } from './exchange';
import { analyzeMarket } from './strategy';
import { getAvailableBalance, getPosition } from './positionState';
import { logSignalCheck } from './logger';

export async function runBotOnce(symbol: string, timeframe = '15m') {
  const candles = await getCandles(symbol, timeframe, 250);

  if (candles.length < 200) {
    return { symbol, timeframe, ready: false, reason: 'not_enough_candles' };
  }

  const existingPosition = getPosition(symbol);
  if (existingPosition) {
    return {
      symbol,
      timeframe,
      ready: true,
      skipped: true,
      reason: 'position_already_open',
      position: existingPosition
    };
  }

  const availableBalance = getAvailableBalance();
  const result = analyzeMarket(candles, availableBalance);

  // Логирование сигнала (если есть сигнал)
  if ((result.buy || result.sell) && result.indicators?.ready) {
    logSignalCheck({
      timestamp: new Date().toISOString(),
      symbol,
      side: result.side,
      regime: result.regime,
      entryPrice: result.price,
      stopLoss: result.stopLossPrice,
      tp1: result.takeProfit1Price,
      tp2: result.takeProfit2Price,
      quantity: result.quantity,
      positionSize: result.positionSize,
      initialR: (result.initialR ?? 0).toFixed(4),
      action: 'signal_generated'
    } as Record<string, string | number | boolean | null>);
  }

  return {
    symbol,
    timeframe,
    ready: true,
    balanceForSizing: availableBalance,
    ...result
  };
}
