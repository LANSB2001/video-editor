import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../shared/api';
import { DEFAULT_MODEL } from './ai';

interface Stored {
  apiKey?: string; // encrypted with the OS keychain when available, base64
  encrypted?: boolean;
  model?: string;
}

const file = () => path.join(app.getPath('userData'), 'settings.json');

async function read(): Promise<Stored> {
  try {
    return JSON.parse(await fs.readFile(file(), 'utf8'));
  } catch {
    return {};
  }
}

export async function getApiKey(): Promise<string | undefined> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const s = await read();
  if (!s.apiKey) return undefined;
  const buf = Buffer.from(s.apiKey, 'base64');
  return s.encrypted ? safeStorage.decryptString(buf) : buf.toString('utf8');
}

export async function getSettings(): Promise<Settings> {
  const s = await read();
  return { hasApiKey: !!(await getApiKey()), model: s.model ?? DEFAULT_MODEL };
}

export async function setApiKey(key: string): Promise<Settings> {
  const s = await read();
  const trimmed = key.trim();
  if (!trimmed) {
    delete s.apiKey;
  } else if (safeStorage.isEncryptionAvailable()) {
    s.apiKey = safeStorage.encryptString(trimmed).toString('base64');
    s.encrypted = true;
  } else {
    s.apiKey = Buffer.from(trimmed).toString('base64');
    s.encrypted = false;
  }
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await fs.writeFile(file(), JSON.stringify(s, null, 2));
  return getSettings();
}
