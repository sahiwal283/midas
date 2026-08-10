import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Camera, ExternalLink, X, ReceiptText, Puzzle } from 'lucide-react';
import client from '../api/client';
import type { Capture } from '../types';

function useCapturesApi() {
  return {
    list: () => client.get<{ captures: Capture[] }>('/captures').then((r) => r.data.captures),
    update: (id: string, data: { status: 'discarded' } | { status: 'linked'; expenseId: string }) =>
      client.patch(`/captures/${id}`, data).then((r) => r.data.capture as Capture),
  };
}

type TabId = 'unlinked' | 'linked' | 'discarded';

export function Captures() {
  const api = useCapturesApi();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabId>('unlinked');

  const { data: captures = [], isLoading } = useQuery({
    queryKey: ['captures'],
    queryFn: api.list,
  });

  const discardMutation = useMutation({
    mutationFn: (id: string) => api.update(id, { status: 'discarded' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['captures'] }),
  });

  const unlinked = captures.filter((c) => c.status === 'draft');
  const linked = captures.filter((c) => c.status === 'linked');
  const discarded = captures.filter((c) => c.status === 'discarded');

  const tabCounts: Record<TabId, number> = { unlinked: unlinked.length, linked: linked.length, discarded: discarded.length };
  const current = tab === 'unlinked' ? unlinked : tab === 'linked' ? linked : discarded;

  return (
    <div className="p-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Captures</h1>
          <p className="mt-1 text-sm text-gray-500">
            Screenshots from the Midas browser extension. Unlinked captures are waiting to be turned into expenses.
          </p>
        </div>
        <Link
          to="/get-extension"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-100"
        >
          <Puzzle className="h-3.5 w-3.5" />
          Get the extension
        </Link>
      </div>

      {/* Extension install hint */}
      <div className="mb-6 rounded-xl border border-brand-200 bg-brand-50 p-4">
        <div className="flex items-start gap-3">
          <Camera className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
          <div className="text-sm text-brand-800">
            <strong>Browser Extension:</strong> capture receipts from any webpage — crop them with a drag,
            then <strong>Save Capture</strong> for later or file a <strong>New Expense</strong> with
            OCR-prefilled details. <Link to="/get-extension" className="font-semibold underline hover:text-brand-900">Download &amp; install instructions</Link>.
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 rounded-lg border border-gray-200 bg-gray-100 p-1 w-fit">
        {(['unlinked', 'linked', 'discarded'] as TabId[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium capitalize transition-colors ${tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
          >
            {t === 'unlinked' ? 'Unlinked' : t === 'linked' ? 'Linked to expense' : 'Discarded'}
            {tabCounts[t] > 0 && (
              <span className="ml-1.5 rounded-full bg-gray-200 px-1.5 py-0.5 text-xs text-gray-600">{tabCounts[t]}</span>
            )}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-gray-200 bg-white px-6 py-10 text-center text-sm text-gray-400">Loading…</div>
      ) : current.length === 0 ? (
        <EmptyState tab={tab} />
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {current.map((c) => (
            <CaptureCard
              key={c.id}
              capture={c}
              onDiscard={tab === 'unlinked' ? () => discardMutation.mutate(c.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ tab }: { tab: TabId }) {
  const messages: Record<TabId, string> = {
    unlinked: 'No unlinked captures. Use the browser extension "Save Capture" action to create one.',
    linked: 'No captures linked to expenses yet.',
    discarded: 'No discarded captures.',
  };
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-6 py-12 text-center text-sm text-gray-400">
      {messages[tab]}
    </div>
  );
}

function CaptureCard({ capture, onDiscard }: { capture: Capture; onDiscard?: () => void }) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm hover:shadow-md transition-shadow">
      {/* Image */}
      <div className="relative bg-gray-50 h-44 overflow-hidden">
        <img
          src={`/api/v1/files/captures/${capture.id}`}
          alt="Capture"
          className="h-full w-full object-cover object-top"
        />
        {capture.status === 'linked' && (
          <div className="absolute top-2 right-2 rounded-full bg-green-600 px-2 py-0.5 text-xs font-semibold text-white shadow">
            Linked
          </div>
        )}
      </div>

      {/* Meta */}
      <div className="p-3">
        {capture.pageTitle && (
          <p className="truncate text-sm font-medium text-gray-900 mb-0.5">{capture.pageTitle}</p>
        )}
        {capture.pageUrl && (
          <p className="truncate text-xs text-gray-400 mb-1">{capture.pageUrl}</p>
        )}
        {capture.selectedText && (
          <p className="text-xs text-gray-500 italic line-clamp-2 mb-1">"{capture.selectedText}"</p>
        )}
        <p className="text-xs text-gray-400">{new Date(capture.createdAt).toLocaleString()}</p>

        {/* Actions */}
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {capture.status === 'linked' && capture.expenseId && (
            <Link
              to={`/expenses/${capture.expenseId}`}
              className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-800"
            >
              <ReceiptText className="h-3.5 w-3.5" />
              View expense
            </Link>
          )}
          {capture.pageUrl && (
            <a
              href={capture.pageUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
            >
              <ExternalLink className="h-3 w-3" />
              Source
            </a>
          )}
          {onDiscard && (
            <button
              onClick={onDiscard}
              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-600 ml-auto"
            >
              <X className="h-3.5 w-3.5" />
              Discard
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
