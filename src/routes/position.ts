import { Router, Request } from 'express';
import { getCurrentPrice } from '../services/exchange';
import {
  closePosition,
  getAllPositions,
  getBalance,
  getLastClosedTrade,
  getPosition,
  openPosition
} from '../services/positionState';

const router = Router();

type OpenPositionBody = {
  symbol?: string;
  side?: 'long' | 'short';
  takeProfitPrice?: number;
  stopLossPrice?: number;
};

type CheckCloseBody = {
  symbol?: string;
};

type ClosePositionBody = {
  symbol?: string;
  reason?: 'take_profit' | 'stop_loss' | 'manual';
};

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    balance: getBalance(),
    positions: getAllPositions(),
    lastClosedTrade: getLastClosedTrade()
  });
});

router.get('/status/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').trim().toUpperCase();

  if (!symbol) {
    return res.status(400).json({
      ok: false,
      message: 'symbol is required'
    });
  }

  return res.json({
    ok: true,
    balance: getBalance(),
    position: getPosition(symbol),
    lastClosedTrade: getLastClosedTrade(symbol)
  });
});

router.get('/balance', (_req, res) => {
  res.json({
    ok: true,
    balance: getBalance()
  });
});

router.post('/open', async (req: Request<{}, any, OpenPositionBody>, res) => {
  try {
    const { symbol, side, takeProfitPrice, stopLossPrice } = req.body;

    const normalizedSymbol = String(symbol || '').trim().toUpperCase();

    if (!normalizedSymbol || !side || takeProfitPrice == null || stopLossPrice == null) {
      return res.status(400).json({
        ok: false,
        message: 'symbol, side, takeProfitPrice, stopLossPrice are required'
      });
    }

    const existingPosition = getPosition(normalizedSymbol);

    if (existingPosition) {
      return res.status(409).json({
        ok: false,
        message: `Position already open for ${normalizedSymbol}`,
        position: existingPosition
      });
    }

    const entryPrice = await getCurrentPrice(normalizedSymbol);

    const result = openPosition({
      symbol: normalizedSymbol,
      side,
      entryPrice,
      takeProfitPrice,
      stopLossPrice
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.post('/check-close', async (req: Request<{}, any, CheckCloseBody>, res) => {
  try {
    const normalizedSymbol = String(req.body.symbol || '').trim().toUpperCase();

    if (!normalizedSymbol) {
      return res.status(400).json({
        ok: false,
        message: 'symbol is required'
      });
    }

    const pos = getPosition(normalizedSymbol);

    if (!pos) {
      return res.json({
        ok: true,
        action: 'none',
        reason: 'no_position',
        symbol: normalizedSymbol
      });
    }

    const currentPrice = await getCurrentPrice(normalizedSymbol);

    const hitTakeProfit =
      pos.side === 'long'
        ? currentPrice >= pos.takeProfitPrice
        : currentPrice <= pos.takeProfitPrice;

    const hitStopLoss =
      pos.side === 'long'
        ? currentPrice <= pos.stopLossPrice
        : currentPrice >= pos.stopLossPrice;

    if (hitTakeProfit) {
      const result = closePosition(normalizedSymbol, currentPrice, 'take_profit');

      return res.json({
        ok: true,
        action: 'closed',
        reason: 'take_profit',
        symbol: normalizedSymbol,
        currentPrice,
        result
      });
    }

    if (hitStopLoss) {
      const result = closePosition(normalizedSymbol, currentPrice, 'stop_loss');

      return res.json({
        ok: true,
        action: 'closed',
        reason: 'stop_loss',
        symbol: normalizedSymbol,
        currentPrice,
        result
      });
    }

    return res.json({
      ok: true,
      action: 'hold',
      symbol: normalizedSymbol,
      currentPrice,
      position: pos
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.post('/close', async (req: Request<{}, any, ClosePositionBody>, res) => {
  try {
    const { reason } = req.body;
    const normalizedSymbol = String(req.body.symbol || '').trim().toUpperCase();

    if (!normalizedSymbol) {
      return res.status(400).json({
        ok: false,
        message: 'symbol is required'
      });
    }

    const pos = getPosition(normalizedSymbol);

    if (!pos) {
      return res.status(409).json({
        ok: false,
        message: `No open position for ${normalizedSymbol}`
      });
    }

    const exitPrice = await getCurrentPrice(normalizedSymbol);
    const result = closePosition(normalizedSymbol, exitPrice, reason || 'manual');

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
