import { CheckCircle2, AlertTriangle, Circle } from 'lucide-react';

/**
 * Shared Zoho sync history card (accountant-facing views only).
 * Works for expenses and purchase orders.
 */

export type ZohoSyncRecord = {
  status: string;
  zohoRecordId: string | null;
  zohoSyncedAt: string | null;
  zohoSyncError?: string | null;
  integrationStatus?: string | null;
};

/** Legacy expense shape — maps to ZohoSyncRecord. */
interface ZohoSyncCardExpense {
  id: string;
  status: string;
  zohoExpenseId: string | null;
  zohoSyncedAt: string | null;
  zohoSyncError?: string | null;
  integrationStatus?: string | null;
}

export type ZohoRecordKind = 'expense' | 'purchase_order';

/** Matches MAPPING_WARNING_PREFIX on the API side (lib/zohoAccountAudit.ts). */
export const MAPPING_WARNING_CATEGORY = 'MAPPING_WARNING';

/** Split "[MAPPING_ERROR] message…" into badge + reason text. */
export function parseSyncError(raw: string): { category: string | null; reason: string } {
  const match = /^\[([A-Z_]+)\]\s*(.*)$/s.exec(raw);
  if (!match) return { category: null, reason: raw };
  return { category: match[1], reason: match[2] || 'Unknown error' };
}

export function ZohoErrorCategoryChip({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  const { category } = parseSyncError(error);
  if (!category) return null;
  return (
    <span className="inline-flex items-center rounded bg-danger/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-danger">
      {category}
    </span>
  );
}

export function ZohoSyncCard({
  expense,
  record,
  recordKind = 'expense',
  onRetry,
  retrying = false,
}: {
  expense?: ZohoSyncCardExpense;
  record?: ZohoSyncRecord;
  recordKind?: ZohoRecordKind;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const sync: ZohoSyncRecord = record ?? {
    status: expense!.status,
    zohoRecordId: expense!.zohoExpenseId,
    zohoSyncedAt: expense!.zohoSyncedAt,
    zohoSyncError: expense!.zohoSyncError,
    integrationStatus: expense!.integrationStatus,
  };

  const idLabel = recordKind === 'purchase_order' ? 'Zoho PO ID' : 'Zoho Expense ID';
  const synced = !!sync.zohoRecordId || sync.integrationStatus === 'synced';
  const failed = !synced && (
    sync.integrationStatus === 'failed'
    || sync.status === 'zoho_sync_failed'
  );
  const syncing = !synced && !failed && (
    sync.integrationStatus === 'syncing' || sync.integrationStatus === 'queued'
  );
  // A synced record can still carry a warning: Zoho accepted the push but stored
  // different accounts than Midas sent (integration-service brand override).
  const syncedWarning = synced && sync.zohoSyncError ? parseSyncError(sync.zohoSyncError) : null;
  const mappingWarning = syncedWarning?.category === MAPPING_WARNING_CATEGORY
    ? syncedWarning.reason
    : null;

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-4 shadow-panel">
      <h2 className="mb-2 font-display text-sm font-semibold text-ink">Zoho</h2>

      {synced ? (
        <div className="space-y-1.5">
          <p className="flex items-center gap-2 text-sm font-medium text-success">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Created
          </p>
          {sync.zohoSyncedAt && (
            <p className="pl-6 text-xs text-charcoal/50">
              {new Date(sync.zohoSyncedAt).toLocaleString()}
            </p>
          )}
          {sync.zohoRecordId && (
            <p className="pl-6 text-xs text-charcoal/50">
              {idLabel}: <span className="font-mono text-ink">{sync.zohoRecordId}</span>
            </p>
          )}
          {mappingWarning && (
            <div className="ml-6 mt-1 rounded-lg border border-amber-300/60 bg-amber-50 p-2">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                Posted with different accounts
              </p>
              <p className="mt-1 text-[11px] leading-snug text-amber-900/80">{mappingWarning}</p>
            </div>
          )}
        </div>
      ) : failed ? (
        <FailedBody
          zohoSyncError={sync.zohoSyncError ?? null}
          onRetry={onRetry}
          retrying={retrying}
        />
      ) : syncing ? (
        <p className="flex items-center gap-2 text-sm text-charcoal/55">
          <Circle className="h-4 w-4 shrink-0 animate-pulse text-brand-400" />
          Sync in progress…
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-charcoal/40">
          <Circle className="h-4 w-4 shrink-0 text-charcoal/25" />
          Not pushed yet
          {sync.integrationStatus && sync.integrationStatus !== 'not_required' && (
            <span className="text-xs text-charcoal/40">({sync.integrationStatus})</span>
          )}
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
      <p className="flex items-center gap-2 text-sm font-medium text-amber-800">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
        Sync failed
      </p>
      <div className="pl-6 text-xs text-charcoal/60">
        <span className="font-semibold text-charcoal/50">Reason: </span>
        {category && (
          <span className="mr-1 inline-flex items-center rounded bg-danger/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-danger">
            {category}
          </span>
        )}
        <span className="text-danger">{reason}</span>
      </div>
      {onRetry && (
        <div className="pl-6">
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="rounded-lg border border-brand-500/30 bg-brand-500/10 px-3 py-1.5 text-xs font-semibold text-brand-800 hover:bg-brand-500/15 disabled:opacity-50"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
    </div>
  );
}
