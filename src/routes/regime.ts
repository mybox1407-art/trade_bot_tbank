import { Router } from 'express';
import { getCandles } from '../services/exchange';
import { detectMarketRegime } from '../services/strategy';

const router = Router();

router.post('/regime', async (req, res) => {
  try {
    const { symbol, timeframe = '15m' } = req.body as {
      symbol?: string;
      timeframe?: string;
    };

    if (!symbol) {
      return res.status(400).json({ ok: false, error: 'symbol is required' });
    }

    const candles = await getCandles(symbol, timeframe, 250);

    if (candles.length < 200) {
      return res.status(200).json({
        symbol,
        timeframe,
        ready: false,
        reason: 'not_enough_candles',
        candlesReceived: candles.length,
        candlesRequired: 200
      });
    }

    const result = detectMarketRegime(candles);

    return res.json({
      symbol,
      timeframe,
      candlesReceived: candles.length,
      ...result
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'unknown_error'
    });
  }
});

export default router;
