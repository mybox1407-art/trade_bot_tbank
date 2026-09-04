// trade_bot_tbank/src/services/exchange.ts

import axios from 'axios';
import https from 'https';
import { env } from '../config/env';

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type TinkoffQuotation = {
  units?: string | number;
  nano?: number;
};

const BASE_URL = env.tinkoffSandbox
  ? 'https://sandbox-invest-public-api.tbank.ru/rest'
  : 'https://invest-public-api.tbank.ru/rest';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${env.tinkoffToken}`,
    'Content-Type': 'application/json'
  },
  timeout: 60_000,
  httpsAgent
});

const instrumentCache = new Map<string, string>();

const symbolAliases: Record<string, string> = {
  YNDX: 'YDEX'
};

// ============================================================================
// TIMEFRAME CONFIGURATION
// ============================================================================
const TIMEFRAME_TO_INTERVAL: Record<string, string> = {
  '1m': 'CANDLE_INTERVAL_1_MIN',
  '2m': 'CANDLE_INTERVAL_2_MIN',
  '3m': 'CANDLE_INTERVAL_3_MIN',
  '5m': 'CANDLE_INTERVAL_5_MIN',
  '10m': 'CANDLE_INTERVAL_10_MIN',
  '15m': 'CANDLE_INTERVAL_15_MIN',
  '30m': 'CANDLE_INTERVAL_30_MIN',
  '1h': 'CANDLE_INTERVAL_HOUR',
  '2h': 'CANDLE_INTERVAL_2_HOUR',
  '4h': 'CANDLE_INTERVAL_4_HOUR',
  '1d': 'CANDLE_INTERVAL_DAY',
  '1w': 'CANDLE_INTERVAL_WEEK',
  '1M': 'CANDLE_INTERVAL_MONTH'
};

const TIMEFRAME_TO_MS: Record<string, number> = {
  '1m': 1 * 60_000,
  '2m': 2 * 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
  '1M': 30 * 24 * 60 * 60_000
};

function quotationToNumber(value?: TinkoffQuotation): number {
  if (!value) return 0;

  const units = Number(value.units ?? 0);
  const nano = Number(value.nano ?? 0);

  return units + nano / 1e9;
}

function mapInterval(timeframe: string): string {
  const interval = TIMEFRAME_TO_INTERVAL[timeframe];

  if (!interval) {
    throw new Error(
      `Unsupported candle interval: ${timeframe}`
    );
  }

  return interval;
}

function getTimeframeMs(timeframe: string): number {
  const intervalMs = TIMEFRAME_TO_MS[timeframe];

  if (!intervalMs) {
    throw new Error(
      `Unsupported timeframe for candle history range: ${timeframe}`
    );
  }

  return intervalMs;
}

/**
 * Коэффициент запаса нужен потому, что MOEX не торгует ночью и в выходные.
 *
 * Для мелких интервалов используем ×5:
 * - 300 × 5m = 25 торговых часов;
 * - ×5 = 125 календарных часов;
 * - этого обычно хватает, чтобы собрать 300 свечей после ночей и выходных.
 *
 * Для более крупных периодов хватает ×3.
 */
function getHistoryMultiplier(timeframe: string): number {
  switch (timeframe) {
    case '1m':
      return 10;  // ← 1000 × 1m × 10 = 10,000 минут = 6.9 дней
    
    case '2m':
    case '3m':
      return 7;   // ← Меньше, но всё ещё достаточно
    
    case '5m':
      return 5;

    default:
      return 3;
  }
}

async function resolveInstrumentId(symbol: string): Promise<string> {
  const raw = symbol.trim().toUpperCase();
  const normalized = symbolAliases[raw] ?? raw;

  const classCode =
    process.env.MOEX_DEFAULT_CLASS_CODE || 'TQBR';

  const cacheKey = `${normalized}_${classCode}`;

  const cached = instrumentCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const { data } = await api.post(
    '/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument',
    {
      query: normalized
    }
  );

  const instruments = data?.instruments ?? [];

  if (!instruments.length) {
    throw new Error(
      `Инструмент ${normalized} не найден в T-Invest API`
    );
  }

  const exactByTickerAndClass = instruments.find(
    (item: any) =>
      String(item.ticker ?? '').toUpperCase() === normalized &&
      String(item.classCode ?? '').toUpperCase() === classCode
  );

  const exactByTicker = instruments.find(
    (item: any) =>
      String(item.ticker ?? '').toUpperCase() === normalized
  );

  const instrument =
    exactByTickerAndClass ??
    exactByTicker ??
    instruments[0];

  const instrumentId =
    instrument?.instrumentUid ||
    instrument?.figi ||
    `${normalized}_${instrument?.classCode || classCode}`;

  if (!instrumentId) {
    throw new Error(
      `Не удалось определить instrumentId для ${normalized}`
    );
  }

  console.log(
    '[resolveInstrumentId]',
    'input=', raw,
    'normalized=', normalized,
    'requestedClassCode=', classCode,
    'selectedTicker=', instrument?.ticker,
    'selectedClassCode=', instrument?.classCode,
    'instrumentUid=', instrument?.instrumentUid,
    'figi=', instrument?.figi,
    'resolvedInstrumentId=', instrumentId,
    'resultsCount=', instruments.length
  );

  instrumentCache.set(cacheKey, instrumentId);

  return instrumentId;
}

async function fetchCandlesOnce(
  symbol: string,
  timeframe: string,
  limit: number,
  instrumentId: string,
  interval: string,
  intervalMs: number,
  historyMultiplier: number,
  from: Date,
  to: Date
): Promise<Candle[]> {
  const requestPayload = {
    instrumentId,
    from: from.toISOString(),
    to: to.toISOString(),
    interval
  };

  console.log('[getCandles request]', {
    symbol,
    timeframe,
    instrumentId,
    interval,
    limit,
    intervalMs,
    historyMultiplier,
    from: requestPayload.from,
    to: requestPayload.to,
    rangeHours: ((to.getTime() - from.getTime()) / 3_600_000).toFixed(2)
  });

  const { data } = await api.post(
    '/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles',
    requestPayload
  );

  const candles = data?.candles ?? [];

  const mapped: Candle[] = candles.map((candle: any) => ({
    time: new Date(candle.time).getTime(),
    open: quotationToNumber(candle.open),
    high: quotationToNumber(candle.high),
    low: quotationToNumber(candle.low),
    close: quotationToNumber(candle.close),
    volume: Number(candle.volume ?? 0)
  }));

  console.log(
    '[getCandles]',
    'symbol=', symbol,
    'timeframe=', timeframe,
    'requestedLimit=', limit,
    'received=', mapped.length,
    'from=', from.toISOString(),
    'to=', to.toISOString()
  );

  return mapped.slice(-limit);
}

export async function getCandles(
  symbol: string,
  timeframe = '15m',
  limit = 250
): Promise<Candle[]> {
  const instrumentId = await resolveInstrumentId(symbol);

  const interval = mapInterval(timeframe);
  const intervalMs = getTimeframeMs(timeframe);

  const to = new Date();
  const historyMultiplier = getHistoryMultiplier(timeframe);
  const neededMs = limit * intervalMs;
  const from = new Date(to.getTime() - neededMs * historyMultiplier);

  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const startedAt = Date.now();

    try {
      const candles = await fetchCandlesOnce(
        symbol,
        timeframe,
        limit,
        instrumentId,
        interval,
        intervalMs,
        historyMultiplier,
        from,
        to
      );

      console.log('[getCandles] success', {
        symbol,
        timeframe,
        attempt,
        durationMs: Date.now() - startedAt,
        candles: candles.length
      });

      return candles;
    } catch (err) {
      lastError = err;

      const isTimeout =
        err instanceof Error &&
        err.message.includes('timeout');

      console.error('[getCandles] attempt failed', {
        symbol,
        timeframe,
        attempt,
        maxRetries,
        durationMs: Date.now() - startedAt,
        isTimeout,
        error: err instanceof Error ? err.message : err
      });

      if (!isTimeout || attempt === maxRetries) {
        break;
      }

      const delayMs = 2000 * attempt;
      console.log('[getCandles] retrying', {
        symbol,
        timeframe,
        attempt: attempt + 1,
        maxRetries,
        delayMs
      });

      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  throw lastError;
}

export async function getCurrentPrice(
  symbol: string
): Promise<number> {
  const instrumentId = await resolveInstrumentId(symbol);

  const { data } = await api.post(
    '/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices',
    {
      instrumentId: [instrumentId]
    }
  );

  const prices = data?.lastPrices ?? [];
  const lastPrice = prices[0]?.price;

  if (!lastPrice) {
    throw new Error(
      `Не удалось получить текущую цену для ${symbol}`
    );
  }

  return quotationToNumber(lastPrice);
}
