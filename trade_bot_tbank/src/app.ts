// trade_bot_tbank/src/app.ts

import express from 'express';
import healthRouter from './routes/health';
import botRouter from './routes/bot';
import positionRouter from './routes/position';
import regimeRouter from './routes/regime';
import { startAutoBot, stopAutoBot, getAutoBotStatus } from './services/autoBot';

export const app = express();

app.use(express.json());
app.use('/health', healthRouter);
app.use('/bot', botRouter);
app.use('/position', positionRouter);
app.use('/market', regimeRouter);

// --- Автономный бот: управление ---
app.post('/auto/start', (_req, res) => {
  startAutoBot();
  res.json({ ok: true, message: 'Auto-bot started' });
});

app.post('/auto/stop', (_req, res) => {
  stopAutoBot();
  res.json({ ok: true, message: 'Auto-bot stopped' });
});

app.get('/auto/status', (_req, res) => {
  res.json(getAutoBotStatus());
});
