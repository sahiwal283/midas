import { useEffect, useState } from 'react';
import { Download, Puzzle, X } from 'lucide-react';

// First-run modal that replaces the old /get-extension page. Desktop-only
// (the extension can't be installed on mobile). Suppressed once the user has
// dismissed it, downloaded the zip, or actually installed the extension —
// the extension's presence content script stamps
// document.documentElement.dataset.midasExtension with its version.

const STORAGE_KEY = 'midas.extensionSetup';
export const SHOW_EXTENSION_SETUP_EVENT = 'midas:show-extension-setup';

// Same production URL note as the old GetExtension page: in production the
// web UI and API share a domain because nginx proxies /api.
const PROD_WEB_URL = 'https://midas.booute.duckdns.org';

type SetupState = 'dismissed' | 'downloaded' | 'installed';

function readState(): SetupState | null {
  try {
    return localStorage.getItem(STORAGE_KEY) as SetupState | null;
  } catch {
    return null;
  }
}

function writeState(value: SetupState) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Ignore — worst case the modal shows again next visit.
  }
}

function extensionInstalled(): boolean {
  return Boolean(document.documentElement.dataset.midasExtension);
}

/** Clears the suppression flag and asks the mounted modal to re-open. */
export function reopenExtensionSetup() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
  window.dispatchEvent(new Event(SHOW_EXTENSION_SETUP_EVENT));
}

export function ExtensionSetupModal() {
  const [open, setOpen] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  // First-run check: never show if suppressed or the extension is already
  // present. The content script runs at document_start, but give it a moment
  // (and React a paint) before deciding the extension is absent.
  useEffect(() => {
    if (extensionInstalled()) {
      writeState('installed');
      return;
    }
    if (readState()) return;
    const timer = window.setTimeout(() => {
      if (extensionInstalled()) {
        writeState('installed');
        return;
      }
      setOpen(true);
    }, 800);
    return () => window.clearTimeout(timer);
  }, []);

  // Re-entry point: Settings → "Show setup instructions" clears the key and
  // dispatches this event (see reopenExtensionSetup).
  useEffect(() => {
    function onShow() {
      setDownloaded(readState() === 'downloaded');
      setOpen(true);
    }
    window.addEventListener(SHOW_EXTENSION_SETUP_EVENT, onShow);
    return () => window.removeEventListener(SHOW_EXTENSION_SETUP_EVENT, onShow);
  }, []);

  if (!open) return null;

  function handleDownload() {
    writeState('downloaded');
    setDownloaded(true);
    // Keep the modal open so the user can follow the install steps.
  }

  function handleClose() {
    // Don't downgrade 'downloaded'/'installed' to 'dismissed'.
    if (!readState()) writeState('dismissed');
    setOpen(false);
  }

  return (
    // Backdrop intentionally has no onClick — close via the X (or download).
    <div
      className="fixed inset-0 z-50 hidden items-center justify-center bg-black/40 p-4 lg:flex"
      role="dialog"
      aria-modal="true"
      aria-labelledby="extension-setup-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-ink/10 px-6 py-4">
          <div className="min-w-0">
            <h2
              id="extension-setup-title"
              className="flex items-center gap-2 font-display text-xl font-semibold text-ink"
            >
              <Puzzle className="h-5 w-5 text-brand-600" />
              Get the Midas Extension
            </h2>
            <p className="mt-0.5 text-sm text-charcoal/60">
              Capture receipts from any webpage and file expenses without leaving the tab.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-1 text-charcoal/40 hover:bg-ink/[0.04] hover:text-ink"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mb-5 rounded-xl border border-brand-200 bg-brand-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-brand-900">
                  Midas Capture for Chrome &amp; Edge
                </p>
                <p className="mt-0.5 text-xs text-brand-700">
                  Installed manually via "Load unpacked" — no web store needed.
                </p>
              </div>
              <a
                href="/midas-extension.zip"
                download
                onClick={handleDownload}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                <Download className="h-4 w-4" />
                Download extension
              </a>
            </div>
            {downloaded && (
              <p className="mt-2 text-xs font-medium text-success">
                Downloaded — follow the steps below.
              </p>
            )}
          </div>

          <h3 className="mb-3 text-sm font-semibold text-ink">Install in Chrome or Edge</h3>
          <ol className="space-y-3 text-sm text-charcoal/80">
            <Step n={1}>
              <strong>Unzip</strong> the download into a folder you'll keep (the browser loads the
              extension from that folder, so don't delete it).
            </Step>
            <Step n={2}>
              Open <Code>chrome://extensions</Code> (Edge: <Code>edge://extensions</Code>) and switch
              on <strong>Developer mode</strong> (top-right toggle).
            </Step>
            <Step n={3}>
              Click <strong>Load unpacked</strong> and select the unzipped folder.
            </Step>
            <Step n={4}>
              Pin the Midas icon: click the puzzle-piece button in the toolbar, then the pin next to{' '}
              <strong>Midas Capture</strong>.
            </Step>
            <Step n={5}>
              <strong>That's it — no configuration needed.</strong> It uses your Midas session
              cookie, so just stay signed in to <Code>{PROD_WEB_URL}</Code> in this browser.
            </Step>
          </ol>

          <div className="mt-4 rounded-lg border border-ink/10 bg-cream px-4 py-3 text-xs text-charcoal/60">
            <strong className="text-charcoal/80">Firefox:</strong> not supported yet — the extension
            is Chrome/Edge only for now.
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
        {n}
      </span>
      <div className="min-w-0 pt-0.5">{children}</div>
    </li>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-ink/[0.06] px-1.5 py-0.5 text-xs text-ink">{children}</code>
  );
}
