import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import axios from 'axios';

type CandleInterval =
  | 'CANDLE_INTERVAL_1_MIN'
  | 'CANDLE_INTERVAL_5_MIN'
  | 'CANDLE_INTERVAL_15_MIN'
  | 'CANDLE_INTERVAL_HOUR'
  | 'CANDLE_INTERVAL_DAY';

type HistoricCandle = {
  time: string;
  volume: string | number;
  open: { units?: string | number; nano?: number } | null;
  high: { units?: string | number; nano?: number } | null;
  low: { units?: string | number; nano?: number } | null;
  close: { units?: string | number; nano?: number } | null;
  isComplete?: boolean;
};

type ApiResponse = {
  candles?: HistoricCandle[];
};

const INTERVAL_MAP: Record<string, CandleInterval> = {
  '1m': 'CANDLE_INTERVAL_1_MIN',
  '5m': 'CANDLE_INTERVAL_5_MIN',
  '15m': 'CANDLE_INTERVAL_15_MIN',
  '1h': 'CANDLE_INTERVAL_HOUR',
  'day': 'CANDLE_INTERVAL_DAY',
};

function moneyToNumber(value: HistoricCandle['open']): number {
  if (!value) return NaN;
  const units = Number(value.units ?? 0);
  const nano = Number(value.nano ?? 0);
  return units + nano / 1e9;
}

function toUnixMs(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new Error(`Некорректная дата: ${iso}`);
  return t;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function chunkPeriods(from: Date, to: Date, chunkDays: number) {
  const chunks: Array<{ from: Date; to: Date }> = [];
  let cursor = new Date(from);

  while (cursor < to) {
    const next = new Date(cursor.getTime() + chunkDays * 24 * 60 * 60 * 1000);
    chunks.push({
      from: new Date(cursor),
      to: next < to ? next : new Date(to)
    });
    cursor = next;
  }

  return chunks;
}

function chunkDaysForInterval(interval: CandleInterval): number {
  switch (interval) {
    case 'CANDLE_INTERVAL_1_MIN':
      return 1;
    case 'CANDLE_INTERVAL_5_MIN':
      return 5;
    case 'CANDLE_INTERVAL_15_MIN':
      return 10;
    case 'CANDLE_INTERVAL_HOUR':
      return 30;
    case 'CANDLE_INTERVAL_DAY':
      return 365;
  }
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCandles(params: {
  token: string;
  figi: string;
  from: Date;
  to: Date;
  interval: CandleInterval;
}) {
  const { token, figi, from, to, interval } = params;

  const url =
    'https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles';

  const httpsAgent = new https.Agent({
    rejectUnauthorized: false
  });

  const response = await axios.post<ApiResponse>(
    url,
    {
      instrumentId: figi,
      from: from.toISOString(),
      to: to.toISOString(),
      interval
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000,
      httpsAgent
    }
  );

  return response.data.candles ?? [];
}

async function main() {
  const token = process.env.TINVEST_TOKEN;
  const [, , figi, symbol = 'INSTRUMENT', daysArg = '21', intervalArg = '15m'] = process.argv;

  if (!token) {
    console.error('Не задан TINVEST_TOKEN');
    console.error('Пример: export TINVEST_TOKEN="твой_токен"');
    process.exit(1);
  }

  if (!figi) {
    console.error('Не указан FIGI.');
    console.error('Пример запуска: npm run download:candles -- BBG004730N88 SBER 7 1m');
    process.exit(1);
  }

  const interval = INTERVAL_MAP[intervalArg];
  if (!interval) {
    console.error(`Некорректный интервал: ${intervalArg}`);
    console.error('Допустимые: 1m, 5m, 15m, 1h, day');
    process.exit(1);
  }

  const days = Number(daysArg);
  if (!Number.isFinite(days) || days <= 0) {
    console.error('Некорректное количество дней.');
    process.exit(1);
  }

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  const chunkDays = chunkDaysForInterval(interval);
  const periods = chunkPeriods(from, to, chunkDays);
  const allCandles: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];

  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    console.log(
      `Загружаю chunk ${i + 1}/${periods.length}: ${period.from.toISOString()} -> ${period.to.toISOString()} [${intervalArg}]`
    );

    const candles = await fetchCandles({
      token,
      figi,
      from: period.from,
      to: period.to,
      interval
    });

    const normalized = candles
      .filter(c => c.open && c.high && c.low && c.close && c.time)
      .map(c => ({
        time: toUnixMs(c.time),
        open: moneyToNumber(c.open),
        high: moneyToNumber(c.high),
        low: moneyToNumber(c.low),
        close: moneyToNumber(c.close),
        volume: Number(c.volume ?? 0)
      }))
      .filter(c =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        Number.isFinite(c.volume)
      );

    allCandles.push(...normalized);

    if (i < periods.length - 1) {
      await sleep(500);
    }
  }

  const deduped = Array.from(
    new Map(allCandles.map(c => [c.time, c])).values()
  ).sort((a, b) => a.time - b.time);

  const outputDir = path.resolve(process.cwd(), 'src/backtest/data');
  ensureDir(outputDir);

  const outputFile = path.join(outputDir, `${symbol}_${intervalArg}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(deduped, null, 2), 'utf-8');

  console.log(`Готово. Сохранено свечей: ${deduped.length}`);
  console.log(`Файл: ${outputFile}`);
}

main().catch(error => {
  console.error('Ошибка загрузки свечей');

  if (axios.isAxiosError(error)) {
    console.error('message:', error.message);
    console.error('code:', error.code);

    if (error.response) {
      console.error('status:', error.response.status);
      console.error('data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('response: отсутствует');
    }
  } else {
    console.error(error);
  }

  process.exit(1);
});
