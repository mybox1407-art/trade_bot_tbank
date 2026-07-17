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
  timeout: 15000,
  httpsAgent
});

const instrumentCache = new Map<string, string>();

function quotationToNumber(value?: TinkoffQuotation): number {
  if (!value) return 0;
  const units = Number(value.units ?? 0);
  const nano = Number(value.nano ?? 0);
  return units + nano / 1e9;
}

function mapInterval(timeframe: string): string {
  const intervals: Record<string, string> = {
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

  return intervals[timeframe] ?? 'CANDLE_INTERVAL_15_MIN';
}

async function resolveInstrumentId(symbol: string): Promise<string> {
  const normalized = symbol.trim().toUpperCase();
  const classCode = process.env.MOEX_DEFAULT_CLASS_CODE || 'TQBR';
  const cacheKey = `${normalized}_${classCode}`;

  if (instrumentCache.has(cacheKey)) {
    return instrumentCache.get(cacheKey)!;
  }

  const { data } = await api.post(
    '/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument',
    {
      query: normalized
    }
  );

  const instruments = data?.instruments ?? [];

  const exact = instruments.find(
    (item: any) =>
      item.ticker === normalized &&
      item.classCode === classCode
  );

  const fallback = instruments.find(
    (item: any) => item.ticker === normalized
  );

  const instrument = exact ?? fallback;

  if (!instrument) {
    throw new Error(`Инструмент ${normalized} не найден в T-Invest API`);
  }

  const instrumentId =
    instrument.instrumentUid ||
    instrument.uid ||
    `${normalized}_${instrument.classCode || classCode}`;

  instrumentCache.set(cacheKey, instrumentId);

  return instrumentId;
}

export async function getCandles(
  symbol: string,
  timeframe = '15m',
  limit = 250
): Promise<Candle[]> {
  const instrumentId = await resolveInstrumentId(symbol);
  const interval = mapInterval(timeframe);

  const to = new Date();

  let lookbackDays = 1;
  if (timeframe === '1m') lookbackDays = 1;
  else if (timeframe === '2m') lookbackDays = 1;
  else if (timeframe === '3m') lookbackDays = 1;
  else if (timeframe === '5m') lookbackDays = 7;
  else if (timeframe === '10m') lookbackDays = 7;
  else if (timeframe === '15m') lookbackDays = 21;
  else if (timeframe === '30m') lookbackDays = 21;
  else if (timeframe === '1h') lookbackDays = 90;
  else if (timeframe === '2h') lookbackDays = 90;
  else if (timeframe === '4h') lookbackDays = 90;
  else if (timeframe === '1d') lookbackDays = 365;
  else if (timeframe === '1w') lookbackDays = 365 * 5;
  else if (timeframe === '1M') lookbackDays = 365 * 10;

  const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const { data } = await api.post(
    '/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles',
    {
      instrumentId,
      from: from.toISOString(),
      to: to.toISOString(),
      interval
    }
  );

  const candles = data?.candles ?? [];

  const mapped = candles.map((c: any) => ({
    time: new Date(c.time).getTime(),
    open: quotationToNumber(c.open),
    high: quotationToNumber(c.high),
    low: quotationToNumber(c.low),
    close: quotationToNumber(c.close),
    volume: Number(c.volume ?? 0)
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

export async function getCurrentPrice(symbol: string): Promise<number> {
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
    throw new Error(`Не удалось получить текущую цену для ${symbol}`);
  }

  return quotationToNumber(lastPrice);
}
