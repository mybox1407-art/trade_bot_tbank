import fs from 'fs';
import path from 'path';

function writeRow(fileName: string, row: Record<string, string | number | boolean | null>) {
  const logPath = path.join(process.cwd(), fileName);
  const headers = Object.keys(row).join(',');
  const values = Object.values(row).map(v => String(v)).join(',');

  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, headers + '\n');
  }

  fs.appendFileSync(logPath, values + '\n');
}

export function logSignalCheck(row: Record<string, string | number | boolean | null>) {
  writeRow('signal_log.csv', row);
}

export function logTrade(row: Record<string, string | number | boolean | null>) {
  writeRow('trade_log.csv', row);
}
