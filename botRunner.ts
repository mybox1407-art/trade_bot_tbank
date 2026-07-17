import { getCandles } from './exchange';
import { analyzeMarket, detectMarketRegime } from './strategy';

export async function runBotOnce(symbol = 'BTC/USDT', timeframe = '15m') {
  const candles = await getCandles(symbol, timeframe, 250);

  if (candles.length < 200) {
    return { symbol, timeframe, ready: false, reason: 'not_enough_candles' };
  }

  const result = analyzeMarket(candles);
  return { symbol, timeframe, ready: true, ...result };
}

export async function getMarketRegimeOnce(symbol = 'BTC/USDT', timeframe = '15m') {
  const candles = await getCandles(symbol, timeframe, 250);

  if (candles.length < 200) {
    return { symbol, timeframe, ready: false, reason: 'not_enough_candles' };
  }

  return { symbol, timeframe, ...detectMarketRegime(candles) };
}
