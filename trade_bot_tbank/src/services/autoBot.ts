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
  // Для breakout-стратегии нужен regime 'breakout_watch' в strategy.ts
  // но marketState.ts даёт 'resonant'/'transition'/'chaotic'.
  // Будем требовать: marketState.state !== 'chaotic' И sideBias совпадает с сигналом.

  // HTF-фильтр (1h) — включен по умолчанию
  htfFilterEnabled: true,
  htfMinAdx1h: 18,

  // Тайм-аут входа: если сигнал не исполнился N баров — отменяем
  entryTimeoutBars: 4,

  // Логирование
  logSignals: true,
  logTrades: true
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
  signalTime: number;           // timestamp свечи, на которой пришел сигнал
  barsWaited: number;           // сколько баров ждем исполнения
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

function log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) {
  const line = `[${formatTime(nowMs())}] [AUTO-BOT] [${level.toUpperCase()}] ${msg}`;
  if (meta) console.log(line, meta);
  else console.log(line);
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

    log('info', 'Portfolio state', {
      balance: getBalance(),
      availableBalance,
      openPositions: openPositions.length,
      openSymbols: [...openSymbols],
      maxPositions: AUTO_BOT_CONFIG.maxPositions
    });

    // Если уже 3 позиции — новых не открываем, только мониторим
    if (openPositions.length >= AUTO_BOT_CONFIG.maxPositions) {
      log('info', 'Max positions reached, skipping signal search');
      return;
    }

    // Проверяем каждый тикер
    for (const symbol of AUTO_BOT_CONFIG.symbols) {
      if (openSymbols.has(symbol)) {
        log('info', `Skipping ${symbol}: position already open`);
        continue;
      }

      // Проверяем, есть ли уже ожидающий сигнал по этому тикеру
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
        // Небольшая пауза перед следующим тикером, чтобы не спамить API
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

  // 1. Получаем свечи
  const candles = await getCandles(symbol, AUTO_BOT_CONFIG.timeframe, AUTO_BOT_CONFIG.candlesLimit);
  if (candles.length < 220) {
    log('warn', `${symbol}: not enough candles (${candles.length}/220)`);
    return;
  }

  // 2. Проверяем режим рынка (marketState.ts — resonant/transition/chaotic)
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

  // Фильтр: не торгуем в chaotic
  if (marketState.state === 'chaotic') {
    log('info', `${symbol}: state=chaotic, skipping`);
    return;
  }

  // 3. Получаем торговый сигнал (strategy.ts — только breakout)
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

  // 4. Проверяем согласованность с marketState.sideBias
  if (marketState.sideBias !== 'neutral' && marketState.sideBias !== side) {
    log('info', `${symbol}: signal ${side} conflicts with market bias ${marketState.sideBias}, skipping`);
    return;
  }

  // 5. Проверяем когерентность (computeCoherenceScore)
  const coherence = computeCoherenceScore(candles, side);
  if (coherence < 0.4) { // порог можно вынести в конфиг
    log('info', `${symbol}: low coherence ${coherence.toFixed(4)} for ${side}, skipping`);
    return;
  }

  // 6. Валидация стопа/тейков
  if (!signal.stopLossPrice || !signal.takeProfit1Price || !signal.takeProfit2Price || !signal.quantity) {
    log('warn', `${symbol}: incomplete signal data`, signal);
    return;
  }

  // 7. Сохраняем pending-сигнал (исполним на следующем мониторинге или сразу)
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
      initialR: signal.initialR?.toFixed(4) ?? '0',
      action: 'signal_generated'
    });
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

  // Пытаемся открыть сразу по текущей цене (market-like)
  await tryExecutePendingSignal(symbol);
}

// Попытка исполнить pending-сигнал по текущей рыночной цене
async function tryExecutePendingSignal(symbol: Symbol) {
  const pending = pendingSignals.get(symbol);
  if (!pending) return;

  try {
    const currentPrice = await getCurrentPrice(symbol);

    // Для лонга: входим, если цена <= entryPrice + small slippage
    // Для шорта: цена >= entryPrice - slippage
    // Упрощение: входим по текущей цене, пересчитываем стоп/тейпы относительно текущей
    // Но стратегия уже дала точные уровни — лучше открыть по signal.price через лимитку.
    // Здесь используем market-подход: открываем по текущей цене, если она близко к сигнальной.

    const slippageTolerance = 0.001; // 0.1%
    const priceDiff = Math.abs(currentPrice - pending.entryPrice) / pending.entryPrice;

    if (priceDiff > slippageTolerance) {
      log('info', `${symbol}: price moved too far (${(priceDiff * 100).toFixed(2)}%), waiting for next bar`);
      return;
    }

    // Открываем позицию через positionState.openPosition
    const result = openPosition({
      symbol: pending.symbol,
      side: pending.side,
      entryPrice: currentPrice, // исполняем по текущей цене
      takeProfitPrice: pending.takeProfit1Price, // используем TP1 как основной тейк (частичное закрытие не реализовано в positionState)
      stopLossPrice: pending.stopLossPrice,
      quantity: pending.quantity
    });

    if (result.ok) {
      pendingSignals.delete(symbol);

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
          initialR: pending.initialR?.toFixed(4) ?? '0',
          balance: result.balance,
          availableBalance: result.availableBalance
        });
      }

      log('info', `POSITION OPENED: ${symbol} ${pending.side.toUpperCase()}`, {
        entryPrice: currentPrice,
        quantity: pending.quantity,
        balance: result.balance
      });
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

        // Проверяем TP/SL
        const hitTakeProfit =
          pos.side === 'long'
            ? currentPrice >= pos.takeProfitPrice
            : currentPrice <= pos.takeProfitPrice;

        const hitStopLoss =
          pos.side === 'long'
            ? currentPrice <= pos.stopLossPrice
            : currentPrice >= pos.stopLossPrice;

        if (hitTakeProfit) {
          const result = closePosition(pos.symbol, currentPrice, 'take_profit');
          logTradeClose(pos, currentPrice, 'take_profit', result);
        } else if (hitStopLoss) {
          const result = closePosition(pos.symbol, currentPrice, 'stop_loss');
          logTradeClose(pos, currentPrice, 'stop_loss', result);
        } else {
          // Ходл — можно логировать каждые N циклов, чтобы не спамить
          // log('debug', `HOLD ${pos.symbol} ${pos.side} @ ${currentPrice}`);
        }
      } catch (err) {
        log('error', `Monitor error for ${pos.symbol}`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    isPositionMonitorRunning = false;
  }
}

function logTradeClose(pos: any, exitPrice: number, reason: 'take_profit' | 'stop_loss', result: any) {
  if (AUTO_BOT_CONFIG.logTrades) {
    logTrade({
      timestamp: formatTime(nowMs()),
      symbol: pos.symbol,
      side: pos.side,
      action: 'close',
      entryPrice: pos.entryPrice,
      exitPrice,
      stopLoss: pos.stopLossPrice,
      takeProfit: pos.takeProfitPrice,
      quantity: pos.quantity,
      realizedPnL: result.lastClosedTrade?.realizedPnL ?? 0,
      reason,
      balance: result.balance,
      totalCommission: result.lastClosedTrade?.totalCommission ?? 0
    });
  }

  log('info', `POSITION CLOSED: ${pos.symbol} ${pos.side.toUpperCase()} @ ${exitPrice} (${reason.toUpperCase()})`, {
    pnl: result.lastClosedTrade?.realizedPnL?.toFixed(2),
    balance: result.balance
  });
}

// ============================================================================
// 3. ЗАПУСК/ОСТАНОВКА БОТА
// ============================================================================
let regimeInterval: NodeJS.Timeout | null = null;
let monitorInterval: NodeJS.Timeout | null = null;

export function startAutoBot() {
  log('info', 'Starting auto-bot...', { config: AUTO_BOT_CONFIG });

  // Сразу запускаем один цикл режима
  runRegimeCheckCycle().catch(err => log('error', 'Initial regime check failed', { error: err.message }));

  // Режимный цикл каждые 15 мин
  regimeInterval = setInterval(() => {
    runRegimeCheckCycle().catch(err => log('error', 'Regime cycle error', { error: err.message }));
  }, AUTO_BOT_CONFIG.regimeCheckIntervalMs);

  // Мониторинг позиций каждые 15 сек
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
// 4. HTTP ЭНДПОИНТЫ ДЛЯ УПРАВЛЕНИЯ (опционально, для админки)
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
      unrealizedPnL: 0 // можно добавить расчет по текущей цене
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
