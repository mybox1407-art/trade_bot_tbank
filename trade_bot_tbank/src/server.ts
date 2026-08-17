// trade_bot_tbank/src/server.ts

import { app } from './app';
import { startAutoBot } from './services/autoBot';

const port = Number(process.env.PORT) || 3011;

app.listen(port, '0.0.0.0', async () => {
  console.log(`Server started on port ${port}`);

  // Автозапуск бота при старте сервера (всегда)
  console.log('[AUTO-BOT] Starting...');
  await startAutoBot();
});
