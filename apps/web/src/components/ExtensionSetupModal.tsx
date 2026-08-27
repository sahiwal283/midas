import { useEffect, useState } from 'react';
import { Download, Puzzle } from 'lucide-react';
import { Modal } from './Modal';

// First-run modal that replaces the old /get-extension page. Desktop-only
// (the extension can't be installed on mobile).
//
// Only two things silence it for good: the extension actually being installed
// (its content script stamps document.documentElement.dataset.midasExtension),
// or the user explicitly choosing "Don't show this again". Closing with the X
// snoozes for the browser session only, and downloading the zip is not the
// same as installing it — otherwise someone who downloads and never installs
// is never reminded.

const STORAGE_KEY = 'midas.extensionSetup';
/** Session-scoped so an X-dismiss returns on the next visit, not the next page. */
const SNOOZE_KEY = 'midas.extensionSetup.snoozed';
export const SHOW_EXTENSION_SETUP_EVENT = 'midas:show-extension-setup';

// Same production URL note as the old GetExtension page: in production the
// web UI and API share a domain because nginx proxies /api.
const PROD_WEB_URL = 'https://midas.booute.duckdns.org';

/** Permanent suppression only. Legacy 'dismissed'/'downloaded' values are ignored. */
type SetupState = 'installed' | 'never';

function readState(): SetupState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'installed' || raw === 'never' ? raw : null;
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

function isSnoozed(): boolean {
  try {
    return sessionStorage.getItem(SNOOZE_KEY) === '1';
  } catch {
    return false;
  }
}

function snooze() {
  try {
    sessionStorage.setItem(SNOOZE_KEY, '1');
  } catch {
    // Ignore — worst case it reappears on the next navigation.
  }
}

function extensionInstalled(): boolean {
  return Boolean(document.documentElement.dataset.midasExtension);
}

/**
 * Desktop-only, gated here rather than with a `hidden lg:flex` class: the old
 * approach still mounted the dialog on phones, where it would lock body scroll
 * and trap focus in something nobody could see.
 */
function isDesktop(): boolean {
  return window.matchMedia('(min-width: 1024px)').matches;
}

/** Clears the suppression flag and asks the mounted modal to re-open. */
export function reopenExtensionSetup() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(SNOOZE_KEY);
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
    if (!isDesktop()) return;
    if (readState() || isSnoozed()) return;
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
      if (isDesktop()) setOpen(true);
    }
    window.addEventListener(SHOW_EXTENSION_SETUP_EVENT, onShow);
    return () => window.removeEventListener(SHOW_EXTENSION_SETUP_EVENT, onShow);
  }, []);

  if (!open) return null;

  function handleDownload() {
    // Downloading is not installing — this only drives the UI hint. The modal
    // keeps returning until the extension is actually detected.
    setDownloaded(true);
  }

  /** X or "Remind me later": back on the next visit. */
  function handleClose() {
    snooze();
    setOpen(false);
  }

  /** Explicit opt-out: never again on this browser. */
  function handleNeverShow() {
    writeState('never');
    setOpen(false);
  }

  return (
    <Modal
      open={open}
      // Backdrop click only snoozes, same as the X — nothing is lost.
      onClose={handleClose}
      size="md"
      title="Get the Midas Extension"
      subtitle="Capture receipts from any webpage and file expenses without leaving the tab."
      icon={<Puzzle className="h-5 w-5 shrink-0 text-brand-600" aria-hidden="true" />}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            Reappears next visit until the extension is installed.
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={handleNeverShow} className="btn-ghost">
              Don&apos;t show this again
            </button>
            <button type="button" onClick={handleClose} className="btn-secondary">
              Remind me later
            </button>
          </div>
        </div>
      }
    >
      <div>
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
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-700"
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
    </Modal>
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
