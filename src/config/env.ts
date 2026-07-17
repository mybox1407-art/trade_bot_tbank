import dotenv from 'dotenv';

dotenv.config();

export const env = {
  port: Number(process.env.PORT) || 3011,
  tinkoffToken: process.env.TINKOFF_TOKEN || '',
  tinkoffSandbox: (process.env.TINKOFF_SANDBOX ?? 'true') === 'true'
};
