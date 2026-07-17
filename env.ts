import dotenv from 'dotenv';

dotenv.config();

export const env = {
  port: Number(process.env.PORT) || 3001,
  apiKey: process.env.API_KEY || '',
  apiSecret: process.env.API_SECRET || ''
};
