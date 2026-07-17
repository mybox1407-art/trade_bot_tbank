import axios from 'axios';
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

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${env.tinkoffToken}`,
    'Content-Type': 'application/json'
  },
  timeout: 15000
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

function timeframeToMinutes(timeframe: string): number {
  const values: Record<string, number> = {
    '1m': 1,
    '2m': 2,
    '3m': 3,
    '5m': 5,
    '10m': 10,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '2h': 120,
    '4h': 240,
    '1d': 1440,
    '1w': 10080,
    '1M': 43200
  };

  return values[timeframe] ?? 15;
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

  const instrumentId = instrument.instrumentUid || instrument.uid || `${normalized}_${instrument.classCode || classCode}`;
  instrumentCache.set(cacheKey, instrumentId);

  return instrumentId;
}

export async function getCandles(symbol: string, timeframe = '15m', limit = 250): Promise<Candle[]> {
  const instrumentId = await resolveInstrumentId(symbol);
  const interval = mapInterval(timeframe);
  const candleMinutes = timeframeToMinutes(timeframe);

  const to = new Date();
  const from = new Date(to.getTime() - limit * candleMinutes * 60 * 1000);

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

  return candles.map((c: any) => ({
    time: new Date(c.time).getTime(),
    open: quotationToNumber(c.open),
    high: quotationToNumber(c.high),
    low: quotationToNumber(c.low),
    close: quotationToNumber(c.close),
    volume: Number(c.volume ?? 0)
  }));
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
