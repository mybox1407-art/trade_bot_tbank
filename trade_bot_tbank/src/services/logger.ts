// trade_bot_tbank/src/services/logger.ts

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

type LogRow = Record<string, unknown>;

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);

  if (
    text.includes(',') ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      const nextChar = line[index + 1];

      if (inQuotes && nextChar === '"') {
        value += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(value);
      value = '';
      continue;
    }

    value += char;
  }

  values.push(value);

  return values;
}

function serializeCsvLine(values: unknown[]): string {
  return values
    .map(escapeCsv)
    .join(',');
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getExistingHeaders(logPath: string): string[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, 'utf8');

  if (!content.trim()) {
    return [];
  }

  const [headerLine] = content.split(/\r?\n/);

  if (!headerLine) {
    return [];
  }

  return parseCsvLine(headerLine);
}

function rewriteCsvWithHeaders(
  logPath: string,
  oldHeaders: string[],
  newHeaders: string[]
) {
  const content = fs.readFileSync(logPath, 'utf8');

  if (!content.trim()) {
    fs.writeFileSync(
      logPath,
      `${serializeCsvLine(newHeaders)}\n`
    );

    return;
  }

  const lines = content
    .split(/\r?\n/)
    .filter(line => line.length > 0);

  const dataLines = lines.slice(1);

  const oldHeaderIndex = new Map<string, number>();

  oldHeaders.forEach((header, index) => {
    oldHeaderIndex.set(header, index);
  });

  const outputLines: string[] = [
    serializeCsvLine(newHeaders)
  ];

  for (const line of dataLines) {
    const oldValues = parseCsvLine(line);

    const newValues = newHeaders.map(header => {
      const oldIndex = oldHeaderIndex.get(header);

      return oldIndex === undefined
        ? ''
        : oldValues[oldIndex] ?? '';
    });

    outputLines.push(serializeCsvLine(newValues));
  }

  fs.writeFileSync(
    logPath,
    `${outputLines.join('\n')}\n`
  );
}

function writeRow(
  fileName: string,
  row: LogRow
) {
  ensureDataDir();

  const logPath = path.join(DATA_DIR, fileName);
  const rowHeaders = Object.keys(row);

  if (!fs.existsSync(logPath)) {
    const headerLine = serializeCsvLine(rowHeaders);
    const valueLine = serializeCsvLine(
      rowHeaders.map(header => row[header])
    );

    fs.writeFileSync(
      logPath,
      `${headerLine}\n${valueLine}\n`
    );

    return;
  }

  let existingHeaders = getExistingHeaders(logPath);

  if (existingHeaders.length === 0) {
    const headerLine = serializeCsvLine(rowHeaders);
    const valueLine = serializeCsvLine(
      rowHeaders.map(header => row[header])
    );

    fs.writeFileSync(
      logPath,
      `${headerLine}\n${valueLine}\n`
    );

    return;
  }

  const missingHeaders = rowHeaders.filter(
    header => !existingHeaders.includes(header)
  );

  if (missingHeaders.length > 0) {
    const updatedHeaders = [
      ...existingHeaders,
      ...missingHeaders
    ];

    rewriteCsvWithHeaders(
      logPath,
      existingHeaders,
      updatedHeaders
    );

    existingHeaders = updatedHeaders;
  }

  const values = existingHeaders.map(
    header => row[header]
  );

  fs.appendFileSync(
    logPath,
    `${serializeCsvLine(values)}\n`
  );
}

export function logSignalCheck(row: LogRow) {
  writeRow('signal_log.csv', row);
}

export function logTrade(row: LogRow) {
  writeRow('trades.csv', row);
}
