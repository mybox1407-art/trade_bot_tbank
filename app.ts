import express from 'express';
import healthRouter from './routes/health';
import botRouter from './routes/bot';
import positionRouter from './routes/position';
import regimeRouter from './routes/regime';

export const app = express();

app.use(express.json());
app.use('/health', healthRouter);
app.use('/bot', botRouter);
app.use('/position', positionRouter);
app.use('/market', regimeRouter);
