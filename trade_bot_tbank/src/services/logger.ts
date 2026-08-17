// trade_bot_tbank/src/services/logger.ts

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function writeRow(fileName: string, row: Record<string, unknown>) {
  const logPath = path.join(DATA_DIR, fileName);
  const headers = Object.keys(row).join(',');
  const values = Object.values(row).map(v => {
    if (v === null || v === undefined) return '';
    const str = String(v);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }).join(',');

  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, headers + '\n');
  }

  fs.appendFileSync(logPath, values + '\n');
}

export function logSignalCheck(row: Record<string, unknown>) {
  writeRow('signal_log.csv', row);
}

export function logTrade(row: Record<string, unknown>) {
  writeRow('trades.csv', row);
}
