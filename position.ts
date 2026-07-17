import { Router } from 'express';
import { getCurrentPrice } from '../services/exchange';
import {
  closePosition,
  getBalance,
  getLastClosedTrade,
  getPosition,
  openPosition
} from '../services/positionState';

const router = Router();

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    balance: getBalance(),
    position: getPosition(),
    lastClosedTrade: getLastClosedTrade()
  });
});

router.get('/balance', (_req, res) => {
  res.json({
    ok: true,
    balance: getBalance()
  });
});

router.post('/open', async (req, res) => {
  try {
    const { symbol, side, takeProfitPrice, stopLossPrice } = req.body as {
      symbol?: string;
      side?: 'long' | 'short';
      takeProfitPrice?: number;
      stopLossPrice?: number;
    };

    if (!symbol || !side || takeProfitPrice == null || stopLossPrice == null) {
      return res.status(400).json({
        ok: false,
        message: 'symbol, side, takeProfitPrice, stopLossPrice are required'
      });
    }

    if (getPosition()) {
      return res.status(409).json({
        ok: false,
        message: 'Position already open',
        position: getPosition()
      });
    }

    const entryPrice = await getCurrentPrice(symbol);
    const result = openPosition({
      symbol,
      side,
      entryPrice,
      takeProfitPrice,
      stopLossPrice
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.get('/check-close', async (_req, res) => {
  try {
    const pos = getPosition();

    if (!pos) {
      return res.json({ ok: true, action: 'none', reason: 'no_position' });
    }

    const currentPrice = await getCurrentPrice(pos.symbol);

    const hitTakeProfit = pos.side === 'long'
      ? currentPrice >= pos.takeProfitPrice
      : currentPrice <= pos.takeProfitPrice;

    const hitStopLoss = pos.side === 'long'
      ? currentPrice <= pos.stopLossPrice
      : currentPrice >= pos.stopLossPrice;

    if (hitTakeProfit) {
      const result = closePosition(currentPrice, 'take_profit');
      return res.json({ ok: true, action: 'closed', reason: 'take_profit', currentPrice, result });
    }

    if (hitStopLoss) {
      const result = closePosition(currentPrice, 'stop_loss');
      return res.json({ ok: true, action: 'closed', reason: 'stop_loss', currentPrice, result });
    }

    return res.json({
      ok: true,
      action: 'hold',
      currentPrice,
      position: pos
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.post('/close', async (req, res) => {
  try {
    const { reason } = req.body as { reason?: 'take_profit' | 'stop_loss' | 'manual' };
    const pos = getPosition();

    if (!pos) {
      return res.status(409).json({ ok: false, message: 'No open position' });
    }

    const exitPrice = await getCurrentPrice(pos.symbol);
    const result = closePosition(exitPrice, reason || 'manual');

    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
