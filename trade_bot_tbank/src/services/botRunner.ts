import { getCandles } from './exchange';
import { analyzeMarket, detectMarketRegime } from './strategy';
import { getAvailableBalance, getPosition } from './positionState';

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

  return {
    symbol,
    timeframe,
    ready: true,
    balanceForSizing: availableBalance,
    ...result
  };
}

export async function getMarketRegimeOnce(symbol: string, timeframe = '15m') {
  const candles = await getCandles(symbol, timeframe, 250);

  if (candles.length < 200) {
    return { symbol, timeframe, ready: false, reason: 'not_enough_candles' };
  }

  return { symbol, timeframe, ...detectMarketRegime(candles) };
}
