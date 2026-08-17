// trade_bot_tbank/src/services/autoBot.ts

import { getCandles, getCurrentPrice } from './exchange';
import { detectMarketState, computeCoherenceScore } from './marketState';
import { analyzeMarket, detectMarketRegime, Candle } from './strategy';
import {
  getPosition,
  getAllPositions,
  openPosition,
  closePosition,
  getAvailableBalance,
  getBalance,
  MAX_OPEN_POSITIONS,
  STARTING_BALANCE
} from './positionState';
import { logSignalCheck, logTrade } from './logger';
import axios from 'axios';

// ============================================================================
// КОНФИГУРАЦИЯ АВТОНОМНОГО БОТА
// ============================================================================
export const AUTO_BOT_CONFIG = {
  // Тикеры для торговли (MOEX, класс TQBR)
  symbols: ['TATN', 'GAZP', 'NVTK'] as const,
  timeframe: '15m' as const,
  candlesLimit: 250,

  // Режимный цикл: каждые 15 минут
  regimeCheckIntervalMs: 15 * 60 * 1000,

  // Мониторинг позиций: каждые 15 секунд
  positionMonitorIntervalMs: 15 * 1000,

  // Риск-менеджмент
  maxPositions: MAX_OPEN_POSITIONS,           // 3
  positionSizeFraction: 0.30,                 // 30% баланса на сделку
  startingBalance: STARTING_BALANCE,          // 50000

  // Фильтр режима рынка: какие состояния разрешают вход
  allowedMarketStates: ['resonant', 'transition'] as const,

  // HTF-фильтр (1h) — включен по умолчанию
  htfFilterEnabled: true,
  htfMinAdx1h: 18,

  // Тайм-аут входа: если сигнал не исполнился N баров — отменяем
  entryTimeoutBars: 4,

  // Логирование
  logSignals: true,
  logTrades: true,

  // Telegram
  telegramEnabled: true,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || ''
} as const;

type Symbol = typeof AUTO_BOT_CONFIG.symbols[number];

// ============================================================================
// СОСТОЯНИЕ БОТА
// ============================================================================
interface PendingSignal {
  symbol: Symbol;
  side: 'long' | 'short';
  entryPrice: number;
  stopLossPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  quantity: number;
  positionSize: number;
  regime: string;
  initialR: number;
  signalTime: number;
  barsWaited: number;
}

const pendingSignals = new Map<Symbol, PendingSignal>();
let isRegimeCheckRunning = false;
let isPositionMonitorRunning = false;

// ============================================================================
// УТИЛИТЫ
// ============================================================================
function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

function nowMs() {
  return Date.now();
}

function formatTime(ts: number) {
  return new Date(ts).toISOString();
}

function formatMoney(value: number) {
  return value.toFixed(2);
}

function log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) {
  const line = `[${formatTime(nowMs())}] [AUTO-BOT] [${level.toUpperCase()}] ${msg}`;
  if (meta) console.log(line, meta);
  else console.log(line);
}

// ============================================================================
// TELEGRAM
// ============================================================================
async function sendTelegramMessage(message: string) {
  if (!AUTO_BOT_CONFIG.telegramEnabled) return;
  if (!AUTO_BOT_CONFIG.telegramBotToken || !AUTO_BOT_CONFIG.telegramChatId) {
    log('warn', 'Telegram not configured: missing token or chatId');
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${AUTO_BOT_CONFIG.telegramBotToken}/sendMessage`;
    await axios.post(url, {
      chat_id: AUTO_BOT_CONFIG.telegramChatId,
      text: message
    });
  } catch (err) {
    log('error', 'Telegram send failed', {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function sendTelegramTestMessage() {
  const message = `
[TEST] Автономный торговый бот MOEX

Статус: OK
Время: ${formatTime(nowMs())}
Баланс: ${formatMoney(getBalance())} руб
Свободно: ${formatMoney(getAvailableBalance())} руб
Открыто позиций: ${getAllPositions().length}

Тикеры: TATN, GAZP, NVTK
Режим: 15m свечи, проверка каждые 15 мин
Мониторинг: каждые 15 сек

Telegram подключён и работает.
`.trim();

  await sendTelegramMessage(message);
  log('info', 'Telegram test message sent');
}

function formatOpenPositionMessage(
  symbol: string,
  side: 'long' | 'short',
  entryPrice: number,
  quantity: number,
  positionSize: number,
  stopLoss: number,
  takeProfit: number,
  balanceBefore: number,
  balanceAfter: number,
  regime: string,
  initialR: number
) {
  const sideText = side === 'long' ? 'LONG' : 'SHORT';

  return `
[ОТКРЫТИЕ ПОЗИЦИИ] ${sideText}

Тикер: ${symbol}
Цена входа: ${formatMoney(entryPrice)} руб
Количество: ${quantity} шт
Объём позиции: ${formatMoney(positionSize)} руб
Stop Loss: ${formatMoney(stopLoss)} руб
Take Profit: ${formatMoney(takeProfit)} руб
Риск (R): ${formatMoney(initialR)} руб

Баланс до: ${formatMoney(balanceBefore)} руб
Баланс после: ${formatMoney(balanceAfter)} руб
Свободно: ${formatMoney(getAvailableBalance())} руб

Режим рынка: ${regime}
Время: ${formatTime(nowMs())}
`.trim();
}

function formatClosePositionMessage(
  symbol: string,
  side: 'long' | 'short',
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  realizedPnL: number,
  reason: 'take_profit' | 'stop_loss' | 'manual',
  balanceBefore: number,
  balanceAfter: number,
  totalCommission: number
) {
  const sideText = side === 'long' ? 'LONG' : 'SHORT';
  const pnlSign = realizedPnL >= 0 ? '+' : '';
  const reasonText = reason === 'take_profit' ? 'TAKE PROFIT' : reason === 'stop_loss' ? 'STOP LOSS' : 'MANUAL';
  const pnlPercent = ((realizedPnL / balanceBefore) * 100).toFixed(2);

  return `
[ЗАКРЫТИЕ ПОЗИЦИИ] ${sideText}

Тикер: ${symbol}
Цена входа: ${formatMoney(entryPrice)} руб
Цена выхода: ${formatMoney(exitPrice)} руб
Количество: ${quantity} шт
PNL: ${pnlSign}${formatMoney(realizedPnL)} руб (${pnlSign}${pnlPercent}%)
Комиссии: ${formatMoney(totalCommission)} руб

Баланс до: ${formatMoney(balanceBefore)} руб
Баланс после: ${formatMoney(balanceAfter)} руб
Изменение: ${pnlSign}${formatMoney(realizedPnL)} руб

Причина: ${reasonText}
Время: ${formatTime(nowMs())}
`.trim();
}

// ============================================================================
// 1. РЕЖИМНЫЙ ЦИКЛ (каждые 15 мин)
// ============================================================================
export async function runRegimeCheckCycle() {
  if (isRegimeCheckRunning) {
    log('warn', 'Regime check already running, skipping');
    return;
  }
  isRegimeCheckRunning = true;

  try {
    log('info', '=== REGIME CHECK CYCLE START ===');

    const openPositions = getAllPositions();
    const openSymbols = new Set(openPositions.map(p => p.symbol));
    const availableBalance = getAvailableBalance();
    const totalBalance = getBalance();

    log('info', 'Portfolio state', {
      balance: totalBalance,
      availableBalance,
      openPositions: openPositions.length,
      openSymbols: [...openSymbols],
      maxPositions: AUTO_BOT_CONFIG.maxPositions
    });

    if (openPositions.length >= AUTO_BOT_CONFIG.maxPositions) {
      log('info', 'Max positions reached, skipping signal search');
      return;
    }

    for (const symbol of AUTO_BOT_CONFIG.symbols) {
      if (openSymbols.has(symbol)) {
        log('info', `Skipping ${symbol}: position already open`);
        continue;
      }

      if (pendingSignals.has(symbol)) {
        const pending = pendingSignals.get(symbol)!;
        pending.barsWaited += 1;
        if (pending.barsWaited >= AUTO_BOT_CONFIG.entryTimeoutBars) {
          log('info', `Signal expired for ${symbol} after ${pending.barsWaited} bars`);
          pendingSignals.delete(symbol);
        } else {
          log('info', `Pending signal for ${symbol} waiting (bar ${pending.barsWaited}/${AUTO_BOT_CONFIG.entryTimeoutBars})`);
        }
        continue;
      }

      try {
        await processSymbol(symbol, availableBalance);
      } catch (err) {
        log('error', `Error processing ${symbol}`, { error: err instanceof Error ? err.message : String(err) });
        await sleep(500);
      }
    }

    log('info', '=== REGIME CHECK CYCLE END ===');
  } finally {
    isRegimeCheckRunning = false;
  }
}

async function processSymbol(symbol: Symbol, availableBalance: number) {
  log('info', `Processing ${symbol}...`);

  const candles = await getCandles(symbol, AUTO_BOT_CONFIG.timeframe, AUTO_BOT_CONFIG.candlesLimit);
  if (candles.length < 220) {
    log('warn', `${symbol}: not enough candles (${candles.length}/220)`);
    return;
  }

  const marketState = detectMarketState(candles);
  if (!marketState.ready) {
    log('warn', `${symbol}: market state not ready`);
    return;
  }

  log('info', `${symbol} market state`, {
    state: marketState.state,
    sideBias: marketState.sideBias,
    coherence: marketState.coherence.toFixed(4),
    trendScore: marketState.trendScore.toFixed(4),
    noiseScore: marketState.noiseScore.toFixed(4)
  });

  if (marketState.state === 'chaotic') {
    log('info', `${symbol}: state=chaotic, skipping`);
    return;
  }

  const signal = analyzeMarket(candles, availableBalance, {
    enabled: AUTO_BOT_CONFIG.htfFilterEnabled,
    minAdx1h: AUTO_BOT_CONFIG.htfMinAdx1h
  });

  if (!signal.buy && !signal.sell) {
    log('info', `${symbol}: no signal`, {
      regime: signal.regime,
      reject: signal.indicators?.reject,
      lastRsi: signal.indicators?.lastRsi
    });
    return;
  }

  const side = signal.side;
  if (side === 'none') {
    log('warn', `${symbol}: signal side=none but buy/sell set?`);
    return;
  }

  if (marketState.sideBias !== 'neutral' && marketState.sideBias !== side) {
    log('info', `${symbol}: signal ${side} conflicts with market bias ${marketState.sideBias}, skipping`);
    return;
  }

  const coherence = computeCoherenceScore(candles, side);
  if (coherence < 0.4) {
    log('info', `${symbol}: low coherence ${coherence.toFixed(4)} for ${side}, skipping`);
    return;
  }

  if (!signal.stopLossPrice || !signal.takeProfit1Price || !signal.takeProfit2Price || !signal.quantity) {
    log('warn', `${symbol}: incomplete signal data`, signal);
    return;
  }

  const pending: PendingSignal = {
    symbol,
    side,
    entryPrice: signal.price,
    stopLossPrice: signal.stopLossPrice,
    takeProfit1Price: signal.takeProfit1Price,
    takeProfit2Price: signal.takeProfit2Price,
    quantity: signal.quantity,
    positionSize: signal.positionSize ?? signal.quantity * signal.price,
    regime: signal.regime,
    initialR: signal.initialR ?? 0,
    signalTime: nowMs(),
    barsWaited: 0
  };

  pendingSignals.set(symbol, pending);

  if (AUTO_BOT_CONFIG.logSignals) {
    logSignalCheck({
      timestamp: formatTime(nowMs()),
      symbol,
      side,
      regime: signal.regime,
      marketState: marketState.state,
      sideBias: marketState.sideBias,
      coherence: coherence.toFixed(6),
      entryPrice: signal.price,
      stopLoss: signal.stopLossPrice,
      tp1: signal.takeProfit1Price,
      tp2: signal.takeProfit2Price,
      quantity: signal.quantity,
      positionSize: pending.positionSize,
      initialR: (signal.initialR ?? 0).toFixed(4),
      action: 'signal_generated'
    } as Record<string, string | number | boolean | null>);
  }

  log('info', `SIGNAL GENERATED: ${symbol} ${side.toUpperCase()}`, {
    entry: signal.price,
    sl: signal.stopLossPrice,
    tp1: signal.takeProfit1Price,
    tp2: signal.takeProfit2Price,
    qty: signal.quantity,
    size: pending.positionSize,
    R: signal.initialR?.toFixed(4)
  });

  await tryExecutePendingSignal(symbol);
}

async function tryExecutePendingSignal(symbol: Symbol) {
  const pending = pendingSignals.get(symbol);
  if (!pending) return;

  try {
    const currentPrice = await getCurrentPrice(symbol);
    const balanceBefore = getBalance();

    const slippageTolerance = 0.001;
    const priceDiff = Math.abs(currentPrice - pending.entryPrice) / pending.entryPrice;

    if (priceDiff > slippageTolerance) {
      log('info', `${symbol}: price moved too far (${(priceDiff * 100).toFixed(2)}%), waiting`);
      return;
    }

    const result = openPosition({
      symbol: pending.symbol,
      side: pending.side,
      entryPrice: currentPrice,
      takeProfitPrice: pending.takeProfit1Price,
      stopLossPrice: pending.stopLossPrice,
      quantity: pending.quantity
    });

    if (result.ok) {
      pendingSignals.delete(symbol);

      const balanceAfter = getBalance();

      if (AUTO_BOT_CONFIG.logTrades) {
        logTrade({
          timestamp: formatTime(nowMs()),
          symbol: pending.symbol,
          side: pending.side,
          action: 'open',
          entryPrice: currentPrice,
          stopLoss: pending.stopLossPrice,
          takeProfit: pending.takeProfit1Price,
          quantity: pending.quantity,
          positionSize: pending.positionSize,
          regime: pending.regime,
          initialR: (pending.initialR ?? 0).toFixed(4),
          balanceBefore,
          balanceAfter,
          availableBalance: result.availableBalance ?? 0
        } as Record<string, string | number | boolean | null>);
      }

      log('info', `POSITION OPENED: ${symbol} ${pending.side.toUpperCase()}`, {
        entryPrice: currentPrice,
        quantity: pending.quantity,
        balance: result.balance
      });

      // Telegram
      const tgMessage = formatOpenPositionMessage(
        pending.symbol,
        pending.side,
        currentPrice,
        pending.quantity,
        pending.positionSize,
        pending.stopLossPrice,
        pending.takeProfit1Price,
        balanceBefore,
        balanceAfter,
        pending.regime,
        pending.initialR
      );
      await sendTelegramMessage(tgMessage);
    } else {
      log('warn', `Failed to open position for ${symbol}`, { message: result.message });
    }
  } catch (err) {
    log('error', `Error executing signal for ${symbol}`, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ============================================================================
// 2. МОНИТОРИНГ ПОЗИЦИЙ (каждые 15 сек)
// ============================================================================
export async function runPositionMonitorCycle() {
  if (isPositionMonitorRunning) return;
  isPositionMonitorRunning = true;

  try {
    const positions = getAllPositions();
    if (positions.length === 0) return;

    for (const pos of positions) {
      try {
        const currentPrice = await getCurrentPrice(pos.symbol);

        const hitTakeProfit =
          pos.side === 'long'
            ? currentPrice >= pos.takeProfitPrice
            : currentPrice <= pos.takeProfitPrice;

        const hitStopLoss =
          pos.side === 'long'
            ? currentPrice <= pos.stopLossPrice
            : currentPrice >= pos.stopLossPrice;

        if (hitTakeProfit || hitStopLoss) {
          const balanceBefore = getBalance();
          const reason = hitTakeProfit ? 'take_profit' : 'stop_loss';
          const result = closePosition(pos.symbol, currentPrice, reason);

          if (result.ok) {
            const balanceAfter = getBalance();
            const closedTrade = result.lastClosedTrade;

            if (AUTO_BOT_CONFIG.logTrades && closedTrade) {
              logTrade({
                timestamp: formatTime(nowMs()),
                symbol: pos.symbol,
                side: pos.side,
                action: 'close',
                entryPrice: pos.entryPrice,
                exitPrice: currentPrice,
                stopLoss: pos.stopLossPrice,
                takeProfit: pos.takeProfitPrice,
                quantity: pos.quantity,
                realizedPnL: closedTrade.realizedPnL,
                reason,
                balanceBefore,
                balanceAfter,
                totalCommission: closedTrade.totalCommission
              } as Record<string, string | number | boolean | null>);
            }

            log('info', `POSITION CLOSED: ${pos.symbol} ${pos.side.toUpperCase()} @ ${currentPrice} (${reason.toUpperCase()})`, {
              pnl: closedTrade?.realizedPnL?.toFixed(2),
              balance: result.balance
            });

            // Telegram
            if (closedTrade) {
              const tgMessage = formatClosePositionMessage(
                pos.symbol,
                pos.side,
                pos.entryPrice,
                currentPrice,
                pos.quantity,
                closedTrade.realizedPnL,
                reason,
                balanceBefore,
                balanceAfter,
                closedTrade.totalCommission
              );
              await sendTelegramMessage(tgMessage);
            }
          }
        }
      } catch (err) {
        log('error', `Monitor error for ${pos.symbol}`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    isPositionMonitorRunning = false;
  }
}

// ============================================================================
// 3. ЗАПУСК/ОСТАНОВКА БОТА
// ============================================================================
let regimeInterval: NodeJS.Timeout | null = null;
let monitorInterval: NodeJS.Timeout | null = null;

export async function startAutoBot() {
  log('info', 'Starting auto-bot...', { config: AUTO_BOT_CONFIG });

  // Тестовое сообщение в Telegram при старте
  if (AUTO_BOT_CONFIG.telegramEnabled) {
    await sendTelegramTestMessage();
  }

  runRegimeCheckCycle().catch(err => log('error', 'Initial regime check failed', { error: err.message }));

  regimeInterval = setInterval(() => {
    runRegimeCheckCycle().catch(err => log('error', 'Regime cycle error', { error: err.message }));
  }, AUTO_BOT_CONFIG.regimeCheckIntervalMs);

  monitorInterval = setInterval(() => {
    runPositionMonitorCycle().catch(err => log('error', 'Monitor cycle error', { error: err.message }));
  }, AUTO_BOT_CONFIG.positionMonitorIntervalMs);

  log('info', 'Auto-bot started');
}

export function stopAutoBot() {
  if (regimeInterval) clearInterval(regimeInterval);
  if (monitorInterval) clearInterval(monitorInterval);
  regimeInterval = null;
  monitorInterval = null;
  log('info', 'Auto-bot stopped');
}

// ============================================================================
// 4. HTTP ЭНДПОИНТЫ ДЛЯ УПРАВЛЕНИЯ
// ============================================================================
export function getAutoBotStatus() {
  return {
    running: !!regimeInterval,
    config: AUTO_BOT_CONFIG,
    openPositions: getAllPositions().map(p => ({
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      quantity: p.quantity,
      notional: p.notional,
      takeProfitPrice: p.takeProfitPrice,
      stopLossPrice: p.stopLossPrice,
      openedAt: p.openedAt,
      unrealizedPnL: 0
    })),
    pendingSignals: Array.from(pendingSignals.entries()).map(([sym, s]) => ({
      symbol: sym,
      side: s.side,
      entryPrice: s.entryPrice,
      barsWaited: s.barsWaited
    })),
    balance: getBalance(),
    availableBalance: getAvailableBalance()
  };
}
