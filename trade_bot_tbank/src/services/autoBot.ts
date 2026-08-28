import { getCandles, getCurrentPrice } from './exchange';
import { detectMarketState, computeCoherenceScore } from './marketState';
import { analyzeMarketMultiTimeframe, Candle, buildHtfBiasSeries } from './strategy';
import { getAllPositions, openPosition, closePosition, getAvailableBalance, getBalance, MAX_OPEN_POSITIONS, STARTING_BALANCE } from './positionState';
import { logSignalCheck, logTrade } from './logger';
import axios from 'axios';

export const AUTO_BOT_CONFIG = {
  symbols: ['TATN', 'GAZP', 'NVTK'] as const,
  timeframe: '5m' as const,
  contextTimeframe: '15m' as const,
  candlesLimit: 300,
  contextCandlesLimit: 250,
  htfCandlesLimit: 300,
  regimeCheckIntervalMs: 5 * 60 * 1000,
  barCloseDelaySec: 15,
  dropFormingCandle: true,
  tradingHoursEnabled: true,

  // МСК: 10:01–18:54 и 19:01–23:45.
  tradingWindows: [ 
    [10 * 60 + 1, 18 * 60 + 54],
    [19 * 60 + 1, 23 * 60 + 45]
  ] as const,

  // МСК: 10:00–18:54 и 19:01–23:49.
  monitorTradingWindows: [
    [10 * 60, 18 * 60 + 54],
    [19 * 60 + 1, 23 * 60 + 49]
  ] as const,

  maxSleepMs: 6 * 60 * 60 * 1000,
  logWhenMarketClosed: false,
  positionMonitorIntervalMs: 15 * 1000,
  maxPositions: MAX_OPEN_POSITIONS,
  positionSizeFraction: 0.3,
  startingBalance: STARTING_BALANCE,
  allowedMarketStates: ['resonant', 'transition'] as const,
  htfFilterEnabled: true,
  htfMinAdx1h: 18,
  entryTimeoutBars: 4,
  logSignals: true,
  logTrades: true,
  telegramEnabled: true,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramSignalChecksEnabled: true,
  telegramSessionNotificationsEnabled: true
} as const;

type Symbol = typeof AUTO_BOT_CONFIG.symbols[number];
type TradingWindows = readonly (readonly [number, number])[];
type SessionState = 'open' | 'closed';

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
let lastSessionState: SessionState | null = null;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowMs() { return Date.now(); }

function formatTime(timestamp: number) {return new Date(timestamp).toISOString(); }

function formatMoney(value: number) { return value.toFixed(2); }

function log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) {
  const line = `[${formatTime(nowMs())}] [AUTO-BOT] [${level.toUpperCase()}] ${message}`;
  if (meta) console.log(line, meta);
  else console.log(line);
}

// ============================================================================
// Маскировка секретов
// ============================================================================
function maskSecret(value: string): string {
  if (!value) return value;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function maskedConfig() {
  return {
    ...AUTO_BOT_CONFIG,
    telegramBotToken: maskSecret(AUTO_BOT_CONFIG.telegramBotToken)
  };
}

// ============================================================================
// Торговое время: TQBR / Y1
// ============================================================================
const MSK_OFFSET_MIN = 180;

function timeframeToMs(timeframe: string): number {
  const match = /^(\d+)([mhd])$/.exec(timeframe);
  if (!match) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const value = Number(match[1]);
  const unitMs = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
  return value * unitMs;
}

function msUntilNextBarClose(now: number, barMs: number, delayMs: number): number {
  const nextClose = (Math.floor(now / barMs) + 1) * barMs;
  return nextClose + delayMs - now;
}

function getMarketTimeParts(now: number): { weekday: number; minutes: number } {
  const shifted = new Date(now + MSK_OFFSET_MIN * 60_000);

  return {
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  };
}

function formatMskTime(now: number): string {
  const { minutes } = getMarketTimeParts(now);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')} МСК`;
}

function isWithinTradingWindows(now: number, windows: TradingWindows): boolean {
  const { weekday, minutes } = getMarketTimeParts(now);
  if (weekday === 0 || weekday === 6) return false;
  return windows.some(([start, end]) => minutes >= start && minutes <= end);
}

function isTradingWindowOpen(now: number): boolean {
  return isWithinTradingWindows(now, AUTO_BOT_CONFIG.tradingWindows);
}

function isMonitorWindowOpen(now: number): boolean {
  return isWithinTradingWindows(now, AUTO_BOT_CONFIG.monitorTradingWindows);
}

function getSessionState(now: number): SessionState {
  return isMonitorWindowOpen(now) ? 'open' : 'closed';
}

function nextTradingWindowOpenMs(now: number): number | null {
  const mskNow = now + MSK_OFFSET_MIN * 60_000;
  const mskMidnight = Math.floor(mskNow / 86_400_000) * 86_400_000;
  for (let dayOffset = 0; dayOffset < 9; dayOffset++) {
    for (const [startMinutes] of AUTO_BOT_CONFIG.tradingWindows) {
      const openTimestamp =
        mskMidnight -
        MSK_OFFSET_MIN * 60_000 +
        startMinutes * 60_000 +
        dayOffset * 86_400_000;
      if (openTimestamp <= now) continue;
      const { weekday } = getMarketTimeParts(openTimestamp);
      if (weekday === 0 || weekday === 6) continue;
      return openTimestamp;
    }
  }

  return null;
}

function computeRegimeDelayMs(): number {
  const now = nowMs();
  const entryBarMs = timeframeToMs(AUTO_BOT_CONFIG.timeframe);
  const delayMs = AUTO_BOT_CONFIG.barCloseDelaySec * 1000;
  const barDelay = msUntilNextBarClose(now, entryBarMs, delayMs);
  if (!AUTO_BOT_CONFIG.tradingHoursEnabled) return barDelay;
  if (isTradingWindowOpen(now)) return barDelay;
  const nextOpen = nextTradingWindowOpenMs(now);
  if (nextOpen === null) return barDelay;
  const sleepMs = Math.min(nextOpen + delayMs - now, AUTO_BOT_CONFIG.maxSleepMs);
  return Math.max(sleepMs, 1_000);
}

// ============================================================================
// Свечи: отбрасывание формирующейся свечи + limit
// ============================================================================
function candleOpenTimeMs(candle: Candle): number | null {
  const record = candle as unknown as Record<string, unknown>;
  const time = record.time ?? record.datetime ?? record.timestamp;
  if (time === null || time === undefined) return null;
  if (typeof time === 'number') return time > 1e12 ? time : time * 1000;
  if (time instanceof Date) return time.getTime();
  const parsed = Date.parse(String(time));
  return Number.isNaN(parsed) ? null : parsed;
}

function trimCandles(candles: Candle[], limit: number, intervalMs: number): Candle[] {
  let output = candles;
  if (AUTO_BOT_CONFIG.dropFormingCandle && output.length > 0) {
    const lastOpen = candleOpenTimeMs(output[output.length - 1]);
    if (lastOpen !== null && lastOpen + intervalMs > nowMs()) {
      output = output.slice(0, -1);
    }
  }
  if (output.length > limit) output = output.slice(-limit);
  return output;
}

// ============================================================================
// Telegram
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
  } catch (error) {
    log('error', 'Telegram send failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

async function notifySessionStateIfChanged(now: number) {
  const currentState = getSessionState(now);
  if (lastSessionState === currentState) return;
  lastSessionState = currentState;
  if (!AUTO_BOT_CONFIG.telegramSessionNotificationsEnabled) return;
  const message =
    currentState === 'open'
      ? ['[СЕССИЯ]', 'Торговая сессия открыта', `Время: ${formatMskTime(now)}`].join('\n')
      : ['[СЕССИЯ]', 'Торговая сессия закрыта', `Время: ${formatMskTime(now)}`].join('\n');

  await sendTelegramMessage(message);
  log('info', `Trading session state changed: ${currentState}`);
}

function formatRejectReason(code: string): string {
  const map: Record<string, string> = {
    '15m_context_not_tradeable': '15m-контекст не подходит',
    '5m_body_too_small': '5m-свеча слишком слабая',
    '5m_body_too_large': '5m-свеча слишком большая',
    '5m_volume_below_threshold': 'недостаточный объём',
    '5m_short_overextended_from_ema20': 'short запоздал: цена далеко ниже EMA20',
    '5m_long_overextended_from_ema20': 'long запоздал: цена далеко выше EMA20',
    '5m_short_close_not_near_low': 'short: закрытие далеко от low',
    '5m_long_close_not_near_high': 'long: закрытие далеко от high',
    'htf_gate': 'направление против 1h',
    'htf_warmup': 'недостаточно 1h-данных',
    'stop_distance': 'стоп вне допустимой дистанции',
    'size_calculation': 'не рассчитан размер позиции',
    'not_trading_hour': 'вне торгового времени',
    'no_5m_entry_conditions': 'условия 5m-входа не выполнены',
    'conditions_not_met': 'условия входа не выполнены'
  };

  return map[code] ?? code;
}

function getRejectCodes(indicators: Record<string, unknown>): string[] {
  const reasons = indicators.rejectReasons;
  if (Array.isArray(reasons) && reasons.length > 0) {
    return reasons
      .filter(reason => typeof reason === 'string')
      .map(reason => String(reason));
  }

  const reject = indicators.reject;
  if (typeof reject === 'string' && reject) return [reject];
  return ['conditions_not_met'];
}

async function sendTelegramRejectedSignalCheck(
  symbol: Symbol,
  regime: string,
  price: number,
  indicators: Record<string, unknown>
) {
  if (!AUTO_BOT_CONFIG.telegramSignalChecksEnabled) return;

  const reasons = getRejectCodes(indicators)
    .map(formatRejectReason)
    .join('; ');

  await sendTelegramMessage([
    '[ПРОВЕРКА СИГНАЛА]',
    `${symbol} | ${regime}`,
    `Цена 5m: ${formatMoney(price)} RUB`,
    `Отклонён: ${reasons}`
  ].join('\n'));
}

async function sendTelegramApprovedSignalCheck(
  symbol: Symbol,
  side: 'long' | 'short',
  regime: string,
  price: number
) {
  if (!AUTO_BOT_CONFIG.telegramSignalChecksEnabled) return;

  const sideText = side === 'long' ? 'LONG' : 'SHORT';

  await sendTelegramMessage([
    '[ПРОВЕРКА СИГНАЛА]',
    `${symbol} | ${regime}`,
    `Цена 5m: ${formatMoney(price)} RUB`,
    `Сигнал разрешён: ${sideText}`
  ].join('\n'));
}

export async function sendTelegramTestMessage() {
  const message = [
    '[TEST] Автономный торговый бот MOEX',
    '',
    'Статус: OK',
    `Время: ${formatTime(nowMs())}`,
    `Баланс: ${formatMoney(getBalance())} руб`,
    `Свободно: ${formatMoney(getAvailableBalance())} руб`,
    `Открыто позиций: ${getAllPositions().length}`,
    '',
    'Тикеры: TATN, GAZP, NVTK',
    'Контекст: 15m',
    'Вход: 5m после закрытия бара',
    'HTF: 1h',
    `Мониторинг позиции: каждые ${AUTO_BOT_CONFIG.positionMonitorIntervalMs / 1000} сек`,
    `Проверки сигналов: ${AUTO_BOT_CONFIG.telegramSignalChecksEnabled ? 'включены' : 'выключены'}`,
    `Уведомления о сессии: ${AUTO_BOT_CONFIG.telegramSessionNotificationsEnabled ? 'включены' : 'выключены'}`,
    'Telegram подключён и работает.'
  ].join('\n');

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

  return [
    `[ОТКРЫТИЕ ПОЗИЦИИ] ${sideText}`,
    '',
    `Тикер: ${symbol}`,
    `Цена входа: ${formatMoney(entryPrice)} руб`,
    `Количество: ${quantity} шт`,
    `Объём позиции: ${formatMoney(positionSize)} руб`,
    `Stop Loss: ${formatMoney(stopLoss)} руб`,
    `Take Profit: ${formatMoney(takeProfit)} руб`,
    `Риск (R): ${formatMoney(initialR)} руб`,
    '',
    `Баланс до: ${formatMoney(balanceBefore)} руб`,
    `Баланс после: ${formatMoney(balanceAfter)} руб`,
    `Свободно: ${formatMoney(getAvailableBalance())} руб`,
    '',
    `Режим 15m: ${regime}`,
    'Точка входа: 5m',
    `Время: ${formatTime(nowMs())}`
  ].join('\n');
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
  const reasonText =
    reason === 'take_profit'
      ? 'TAKE PROFIT'
      : reason === 'stop_loss'
        ? 'STOP LOSS'
        : 'MANUAL';

  const pnlPercent = ((realizedPnL / balanceBefore) * 100).toFixed(2);

  return [
    `[ЗАКРЫТИЕ ПОЗИЦИИ] ${sideText}`,
    '',
    `Тикер: ${symbol}`,
    `Цена входа: ${formatMoney(entryPrice)} руб`,
    `Цена выхода: ${formatMoney(exitPrice)} руб`,
    `Количество: ${quantity} шт`,
    `PNL: ${pnlSign}${formatMoney(realizedPnL)} руб (${pnlSign}${pnlPercent}%)`,
    `Комиссии: ${formatMoney(totalCommission)} руб`,
    '',
    `Баланс до: ${formatMoney(balanceBefore)} руб`,
    `Баланс после: ${formatMoney(balanceAfter)} руб`,
    `Изменение: ${pnlSign}${formatMoney(realizedPnL)} руб`,
    '',
    `Причина: ${reasonText}`,
    `Время: ${formatTime(nowMs())}`
  ].join('\n');
}

// ============================================================================
// Логирование
// ============================================================================
function getVolumeLogMeta(indicators: Record<string, unknown> | undefined) {
  if (!indicators) return {};

  return {
    volumeSpike: indicators.volumeSpike,
    volumeCurrent: indicators.volumeCurrent,
    volumeMedian: indicators.volumeMedian,
    volumeRatio: indicators.volumeRatio,
    volumeThreshold: indicators.volumeThreshold,
    volumeSampleSize: indicators.volumeSampleSize
  };
}

function get5mEntryLogMeta(indicators: Record<string, unknown> | undefined) {
  if (!indicators) return {};

  return {
    entryTimeframe: indicators.entryTimeframe,
    contextTimeframe: indicators.contextTimeframe,
    contextRegime: indicators.contextRegime,
    context15mAdx: indicators.context15mAdx,
    context15mBbWidth: indicators.context15mBbWidth,
    lastAtr: indicators.lastAtr5m ?? indicators.lastAtr,
    lastRsi: indicators.lastRsi5m ?? indicators.lastRsi,
    ema20_5m: indicators.ema20_5m,
    candleBody: indicators.candleBody5m ?? indicators.candleBody,
    candleBodyAtrRatio: indicators.candleBodyAtrRatio5m ?? indicators.candleBodyAtrRatio,
    minBody: indicators.minBody5m ?? indicators.minBody,
    maxBody: indicators.maxBody5m ?? indicators.maxBody,
    bodyValid: indicators.bodyValid ?? indicators.breakoutBodyWithinRange,
    breakoutBodyWithinRange: indicators.breakoutBodyWithinRange,
    localLow5m: indicators.localLow5m,
    localHigh5m: indicators.localHigh5m,
    shortBreakdownThreshold: indicators.shortBreakdownThreshold,
    longBreakoutThreshold: indicators.longBreakoutThreshold,
    confirmedBreakdown5m: indicators.confirmedBreakdown5m,
    confirmedBreakout5m: indicators.confirmedBreakout5m,
    shortExtensionFromEma20: indicators.shortExtensionFromEma20,
    longExtensionFromEma20: indicators.longExtensionFromEma20,
    maxEma20ExtensionAtr: indicators.maxEma20ExtensionAtr,
    shortNotOverextended: indicators.shortNotOverextended,
    longNotOverextended: indicators.longNotOverextended,
    closeNearLow: indicators.closeNearLow,
    closeNearHigh: indicators.closeNearHigh,
    htfEnabled: indicators.htfEnabled,
    htfBias: indicators.htfBias,
    htfAdx: indicators.htfAdx
  };
}

// ============================================================================
// Основной цикл стратегии
// ============================================================================
export async function runRegimeCheckCycle() {
  if (isRegimeCheckRunning) { log('warn', 'Regime check already running, skipping');
    return;
  }
  isRegimeCheckRunning = true;
  try {
    await notifySessionStateIfChanged(nowMs());
    if (AUTO_BOT_CONFIG.tradingHoursEnabled && !isTradingWindowOpen(nowMs())) {
      if (AUTO_BOT_CONFIG.logWhenMarketClosed) { log('info', 'Outside trading window, cycle skipped (no API calls)'); }
      return;
    }
    log('info', '=== 5M ENTRY / 15M CONTEXT CYCLE START ===');
    const openPositions = getAllPositions();
    const openSymbols = new Set(openPositions.map(position => position.symbol));
    const availableBalance = getAvailableBalance();
    const totalBalance = getBalance();
    log('info', 'Portfolio state', {
      balance: totalBalance,
      availableBalance,
      openPositions: openPositions.length,
      openSymbols: [...openSymbols],
      maxPositions: AUTO_BOT_CONFIG.maxPositions,
      entryTimeframe: AUTO_BOT_CONFIG.timeframe,
      contextTimeframe: AUTO_BOT_CONFIG.contextTimeframe
    });

    if (openPositions.length >= AUTO_BOT_CONFIG.maxPositions) { log('info', 'Max positions reached, skipping signal search');
      return;
    }

    for (const symbol of AUTO_BOT_CONFIG.symbols) {
      if (openSymbols.has(symbol)) { log('info', `Skipping ${symbol}: position already open`);
        continue;
      }

      if (pendingSignals.has(symbol)) {
        const pending = pendingSignals.get(symbol)!;
        pending.barsWaited += 1;

        if (pending.barsWaited >= AUTO_BOT_CONFIG.entryTimeoutBars) {
          log('info', `Signal expired for ${symbol} after ${pending.barsWaited} 5m bars`);
          pendingSignals.delete(symbol);
        } else {
          log( 'info', `Pending signal for ${symbol} waiting (5m bar ${pending.barsWaited}/${AUTO_BOT_CONFIG.entryTimeoutBars})` );
        }

        continue;
      }

      try {
        await processSymbol(symbol, availableBalance);
      } catch (error) { log('error', `Error processing ${symbol}`, {error: error instanceof Error ? error.message : String(error) });
        await sleep(500);
      }
    }

    log('info', '=== 5M ENTRY / 15M CONTEXT CYCLE END ===');
  } finally {
    isRegimeCheckRunning = false;
  }
}

// ============================================================================
// Обработка тикера: 15m context + 5m entry + 1h HTF
// ============================================================================
async function processSymbol(symbol: Symbol, availableBalance: number) {
  log('info', `Processing ${symbol}...`);

  const candles15mRaw = await getCandles(symbol, AUTO_BOT_CONFIG.contextTimeframe, AUTO_BOT_CONFIG.contextCandlesLimit);
  const candles15m = trimCandles(candles15mRaw, AUTO_BOT_CONFIG.contextCandlesLimit, timeframeToMs(AUTO_BOT_CONFIG.contextTimeframe)
  );

  if (candles15m.length < 220) {
    log('warn', `${symbol}: not enough 15m context candles`, { received: candles15m.length, required: 220 });
    return;
  }
  const candles5mRaw = await getCandles(symbol,AUTO_BOT_CONFIG.timeframe,AUTO_BOT_CONFIG.candlesLimit);
  const candles5m = trimCandles(candles5mRaw,AUTO_BOT_CONFIG.candlesLimit,timeframeToMs(AUTO_BOT_CONFIG.timeframe)
  );

  if (candles5m.length < 60) {
    log('warn', `${symbol}: not enough 5m entry candles`, { received: candles5m.length, required: 60 });
    return;
  }
  const candles1hRaw = await getCandles(symbol,'1h',AUTO_BOT_CONFIG.htfCandlesLimit);
  const candles1h = trimCandles(candles1hRaw,AUTO_BOT_CONFIG.htfCandlesLimit,timeframeToMs('1h')
  );

  if (candles1h.length < 100) {
    log('warn', `${symbol}: not enough 1h candles for HTF`, { received: candles1h.length, required: 100 });
  }

  const htfSeries = buildHtfBiasSeries(candles1h, AUTO_BOT_CONFIG.htfMinAdx1h);
  const marketState = detectMarketState(candles15m);

  if (!marketState.ready) { log('warn', `${symbol}: 15m market state not ready`);
    return;
  }

  log('info', `${symbol} market state`, {
    state: marketState.state,
    sideBias: marketState.sideBias,
    coherence: marketState.coherence.toFixed(4),
    trendScore: marketState.trendScore.toFixed(4),
    noiseScore: marketState.noiseScore.toFixed(4),
    contextTimeframe: AUTO_BOT_CONFIG.contextTimeframe,
    entryTimeframe: AUTO_BOT_CONFIG.timeframe
  });

  if (marketState.state === 'chaotic') {
    log('info', `${symbol}: 15m state=chaotic, skipping 5m entry`);

    if (AUTO_BOT_CONFIG.telegramSignalChecksEnabled) {
      await sendTelegramMessage([
        '[ПРОВЕРКА СИГНАЛА]',
        `${symbol} | chaotic`,
        'Отклонён: 15m-рынок хаотичный'
      ].join('\n'));
    }

    return;
  }

  const signal = analyzeMarketMultiTimeframe({
    candles15m,
    candles5m,
    balance: availableBalance,
    htf: { enabled: AUTO_BOT_CONFIG.htfFilterEnabled, minAdx1h: AUTO_BOT_CONFIG.htfMinAdx1h, precomputedHtf: htfSeries }
  });

  if (!signal.buy && !signal.sell) { const indicators = signal.indicators ?? {};

    log('info', `${symbol}: no 5m entry signal`, {
      regime: signal.regime,
      reject: indicators.reject ?? 'conditions_not_met',
      entryTimeframe: indicators.entryTimeframe ?? '5m',
      contextTimeframe: indicators.contextTimeframe ?? '15m',
      marketState: marketState.state,
      marketBias: marketState.sideBias,
      price: signal.price,
      stopPct: indicators.stopPct,
      sideWouldBe: indicators.sideWouldBe,
      htfSeriesLength: htfSeries.length,
      htfEnabled: indicators.htfEnabled,
      htfBias: indicators.htfBias,
      ...get5mEntryLogMeta(indicators),
      ...getVolumeLogMeta(indicators),
      rejectReasons: indicators.rejectReasons
    });

    await sendTelegramRejectedSignalCheck( symbol, signal.regime, signal.price, indicators );
    return;
  }

  const side = signal.side;
  if (side === 'none') { log('warn', `${symbol}: signal side=none but buy/sell set?`);
    return;
  }

  if (marketState.sideBias !== 'neutral' && marketState.sideBias !== side) {
    log( 'info', `${symbol}: 5m signal ${side} conflicts with 15m market bias ${marketState.sideBias}, skipping` );

    if (AUTO_BOT_CONFIG.telegramSignalChecksEnabled) {
      await sendTelegramMessage([
        '[ПРОВЕРКА СИГНАЛА]',
        `${symbol} | ${signal.regime}`,
        `Цена 5m: ${formatMoney(signal.price)} RUB`,
        `Отклонён: ${side.toUpperCase()} против 15m bias ${marketState.sideBias}`
      ].join('\n'));
    }

    return;
  }

  const coherence = computeCoherenceScore(candles15m, side);

  if (coherence < 0.4) { log('info',  `${symbol}: low 15m coherence ${coherence.toFixed(4)} for 5m ${side}, skipping` );

    if (AUTO_BOT_CONFIG.telegramSignalChecksEnabled) {
      await sendTelegramMessage([
        '[ПРОВЕРКА СИГНАЛА]',
        `${symbol} | ${signal.regime}`,
        `Цена 5m: ${formatMoney(signal.price)} RUB`,
        `Отклонён: низкая 15m coherence (${coherence.toFixed(2)})`
      ].join('\n'));
    }

    return;
  }

  if ( !signal.stopLossPrice || !signal.takeProfit1Price || !signal.takeProfit2Price || !signal.quantity ) {
    log('warn', `${symbol}: incomplete 5m signal data`, signal);

    if (AUTO_BOT_CONFIG.telegramSignalChecksEnabled) {
      await sendTelegramMessage([
        '[ПРОВЕРКА СИГНАЛА]',
        `${symbol} | ${signal.regime}`,
        `Цена 5m: ${formatMoney(signal.price)} RUB`,
        'Отклонён: неполные параметры сделки'
      ].join('\n'));
    }

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
      entryTimeframe: '5m',
      contextTimeframe: '15m',
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

  log( 'info', `SIGNAL GENERATED: ${symbol} ${side.toUpperCase()} (5m entry / 15m context)`,
    {
      entry: signal.price,
      sl: signal.stopLossPrice,
      tp1: signal.takeProfit1Price,
      tp2: signal.takeProfit2Price,
      qty: signal.quantity,
      size: pending.positionSize,
      R: signal.initialR?.toFixed(4),
      marketState: marketState.state,
      marketBias: marketState.sideBias,
      coherence: coherence.toFixed(4),
      ...get5mEntryLogMeta(signal.indicators),
      ...getVolumeLogMeta(signal.indicators)
    }
  );

  await sendTelegramApprovedSignalCheck( symbol,side,signal.regime,signal.price);
  await tryExecutePendingSignal(symbol, signal);
}

// ============================================================================
// Исполнение pending-сигнала
// ============================================================================
async function tryExecutePendingSignal(symbol: Symbol, signal: any) {
  const pending = pendingSignals.get(symbol);
  if (!pending) return;

  try {
    const quoteStartedAt = nowMs();
    const currentPrice = await getCurrentPrice(symbol);
    const quoteReceivedAt = nowMs();
    const balanceBefore = getBalance();
    const baseTolerance = 0.001;
    const lastAtr = (signal.indicators?.lastAtr as number | undefined) ?? 0;
    const atrTolerance =
      lastAtr > 0
        ? lastAtr / pending.entryPrice
        : 0;
    const slippageTolerance = baseTolerance + 0.5 * atrTolerance;
    const priceDiff = Math.abs(currentPrice - pending.entryPrice) /
      pending.entryPrice;
    const fillDrift = currentPrice - pending.entryPrice;
    const fillDriftPct = priceDiff * 100;
    const entryQuality = pending.side === 'short'
        ? currentPrice >= pending.entryPrice
          ? 'favorable_or_equal'
          : 'adverse'
        : currentPrice <= pending.entryPrice
          ? 'favorable_or_equal'
          : 'adverse';

    log('info', `${symbol}: execution quote`, {
      side: pending.side,
      signalPrice: pending.entryPrice,
      currentPrice,
      fillDrift,
      fillDriftPct,
      entryQuality,
      quoteLatencyMs: quoteReceivedAt - quoteStartedAt,
      baseTolerance,
      atrTolerance,
      slippageTolerance
    });

    if (priceDiff > slippageTolerance) {
      log('info', `${symbol}: price moved too far (${fillDriftPct.toFixed(2)}%), waiting`,
        {
          side: pending.side,
          signalPrice: pending.entryPrice,
          currentPrice,
          fillDrift,
          baseTolerance,
          atrTolerance,
          slippageTolerance,
          priceDiff
        }
      );

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

    if (!result.ok) { log('warn', `Failed to open position for ${symbol}`, { message: result.message });
      return;
    }

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

    log( 'info', `POSITION OPENED: ${symbol} ${pending.side.toUpperCase()}`,
      {
        signalPrice: pending.entryPrice,
        entryPrice: currentPrice,
        fillDrift,
        fillDriftPct,
        entryQuality,
        stopLoss: pending.stopLossPrice,
        takeProfit1: pending.takeProfit1Price,
        takeProfit2: pending.takeProfit2Price,
        quantity: pending.quantity,
        balance: result.balance
      }
    );

    const telegramMessage = formatOpenPositionMessage(
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

    await sendTelegramMessage(telegramMessage);
  } catch (error) {
    log('error', `Error executing signal for ${symbol}`, {
      error:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
}

// ============================================================================
// Мониторинг открытых позиций
// ============================================================================
export async function runPositionMonitorCycle() {
  if (isPositionMonitorRunning) return;
  if ( AUTO_BOT_CONFIG.tradingHoursEnabled && !isMonitorWindowOpen(nowMs()) ) {
    return;
  }
  isPositionMonitorRunning = true;

  try {
    const positions = getAllPositions();
    if (positions.length === 0) return;
    for (const position of positions) {
      try {
        const currentPrice = await getCurrentPrice(position.symbol);
        const hitTakeProfit =
          position.side === 'long'
            ? currentPrice >= position.takeProfitPrice
            : currentPrice <= position.takeProfitPrice;
        const hitStopLoss =
          position.side === 'long'
            ? currentPrice <= position.stopLossPrice
            : currentPrice >= position.stopLossPrice;
        if (!hitTakeProfit && !hitStopLoss) continue;
        const reason: 'take_profit' | 'stop_loss' =
          hitTakeProfit
            ? 'take_profit'
            : 'stop_loss';

        const stopDistance = Math.abs( position.entryPrice - position.stopLossPrice );

        const triggerOvershoot =
          reason !== 'stop_loss'
            ? 0
            : position.side === 'long'
              ? position.stopLossPrice - currentPrice
              : currentPrice - position.stopLossPrice;

        const triggerOvershootR =
          reason === 'stop_loss' &&
          stopDistance > 0
            ? triggerOvershoot / stopDistance
            : 0;

        log( 'warn', `EXIT TRIGGERED: ${position.symbol} ${position.side.toUpperCase()}`,
          {
            reason,
            entryPrice: position.entryPrice,
            plannedStop: position.stopLossPrice,
            plannedTakeProfit: position.takeProfitPrice,
            observedExitPrice: currentPrice,
            triggerOvershoot,
            triggerOvershootR,
            monitorIntervalMs: AUTO_BOT_CONFIG.positionMonitorIntervalMs,
            detectedAt: formatTime(nowMs())
          }
        );

        const balanceBefore = getBalance();
        const result = closePosition( position.symbol, currentPrice, reason );
        if (!result.ok) { log('warn', `Failed to close ${position.symbol}`, { reason, message: result.message });
          continue;
        }

        const balanceAfter = getBalance();
        const closedTrade = result.lastClosedTrade;

        if (AUTO_BOT_CONFIG.logTrades && closedTrade) {
          logTrade({
            timestamp: formatTime(nowMs()),
            symbol: position.symbol,
            side: position.side,
            action: 'close',
            entryPrice: position.entryPrice,
            exitPrice: currentPrice,
            stopLoss: position.stopLossPrice,
            takeProfit: position.takeProfitPrice,
            quantity: position.quantity,
            realizedPnL: closedTrade.realizedPnL,
            reason,
            balanceBefore,
            balanceAfter,
            totalCommission: closedTrade.totalCommission
          });
        }

        log( 'info', `POSITION CLOSED: ${position.symbol} ${position.side.toUpperCase()} @ ${currentPrice} (${reason.toUpperCase()})`,
          {
            pnl:
              closedTrade?.realizedPnL?.toFixed(2),
            triggerOvershoot:
              reason === 'stop_loss'
                ? triggerOvershoot.toFixed(6)
                : '0',
            triggerOvershootR:
              reason === 'stop_loss'
                ? triggerOvershootR.toFixed(4)
                : '0',
            balance: result.balance
          }
        );

        if (closedTrade) {
          const telegramMessage = formatClosePositionMessage(
            position.symbol,
            position.side,
            position.entryPrice,
            currentPrice,
            position.quantity,
            closedTrade.realizedPnL,
            reason,
            balanceBefore,
            balanceAfter,
            closedTrade.totalCommission
          );

          await sendTelegramMessage(telegramMessage);
        }
      } catch (error) {
        log('error', `Monitor error for ${position.symbol}`, {
          error:
            error instanceof Error
              ? error.message
              : String(error)
        });
      }
    }
  } finally {
    isPositionMonitorRunning = false;
  }
}

// ============================================================================
// Запуск / остановка
// ============================================================================
let regimeTimer: NodeJS.Timeout | null = null;
let monitorInterval: NodeJS.Timeout | null = null;

function scheduleNextRegimeCycle() {
  const delay = computeRegimeDelayMs();

  log('info', 'Next 5m entry cycle scheduled', {
    at: formatTime(nowMs() + delay),
    delayMs: delay,
    entryTimeframe: AUTO_BOT_CONFIG.timeframe,
    contextTimeframe: AUTO_BOT_CONFIG.contextTimeframe
  });

  regimeTimer = setTimeout(() => {
    runRegimeCheckCycle()
      .catch(error => {
        log('error', 'Regime cycle error', {
          error:
            error instanceof Error
              ? error.message
              : String(error)
        });
      })
      .finally(scheduleNextRegimeCycle);
  }, delay);
}

export async function startAutoBot() {
  log('info', 'Starting auto-bot...', { config: maskedConfig() });
  if (AUTO_BOT_CONFIG.telegramEnabled) { await sendTelegramTestMessage(); }
  await notifySessionStateIfChanged(nowMs());

  runRegimeCheckCycle()
    .catch(error => {
      log('error', 'Initial regime check failed', {
        error:
          error instanceof Error
            ? error.message
            : String(error)
      });
    });

  scheduleNextRegimeCycle();

  monitorInterval = setInterval(() => {
    runPositionMonitorCycle()
      .catch(error => {
        log('error', 'Monitor cycle error', {
          error:
            error instanceof Error
              ? error.message
              : String(error)
        });
      });
  }, AUTO_BOT_CONFIG.positionMonitorIntervalMs);

  log('info', 'Auto-bot started', {
    entryTimeframe: AUTO_BOT_CONFIG.timeframe,
    contextTimeframe: AUTO_BOT_CONFIG.contextTimeframe,
    htfTimeframe: '1h',
    maxPositions: AUTO_BOT_CONFIG.maxPositions,
    maxRiskPerTrade: '3%',
    positionSizeFraction: '30%',
    telegramSignalChecksEnabled:
      AUTO_BOT_CONFIG.telegramSignalChecksEnabled,
    telegramSessionNotificationsEnabled:
      AUTO_BOT_CONFIG.telegramSessionNotificationsEnabled
  });
}

export function stopAutoBot() {
  if (regimeTimer) { clearTimeout(regimeTimer); }
  if (monitorInterval) { clearInterval(monitorInterval); }
  regimeTimer = null;
  monitorInterval = null;
  log('info', 'Auto-bot stopped');
}

export function getAutoBotStatus() {
  return {
    running: Boolean(regimeTimer),
    config: maskedConfig(),
    entryTimeframe: AUTO_BOT_CONFIG.timeframe,
    contextTimeframe: AUTO_BOT_CONFIG.contextTimeframe,
    htfTimeframe: '1h',
    sessionState: getSessionState(nowMs()),

    openPositions: getAllPositions().map(position => ({
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      quantity: position.quantity,
      notional: position.notional,
      takeProfitPrice: position.takeProfitPrice,
      stopLossPrice: position.stopLossPrice,
      openedAt: position.openedAt,
      unrealizedPnL: 0
    })),

    pendingSignals: Array.from(
      pendingSignals.entries()
    ).map(([symbol, signal]) => ({
      symbol,
      side: signal.side,
      entryPrice: signal.entryPrice,
      stopLossPrice: signal.stopLossPrice,
      takeProfit1Price: signal.takeProfit1Price,
      takeProfit2Price: signal.takeProfit2Price,
      barsWaited: signal.barsWaited,
      timeoutBars: AUTO_BOT_CONFIG.entryTimeoutBars,
      entryTimeframe: '5m'
    })),

    telegramSignalChecksEnabled: AUTO_BOT_CONFIG.telegramSignalChecksEnabled,
    telegramSessionNotificationsEnabled: AUTO_BOT_CONFIG.telegramSessionNotificationsEnabled,

    balance: getBalance(),
    availableBalance: getAvailableBalance()
  };
}
