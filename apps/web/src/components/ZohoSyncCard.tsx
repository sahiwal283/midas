import { CheckCircle2, AlertTriangle, Circle } from 'lucide-react';

/**
 * Shared Zoho sync history card (accountant-facing views only).
 *
 * States (spec: docs/superpowers/specs/2026-08-07-zoho-pipeline-design.md):
 * - Synced:      green check, sync date, Zoho Expense ID.
 * - Sync failed: amber warning, categorized reason from `zohoSyncError`
 *                ("[CATEGORY] message"), optional [Retry] button.
 * - Not pushed:  gray placeholder.
 */

interface ZohoSyncCardExpense {
  id: string;
  status: string;
  zohoExpenseId: string | null;
  zohoSyncedAt: string | null;
  zohoSyncError?: string | null;
}

/** Split "[MAPPING_ERROR] message…" into badge + reason text. */
function parseSyncError(raw: string): { category: string | null; reason: string } {
  const match = /^\[([A-Z_]+)\]\s*(.*)$/s.exec(raw);
  if (!match) return { category: null, reason: raw };
  return { category: match[1], reason: match[2] || 'Unknown error' };
}

export function ZohoSyncCard({
  expense,
  onRetry,
  retrying = false,
}: {
  expense: ZohoSyncCardExpense;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const synced = !!expense.zohoExpenseId;
  const failed = !synced && expense.status === 'zoho_sync_failed';

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="mb-2 text-sm font-semibold text-gray-700">Zoho</h2>

      {synced ? (
        <div className="space-y-1.5">
          <p className="flex items-center gap-2 text-sm font-medium text-green-700">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
            Created
          </p>
          {expense.zohoSyncedAt && (
            <p className="pl-6 text-xs text-gray-500">
              {new Date(expense.zohoSyncedAt).toLocaleString()}
            </p>
          )}
          <p className="pl-6 text-xs text-gray-500">
            Zoho Expense ID: <span className="font-mono text-gray-700">{expense.zohoExpenseId}</span>
          </p>
        </div>
      ) : failed ? (
        <FailedBody
          zohoSyncError={expense.zohoSyncError ?? null}
          onRetry={onRetry}
          retrying={retrying}
        />
      ) : (
        <p className="flex items-center gap-2 text-sm text-gray-400">
          <Circle className="h-4 w-4 shrink-0 text-gray-300" />
          Not pushed yet
        </p>
      )}
    </div>
  );
}

function FailedBody({
  zohoSyncError,
  onRetry,
  retrying,
}: {
  zohoSyncError: string | null;
  onRetry?: () => void;
  retrying: boolean;
}) {
  const { category, reason } = parseSyncError(zohoSyncError ?? 'Unknown error');

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-2 text-sm font-medium text-amber-700">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
        Sync failed
      </p>
      <div className="pl-6 text-xs text-gray-600">
        <span className="font-semibold text-gray-500">Reason: </span>
        {category && (
          <span className="mr-1 inline-flex items-center rounded bg-red-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-red-700">
            {category}
          </span>
        )}
        <span className="text-red-700">{reason}</span>
      </div>
      {onRetry && (
        <div className="pl-6">
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
    </div>
  );
}
