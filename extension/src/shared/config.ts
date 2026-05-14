import { type ExtensionConfig, DEFAULT_CONFIG } from './types';

export async function getConfig(): Promise<ExtensionConfig> {
  const result = await chrome.storage.sync.get('config');
  return { ...DEFAULT_CONFIG, ...(result.config ?? {}) };
}

export async function setConfig(config: Partial<ExtensionConfig>): Promise<void> {
  const current = await getConfig();
  await chrome.storage.sync.set({ config: { ...current, ...config } });
}
