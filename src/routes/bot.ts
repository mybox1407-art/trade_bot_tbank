import { Router } from 'express';
import { runBotOnce } from '../services/botRunner';

const router = Router();

router.post('/run', async (req, res) => {
  try {
    const { symbol, timeframe } = req.body as { symbol?: string; timeframe?: string };

    if (!symbol) {
      return res.status(400).json({
        ok: false,
        message: 'symbol is required'
      });
    }

    const result = await runBotOnce(symbol, timeframe);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
