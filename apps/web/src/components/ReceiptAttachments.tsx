import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Paperclip, Upload, X, RotateCw } from 'lucide-react';
import { expenseApi, transactionReceiptApi } from '../api/expenses';
import { compressReceiptImage } from '../lib/receiptCompress';
import {
  MAX_RECEIPTS, acceptFiles, isBatchedUpload, mergeSlots, type BatchSlot,
} from '../lib/receiptBatch';
import { ReceiptPreview } from './ReceiptPreview';
import type { Receipt } from '../types';

type Props = {
  kind: 'expense' | 'transaction';
  /** null until a draft exists — `ensureOwnerId` creates one on first pick. */
  ownerId: string | null;
  ensureOwnerId: () => Promise<string>;
  /** Fires once, for the first receipt to land on an owner that had none. */
  onFirstReceipt?: (receipt: Receipt) => void;
  /** Anything that has to refetch beyond the receipts list (expense flags). */
  onChange?: () => void;
  /**
   * True while any slot is uploading (a fresh pick or a retry), false the
   * instant none are — including right after a failure. Lets a form gate its
   * own submit button on "is anything still on the wire" without re-deriving
   * upload state itself.
   */
  onBusyChange?: (busy: boolean) => void;
  readOnly?: boolean;
};

function apiMessage(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: { message?: string } } } })
    ?.response?.data?.error?.message;
}

function uploadMessage(err: unknown): string {
  if ((err as { response?: { status?: number } })?.response?.status === 413) {
    return 'That photo is too large (max 10 MB). Retake it or pick a smaller image.';
  }
  return apiMessage(err) ?? 'Upload failed. Tap retry.';
}

export function ReceiptAttachments({
  kind, ownerId, ensureOwnerId, onFirstReceipt, onChange, onBusyChange, readOnly = false,
}: Props) {
  const qc = useQueryClient();
  const [slots, setSlots] = useState<BatchSlot[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  // Guards onFirstReceipt against firing twice when two picks race.
  const firstFired = useRef(false);

  const queryKey = kind === 'expense'
    ? ['expense-receipts', ownerId]
    : ['transaction-receipts', ownerId];

  const receiptsQ = useQuery({
    queryKey,
    queryFn: () => (kind === 'expense'
      ? expenseApi.listReceipts(ownerId!)
      : transactionReceiptApi.list(ownerId!)),
    enabled: !!ownerId,
  });

  const serverReceipts = receiptsQ.data ?? [];
  const items = mergeSlots(serverReceipts, slots);
  const count = items.length;

  // Mirrors `slots` for the unmount cleanup below — a `useEffect` cleanup
  // closes over whatever `slots` was on the render that registered it, so a
  // plain closure over `slots` here would revoke stale (already-superseded)
  // URLs instead of whatever is actually outstanding at unmount time.
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  useEffect(() => () => {
    for (const s of slotsRef.current) {
      if (s.state === 'uploading' && s.previewUrl) URL.revokeObjectURL(s.previewUrl);
    }
  }, []);

  // Derived rather than toggled by hand at each call site: a slot can leave
  // 'uploading' via success, failure, or a retry re-entering it, and deriving
  // from the current slots on every change is the only way that can't miss one.
  useEffect(() => {
    onBusyChange?.(slots.some((s) => s.state === 'uploading'));
  }, [slots, onBusyChange]);

  // Takes the resolved owner id explicitly rather than closing over the
  // `ownerId` prop: on the creation forms `ownerId` is still null at the
  // moment a batch starts (`ensureOwnerId` mints it mid-flight), so a
  // closure-captured `queryKey`/`ownerId` would invalidate
  // ['expense-receipts', null] — a no-op — while the real, now-populated
  // query for the id that was actually used never gets invalidated.
  function refresh(id: string) {
    const key = kind === 'expense' ? ['expense-receipts', id] : ['transaction-receipts', id];
    void qc.invalidateQueries({ queryKey: key });
    onChange?.();
  }

  async function uploadOne(id: string, file: File, batch: boolean): Promise<Receipt> {
    const compressed = await compressReceiptImage(file);
    if (kind === 'expense') {
      return expenseApi.uploadReceipt(id, compressed, { batch });
    }
    const { receipt } = await transactionReceiptApi.upload(id, compressed, { batch });
    return receipt;
  }

  /**
   * Uploads run SEQUENTIALLY, not in parallel: `uploadedAt` decides page order
   * in the merged PDF that reaches Zoho, and the single unbatched upload has to
   * genuinely be the last one so the auto-push check sees every receipt.
   */
  async function addFiles(picked: File[]) {
    setNotice(null);
    const { accepted, rejected } = acceptFiles(picked, count);
    if (rejected.length) {
      setNotice(`Only ${MAX_RECEIPTS} images per entry — not added: ${rejected.join(', ')}`);
    }
    if (!accepted.length) return;

    // Not annotated as `BatchSlot[]`: that would widen every element to the
    // full union and lose the `name` field TypeScript needs below (only the
    // `uploading`/`failed` variants carry it — `done` doesn't). Letting
    // inference keep the literal `'uploading'` sub-type is still assignable
    // wherever a `BatchSlot` is expected.
    const staged = accepted.map((file, i) => ({
      state: 'uploading' as const,
      localId: `${Date.now()}-${i}-${file.name}`,
      name: file.name,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    }));
    setSlots((prev) => [...prev, ...staged]);

    /**
     * Mark one staged slot failed, keeping its File so Retry can resend it.
     * Takes the staged slot itself (not just its localId) so it can revoke
     * that slot's preview URL — once the slot leaves `uploading`, the
     * `BatchSlot` union no longer carries `previewUrl`, so this is the last
     * point a reference to it exists.
     */
    const fail = (slot: (typeof staged)[number], file: File, name: string, error: string) => {
      if (slot.previewUrl) URL.revokeObjectURL(slot.previewUrl);
      setSlots((prev) => prev.map((s) => (
        s.localId === slot.localId ? { state: 'failed', localId: slot.localId, name, file, error } : s
      )));
    };

    let id: string;
    try {
      id = await ensureOwnerId();
    } catch (err) {
      const message = apiMessage(err) ?? 'Could not start this entry. Please try again.';
      staged.forEach((slot, i) => fail(slot, accepted[i], slot.name, message));
      return;
    }

    const hadNone = serverReceipts.length === 0;
    for (let i = 0; i < accepted.length; i += 1) {
      const slot = staged[i];
      try {
        const receipt = await uploadOne(id, accepted[i], isBatchedUpload(i, accepted.length));
        if (slot.previewUrl) URL.revokeObjectURL(slot.previewUrl);
        setSlots((prev) => prev.map((s) => (
          s.localId === slot.localId ? { state: 'done', localId: s.localId, receipt } : s
        )));
        if (hadNone && i === 0 && !firstFired.current) {
          firstFired.current = true;
          onFirstReceipt?.(receipt);
        }
      } catch (err) {
        fail(slot, accepted[i], slot.name, uploadMessage(err));
      }
    }
    refresh(id);
  }

  /**
   * A retry is the last upload of its own batch of one — never batched.
   *
   * Calls `ensureOwnerId()` rather than reading the `ownerId` prop: a retry
   * can happen while `ownerId` is still null (the draft's very first pick
   * failed before a draft existed, but the file was kept for Retry), and
   * reading the prop directly would leave Retry permanently dead — the only
   * escape being Discard and re-pick.
   */
  async function retry(slot: Extract<BatchSlot, { state: 'failed' }>) {
    setSlots((prev) => prev.map((s) => (
      s.localId === slot.localId
        ? { state: 'uploading', localId: s.localId, name: slot.name, previewUrl: null }
        : s
    )));
    let id: string;
    try {
      id = await ensureOwnerId();
    } catch (err) {
      const message = apiMessage(err) ?? 'Could not start this entry. Please try again.';
      setSlots((prev) => prev.map((s) => (
        s.localId === slot.localId
          ? { state: 'failed', localId: s.localId, name: slot.name, file: slot.file, error: message }
          : s
      )));
      return;
    }
    try {
      const receipt = await uploadOne(id, slot.file, false);
      setSlots((prev) => prev.map((s) => (
        s.localId === slot.localId ? { state: 'done', localId: s.localId, receipt } : s
      )));
      refresh(id);
    } catch (err) {
      setSlots((prev) => prev.map((s) => (
        s.localId === slot.localId
          ? { state: 'failed', localId: s.localId, name: slot.name, file: slot.file, error: uploadMessage(err) }
          : s
      )));
    }
  }

  async function removeReceipt(receiptId: string) {
    if (!ownerId) return;
    setNotice(null);
    try {
      if (kind === 'expense') await expenseApi.deleteReceipt(ownerId, receiptId);
      else await transactionReceiptApi.delete(ownerId, receiptId);
      setSlots((prev) => prev.filter((s) => !(s.state === 'done' && s.receipt.id === receiptId)));
      refresh(ownerId);
    } catch (err) {
      setNotice(apiMessage(err) ?? 'Could not remove that receipt.');
    }
  }

  function handlePick(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (picked.length) void addFiles(picked);
  }

  const full = count >= MAX_RECEIPTS;

  return (
    <div>
      {!readOnly && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={full}
            onClick={() => cameraRef.current?.click()}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-ink/15 bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-ink/[0.03] disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
          >
            <Camera className="h-3.5 w-3.5" /> Take photo
          </button>
          <button
            type="button"
            disabled={full}
            onClick={() => filesRef.current?.click()}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-ink/15 bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-ink/[0.03] disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
          >
            <Upload className="h-3.5 w-3.5" /> Upload files
          </button>
          <span className="text-xs text-charcoal/40">{count} of {MAX_RECEIPTS}</span>

          {/* One input per entry point on purpose: a single picker offers the
              camera OR the library, never both, so mixing a photo with a file
              needs two. `multiple` only on the file picker — the camera
              returns one shot at a time. */}
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePick} />
          <input ref={filesRef} type="file" accept="image/*,.pdf,.heic,.heif" multiple className="hidden" onChange={handlePick} />
        </div>
      )}

      {notice && (
        <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {notice}
        </p>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-charcoal/40">
          No receipts attached.{!readOnly && ' Take a photo or upload files above — you can add several.'}
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            item.kind === 'attached' ? (
              <div key={item.receipt.id} className="space-y-2 rounded-lg border border-ink/5 bg-cream px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Paperclip className="h-4 w-4 shrink-0 text-charcoal/40" />
                  <span className="flex-1 truncate text-sm text-charcoal/80">{item.receipt.filename}</span>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => void removeReceipt(item.receipt.id)}
                      aria-label={`Remove ${item.receipt.filename}`}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg p-2 text-charcoal/40 hover:bg-brand-50 hover:text-danger lg:min-h-0 lg:min-w-0"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <ReceiptPreview expenseId={ownerId ?? ''} receipt={item.receipt} className="max-h-64" />
              </div>
            ) : (
              <div key={item.slot.localId} className="rounded-lg border border-ink/5 bg-cream px-3 py-2.5">
                {item.slot.state === 'uploading' && (
                  <div className="flex items-center gap-2">
                    {item.slot.previewUrl ? (
                      <img
                        src={item.slot.previewUrl}
                        alt=""
                        className="h-9 w-9 shrink-0 rounded border border-ink/10 object-cover"
                      />
                    ) : (
                      <span className="h-9 w-9 shrink-0 rounded border border-ink/10 bg-ink/5" />
                    )}
                    <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                    <span className="flex-1 truncate text-sm text-charcoal/70">{item.slot.name}</span>
                    <span className="text-xs text-charcoal/40">Uploading…</span>
                  </div>
                )}
                {item.slot.state === 'done' && (
                  <div className="flex items-center gap-2">
                    <Paperclip className="h-4 w-4 shrink-0 text-charcoal/40" />
                    <span className="flex-1 truncate text-sm text-charcoal/80">{item.slot.receipt.filename}</span>
                  </div>
                )}
                {item.slot.state === 'failed' && (
                  <div className="flex items-center gap-2">
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-sm text-charcoal/80">{item.slot.name}</span>
                      <span className="block text-xs text-danger">{item.slot.error}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void retry(item.slot as Extract<BatchSlot, { state: 'failed' }>)}
                      className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-ink/[0.03] lg:min-h-0"
                    >
                      <RotateCw className="h-3.5 w-3.5" /> Retry
                    </button>
                    <button
                      type="button"
                      onClick={() => setSlots((prev) => prev.filter((s) => s.localId !== item.slot.localId))}
                      aria-label={`Discard ${item.slot.name}`}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg p-2 text-charcoal/40 hover:bg-brand-50 hover:text-danger lg:min-h-0 lg:min-w-0"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}
