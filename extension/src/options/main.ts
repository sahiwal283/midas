// Options page logic. MV3 pages block inline scripts (CSP), so this must be an
// external module — the previous inline <script> silently never ran, which is
// why Save appeared to do nothing.
import { DEFAULT_CONFIG } from '../shared/types';

const midasUrlInput = document.getElementById('midasUrl') as HTMLInputElement;
const midasApiUrlInput = document.getElementById('midasApiUrl') as HTMLInputElement;
const status = document.getElementById('status') as HTMLParagraphElement;

async function load(): Promise<void> {
  const { config = {} } = await chrome.storage.sync.get('config');
  midasUrlInput.value = (config as Partial<typeof DEFAULT_CONFIG>).midasUrl ?? DEFAULT_CONFIG.midasUrl;
  midasApiUrlInput.value = (config as Partial<typeof DEFAULT_CONFIG>).midasApiUrl ?? DEFAULT_CONFIG.midasApiUrl;
}

async function save(): Promise<void> {
  const midasUrl = midasUrlInput.value.trim() || DEFAULT_CONFIG.midasUrl;
  const midasApiUrl = midasApiUrlInput.value.trim() || DEFAULT_CONFIG.midasApiUrl;
  await chrome.storage.sync.set({ config: { midasUrl, midasApiUrl } });
  status.textContent = 'Saved!';
  setTimeout(() => { status.textContent = ''; }, 2500);
}

document.getElementById('saveBtn')!.addEventListener('click', () => void save());
void load();
