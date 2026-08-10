import { Download, Puzzle, Crop, Sparkles, Camera } from 'lucide-react';

// Options-page field names and expected values (verified against
// extension/src/options/index.html and the service worker's fetch paths):
//   "Web UI URL"  — the address you open Midas at.
//   "API URL"     — the API ORIGIN only; the extension appends /api/v1 itself.
// In production both are the same domain because nginx proxies /api.
const PROD_WEB_URL = 'https://midas.booute.duckdns.org';
const PROD_API_URL = 'https://midas.booute.duckdns.org';

export function GetExtension() {
  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
          <Puzzle className="h-6 w-6 text-brand-600" />
          Get the Midas Extension
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Capture receipts from any webpage and file expenses without leaving the tab.
        </p>
      </div>

      {/* What it does */}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <FeatureCard
          icon={<Crop className="h-5 w-5 text-brand-600" />}
          title="Drag to crop"
          body="Snapshot the page, then drag a rectangle around just the receipt."
        />
        <FeatureCard
          icon={<Sparkles className="h-5 w-5 text-brand-600" />}
          title="OCR pre-fill"
          body="Merchant, amount and date are read from the receipt automatically."
        />
        <FeatureCard
          icon={<Camera className="h-5 w-5 text-brand-600" />}
          title="Save for later"
          body="Not ready to file? Save a capture and link it to an expense anytime."
        />
      </div>

      {/* Download */}
      <div className="mb-6 rounded-xl border border-brand-200 bg-brand-50 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-brand-900">Midas Capture for Chrome &amp; Edge</p>
            <p className="mt-0.5 text-xs text-brand-700">Installed manually via "Load unpacked" — no web store needed.</p>
          </div>
          <a
            href="/midas-extension.zip"
            download
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Download className="h-4 w-4" />
            Download extension
          </a>
        </div>
      </div>

      {/* Install steps */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-gray-900">Install in Chrome or Edge</h2>
        <ol className="space-y-3 text-sm text-gray-700">
          <Step n={1}>
            Download the zip above and <strong>unzip it</strong> into a folder you'll keep (the browser
            loads the extension from that folder, so don't delete it).
          </Step>
          <Step n={2}>
            Open <Code>chrome://extensions</Code> (Edge: <Code>edge://extensions</Code>) and switch on{' '}
            <strong>Developer mode</strong> (top-right toggle).
          </Step>
          <Step n={3}>
            Click <strong>Load unpacked</strong> and select the unzipped folder.
          </Step>
          <Step n={4}>
            Pin the Midas icon: click the puzzle-piece button in the toolbar, then the pin next to{' '}
            <strong>Midas Capture</strong>.
          </Step>
          <Step n={5}>
            Right-click the Midas icon → <strong>Options</strong> and set:
            <div className="mt-2 space-y-1.5">
              <div className="rounded-lg bg-gray-50 px-3 py-2">
                <span className="font-medium text-gray-900">Web UI URL:</span>{' '}
                <Code>{PROD_WEB_URL}</Code>
              </div>
              <div className="rounded-lg bg-gray-50 px-3 py-2">
                <span className="font-medium text-gray-900">API URL:</span>{' '}
                <Code>{PROD_API_URL}</Code>
                <p className="mt-1 text-xs text-gray-500">
                  The API origin only — no <Code>/api</Code> path; the extension adds it itself.
                </p>
              </div>
            </div>
          </Step>
          <Step n={6}>
            <strong>Log into Midas in this browser first.</strong> The extension uses your Midas session
            cookie — there's no separate extension login. If you see "Not logged in to Midas", open{' '}
            <Code>{PROD_WEB_URL}</Code>, sign in, and try again.
          </Step>
        </ol>

        <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500">
          <strong className="text-gray-700">Firefox:</strong> not supported yet — the extension is
          Chrome/Edge only for now.
        </div>
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-2">{icon}</div>
      <p className="text-sm font-semibold text-gray-900">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-gray-500">{body}</p>
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
  return <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-800">{children}</code>;
}
