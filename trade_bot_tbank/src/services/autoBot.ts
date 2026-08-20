// trade_bot_tbank/src/services/autoBot.ts
//
// === Изменения 20.08.2026 ===
// 1) candlesLimit: после getCandles применяется trimCandles() — жёсткий slice(-limit),
//    индикаторы всегда получают ровно candlesLimit / htfCandlesLimit свечей.
// 2) Привязка к закрытию бара: setInterval заменён на самоперепланирующийся setTimeout,
//    цикл запускается через barCloseDelaySec после закрытия 15m-бара.
//    dropFormingCandle отбрасывает незакрытую (формирующуюся) свечу.
// 3) Торговое окно: вне 10:01–23:45 МСК (пн–пт) цикл завершается ДО запросов к API,
//    планировщик спит до открытия сессии (cap maxSleepMs как страховка).
// 4) telegramBotToken замаскирован в стартовом логе и в getAutoBotStatus().

import { getCandles, getCurrentPrice } from './exchange';
import { detectMarketState, computeCoherenceScore } from './marketState';
import { analyzeMarket, detectMarketRegime, Candle, buildHtfBiasSeries } from './strategy';
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

export const AUTO_BOT_CONFIG = {
  symbols: ['TATN', 'GAZP', 'NVTK'] as const,
  timeframe: '15m' as const,
  candlesLimit: 250,
  htfCandlesLimit: 300,                          // NEW: лимит для 1h (был захардкожен 300)
  regimeCheckIntervalMs: 15 * 60 * 1000,         // оставлено для справки; планировщик привязан к закрытию бара
  barCloseDelaySec: 10,                          // NEW: пауза после закрытия бара перед циклом
  dropFormingCandle: true,                       // NEW: отбрасывать незакрытую свечу
  tradingHoursEnabled: true,                     // NEW: не дёргать API вне торгового окна
  tradingWindows: [[10 * 60 + 1, 23 * 60 + 45]] as const, // NEW: 10:01–23:45 МСК
  maxSleepMs: 6 * 60 * 60 * 1000,                // NEW: макс. сон вне окна (страховка планировщика)
  logWhenMarketClosed: false,                    // NEW: логировать ли пропущенные ночные циклы
  positionMonitorIntervalMs: 15 * 1000,
  maxPositions: MAX_OPEN_POSITIONS,
  positionSizeFraction: 0.30,
  startingBalance: STARTING_BALANCE,
  allowedMarketStates: ['resonant', 'transition'] as const,
  htfFilterEnabled: true,
  htfMinAdx1h: 18,
  entryTimeoutBars: 4,
  logSignals: true,
  logTrades: true,
  telegramEnabled: true,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || ''
} as const;

type Symbol = typeof AUTO_BOT_CONFIG.symbols[number];

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
// NEW: маскировка секретов в логах и статусе
// ============================================================================
function maskSecret(value: string): string {
  if (!value) return value;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function maskedConfig() {
  return { ...AUTO_BOT_CONFIG, telegramBotToken: maskSecret(AUTO_BOT_CONFIG.telegramBotToken) };
}

// ============================================================================
// NEW: привязка цикла к закрытию бара и торговому окну (МСК = UTC+3, без DST)
// ============================================================================
const MSK_OFFSET_MIN = 180;

function timeframeToMs(tf: string): number {
  const m = /^(\d+)([mhd])$/.exec(tf);
  if (!m) throw new Error(`Unsupported timeframe: ${tf}`);
  const n = Number(m[1]);
  const unitMs = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
  return n * unitMs;
}

function msUntilNextBarClose(now: number, barMs: number, delayMs: number): number {
  const nextClose = (Math.floor(now / barMs) + 1) * barMs;
  return nextClose + delayMs - now;
}

function getMarketTimeParts(now: number): { weekday: number; minutes: number } {
  const shifted = new Date(now + MSK_OFFSET_MIN * 60_000);
  return {
    weekday: shifted.getUTCDay(), // 0 = воскресенье, 6 = суббота
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  };
}

function isTradingWindowOpen(now: number): boolean {
  const { weekday, minutes } = getMarketTimeParts(now);
  if (weekday === 0 || weekday === 6) return false;
  return AUTO_BOT_CONFIG.tradingWindows.some(([start, end]) => minutes >= start && minutes <= end);
}

function nextTradingWindowOpenMs(now: number): number | null {
  const startMin = AUTO_BOT_CONFIG.tradingWindows[0][0]; // используем начало первого окна
  for (let i = 0; i < 9; i++) {
    const mskNow = now + MSK_OFFSET_MIN * 60_000;
    const mskMidnight = Math.floor(mskNow / 86_400_000) * 86_400_000;
    const openTs = mskMidnight - MSK_OFFSET_MIN * 60_000 + startMin * 60_000 + i * 86_400_000;
    if (openTs <= now) continue;
    const { weekday } = getMarketTimeParts(openTs);
    if (weekday === 0 || weekday === 6) continue;
    return openTs;
  }
  return null;
}

function computeRegimeDelayMs(): number {
  const now = nowMs();
  const barMs = timeframeToMs(AUTO_BOT_CONFIG.timeframe);
  const delayMs = AUTO_BOT_CONFIG.barCloseDelaySec * 1000;
  const barDelay = msUntilNextBarClose(now, barMs, delayMs);

  if (!AUTO_BOT_CONFIG.tradingHoursEnabled) return barDelay;
  if (isTradingWindowOpen(now)) return barDelay;

  // Вне окна: спим до открытия сессии (+ задержка), но не дольше maxSleepMs
  const nextOpen = nextTradingWindowOpenMs(now);
  if (nextOpen == null) return barDelay;
  const sleepMs = Math.min(nextOpen + delayMs - now, AUTO_BOT_CONFIG.maxSleepMs);
  return Math.max(sleepMs, 1000);
}

// ============================================================================
// NEW: отбрасывание формирующейся свечи + жёсткий лимит длины серии
// ============================================================================
function candleOpenTimeMs(candle: Candle): number | null {
  const rec = candle as unknown as Record<string, unknown>;
  const t = rec.time ?? rec.datetime ?? rec.timestamp;
  if (t == null) return null;
  if (typeof t === 'number') return t > 1e12 ? t : t * 1000; // мс или секунды
  if (t instanceof Date) return t.getTime();
  const parsed = Date.parse(String(t));
  return Number.isNaN(parsed) ? null : parsed;
}

function trimCandles(candles: Candle[], limit: number, intervalMs: number): Candle[] {
  let out = candles;
  if (AUTO_BOT_CONFIG.dropFormingCandle && out.length > 0) {
    const lastOpen = candleOpenTimeMs(out[out.length - 1]);
    if (lastOpen != null && lastOpen + intervalMs > nowMs()) {
      out = out.slice(0, -1); // последний бар ещё формируется
    }
  }
  if (out.length > limit) out = out.slice(-limit);
  return out;
}

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
Режим: 15m свечи, проверка после закрытия бара
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

export async function runRegimeCheckCycle() {
  if (isRegimeCheckRunning) {
    log('warn', 'Regime check already running, skipping');
    return;
  }
  isRegimeCheckRunning = true;

  try {
    // NEW: торговое окно проверяется ДО любых запросов к API
    if (AUTO_BOT_CONFIG.tradingHoursEnabled && !isTradingWindowOpen(nowMs())) {
      if (AUTO_BOT_CONFIG.logWhenMarketClosed) {
        log('info', 'Outside trading window, cycle skipped (no API calls)');
      }
      return;
    }

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

  // CHANGED: trimCandles — отбрасываем формирующуюся свечу и жёстко режем до лимита
  const candles15raw = await getCandles(symbol, AUTO_BOT_CONFIG.timeframe, AUTO_BOT_CONFIG.candlesLimit);
  const candles15 = trimCandles(candles15raw, AUTO_BOT_CONFIG.candlesLimit, timeframeToMs(AUTO_BOT_CONFIG.timeframe));
  if (candles15.length < 220) {
    log('warn', `${symbol}: not enough 15m candles (${candles15.length}/220)`);
    return;
  }

  const candles1hRaw = await getCandles(symbol, '1h', AUTO_BOT_CONFIG.htfCandlesLimit);
  const candles1h = trimCandles(candles1hRaw, AUTO_BOT_CONFIG.htfCandlesLimit, timeframeToMs('1h'));
  if (candles1h.length < 100) {
    log('warn', `${symbol}: not enough 1h candles for HTF (${candles1h.length}/100)`);
  }

  const htfSeries = buildHtfBiasSeries(candles1h, AUTO_BOT_CONFIG.htfMinAdx1h);

  const marketState = detectMarketState(candles15);
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

  const signal = analyzeMarket(candles15, availableBalance, {
    enabled: AUTO_BOT_CONFIG.htfFilterEnabled,
    minAdx1h: AUTO_BOT_CONFIG.htfMinAdx1h,
    precomputedHtf: htfSeries
  });

  if (!signal.buy && !signal.sell) {
    log('info', `${symbol}: no signal`, {
      regime: signal.regime,
      reject: signal.indicators?.reject ?? 'conditions_not_met',
      lastRsi: signal.indicators?.lastRsi,
      breakoutUp: signal.indicators?.breakoutUp,
      breakoutDown: signal.indicators?.breakoutDown,
      htfEnabled: signal.indicators?.htfEnabled,
      htfBias: signal.indicators?.htfBias,
      sideWouldBe: signal.indicators?.sideWouldBe,
      stopPct: signal.indicators?.stopPct,
      price: signal.price,
      bbUpper: signal.indicators?.bbUpper,
      bbLower: signal.indicators?.bbLower,
      candleBody: signal.indicators?.candleBody,
      minBody: signal.indicators?.minBody,
      volumeSpike: signal.indicators?.volumeSpike,
      rejectReasons: signal.indicators?.rejectReasons
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

  const coherence = computeCoherenceScore(candles15, side);
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
        });
      }

      log('info', `POSITION OPENED: ${symbol} ${pending.side.toUpperCase()}`, {
        entryPrice: currentPrice,
        quantity: pending.quantity,
        balance: result.balance
      });

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
              });
            }

            log('info', `POSITION CLOSED: ${pos.symbol} ${pos.side.toUpperCase()} @ ${currentPrice} (${reason.toUpperCase()})`, {
              pnl: closedTrade?.realizedPnL?.toFixed(2),
              balance: result.balance
            });

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

// CHANGED: setInterval заменён на самоперепланирующийся setTimeout
let regimeTimer: NodeJS.Timeout | null = null;
let monitorInterval: NodeJS.Timeout | null = null;

function scheduleNextRegimeCycle() {
  const delay = computeRegimeDelayMs();
  log('info', 'Next regime check scheduled', { at: formatTime(nowMs() + delay), delayMs: delay });
  regimeTimer = setTimeout(() => {
    runRegimeCheckCycle()
      .catch(err => log('error', 'Regime cycle error', { error: err instanceof Error ? err.message : String(err) }))
      .finally(scheduleNextRegimeCycle);
  }, delay);
}

export async function startAutoBot() {
  log('info', 'Starting auto-bot...', { config: maskedConfig() }); // CHANGED: токен замаскирован

  if (AUTO_BOT_CONFIG.telegramEnabled) {
    await sendTelegramTestMessage();
  }

  runRegimeCheckCycle().catch(err => log('error', 'Initial regime check failed', { error: err instanceof Error ? err.message : String(err) }));

  scheduleNextRegimeCycle(); // CHANGED: было setInterval(..., regimeCheckIntervalMs)

  monitorInterval = setInterval(() => {
    runPositionMonitorCycle().catch(err => log('error', 'Monitor cycle error', { error: err instanceof Error ? err.message : String(err) }));
  }, AUTO_BOT_CONFIG.positionMonitorIntervalMs);

  log('info', 'Auto-bot started');
}

export function stopAutoBot() {
  if (regimeTimer) clearTimeout(regimeTimer);   // CHANGED: было clearInterval(regimeInterval)
  if (monitorInterval) clearInterval(monitorInterval);
  regimeTimer = null;
  monitorInterval = null;
  log('info', 'Auto-bot stopped');
}

export function getAutoBotStatus() {
  return {
    running: !!regimeTimer,
    config: maskedConfig(), // CHANGED: токен замаскирован
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
