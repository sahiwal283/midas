import { useState, useEffect, useRef } from 'react';
import type {
  CaptureResult,
  PendingCapture,
  PaymentMethodOption,
  CompanyOption,
  ExpenseAccountOption,
  CaptureMode,
} from '../shared/types';
import { PENDING_CAPTURE_KEY } from '../shared/types';
import { describeItems } from '../shared/pageData';
import { getConfig } from '../shared/config';
import { api, ApiError } from './api';
import { SearchableSelect } from './SearchableSelect';

// ── State machine ─────────────────────────────────────────────────────────────

type Screen =
  | { id: 'home' }
  | { id: 'starting' }
  | { id: 'expense_prepare'; label: string }
  | { id: 'expense_form' }
  | { id: 'submitting'; label: string }
  | { id: 'expense_done'; outcome: 'auto_pushed' | 'approved' | 'pending'; expenseId: string }
  | { id: 'error'; message: string; isAuth: boolean; retry: (() => void) | null };

interface ExpenseForm {
  merchant: string;
  amount: string;
  date: string;
  paymentMethodId: string;
  company: string;
  zohoExpenseAccountId: string;
  zohoExpenseAccountName: string;
  description: string;
  referenceNumber: string;
}

const DEFAULT_FORM: ExpenseForm = {
  merchant: '',
  amount: '',
  date: new Date().toISOString().slice(0, 10),
  paymentMethodId: '',
  company: '',
  zohoExpenseAccountId: '',
  zohoExpenseAccountName: '',
  description: '',
  referenceNumber: '',
};

// ── Root component ────────────────────────────────────────────────────────────

export function PopupApp() {
  const [screen, setScreen] = useState<Screen>({ id: 'home' });
  const [midasWebUrl, setMidasWebUrl] = useState('http://localhost:5173');

  // Quick-expense pipeline state (survives across screens within this popup).
  const [capture, setCapture] = useState<CaptureResult | null>(null);
  const [form, setForm] = useState<ExpenseForm>(DEFAULT_FORM);
  const [ocrMissing, setOcrMissing] = useState(false);
  /** Which fields were prefilled, and by what — shown as a marker on the form. */
  const [fieldSources, setFieldSources] = useState<Record<string, 'page' | 'receipt'>>({});
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodOption[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [formError, setFormError] = useState('');
  const draftIdRef = useRef<string | null>(null);
  const receiptUploadedRef = useRef(false);

  useEffect(() => {
    getConfig().then((c) => setMidasWebUrl(c.midasUrl));
    void chrome.action.setBadgeText({ text: '' });

    // The service worker parks the finished (cropped) capture in
    // storage.session while the popup is closed — resume the flow from it.
    chrome.storage.session.get(PENDING_CAPTURE_KEY).then((stored) => {
      const pending = stored[PENDING_CAPTURE_KEY] as PendingCapture | undefined;
      if (!pending) return;
      void chrome.storage.session.remove(PENDING_CAPTURE_KEY);
      setCapture(pending.capture);
      void runExpensePrepare(pending.capture);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Capture start ───────────────────────────────────────────────────────────

  async function startCapture(mode: CaptureMode = 'crop') {
    setScreen({ id: 'starting' });
    const res = await sendMessage<{ ok?: boolean; error?: string }>({
      type: 'START_CAPTURE',
      intent: 'expense',
      mode,
    });
    if (res?.error) {
      setScreen({ id: 'error', message: res.error, isAuth: false, retry: () => setScreen({ id: 'home' }) });
      return;
    }
    // The crop overlay is now up on the page; this popup closes and reopens
    // (service worker) once the user confirms or skips the crop.
    window.close();
  }

  /**
   * PDF upload and clipboard paste both land here: no tab snapshot, no crop —
   * the file itself is the receipt, so it goes straight into the same
   * draft → upload → OCR → form pipeline.
   */
  async function startFileCapture(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      setScreen({ id: 'error', message: 'That file is larger than 10 MB.', isAuth: false, retry: () => setScreen({ id: 'home' }) });
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result: CaptureResult = {
        imageDataUrl: dataUrl,
        pageUrl: tab?.url ?? '',
        pageTitle: tab?.title ?? file.name,
        fileName: file.name,
        mimeType: file.type,
        // A pasted image or uploaded PDF is its own document — page scraping
        // would describe whatever tab happens to be open, not this receipt.
        pageData: null,
      };
      setCapture(result);
      await runExpensePrepare(result);
    } catch (err) {
      setScreen({
        id: 'error',
        message: err instanceof Error ? err.message : 'Could not read that file',
        isAuth: false,
        retry: () => setScreen({ id: 'home' }),
      });
    }
  }

  // ── Quick expense pipeline ──────────────────────────────────────────────────

  /** Draft + receipt upload + reference data, with per-step resume on retry. */
  /**
   * Fill the form from page-extracted data. Runs before any network call, so
   * the form is populated the instant the popup opens.
   */
  function applyPageData(c: CaptureResult): Set<string> {
    const pd = c.pageData;
    const filled = new Set<string>();
    if (!pd) return filled;

    setForm((f) => {
      const next = { ...f };
      if (pd.merchant?.value) { next.merchant = pd.merchant.value; filled.add('merchant'); }
      if (pd.amount?.value != null) { next.amount = String(pd.amount.value); filled.add('amount'); }
      if (pd.date?.value) { next.date = pd.date.value; filled.add('date'); }
      if (pd.reference?.value) { next.referenceNumber = pd.reference.value; filled.add('referenceNumber'); }
      const items = describeItems(pd.items);
      if (items && !next.description.trim()) { next.description = items; filled.add('description'); }
      return next;
    });

    if (filled.size > 0) {
      setFieldSources((prev) => {
        const next = { ...prev };
        filled.forEach((k) => { next[k] = 'page'; });
        return next;
      });
    }
    return filled;
  }

  async function runExpensePrepare(c: CaptureResult) {
    // Page data first — it costs nothing and is exact where it exists.
    const fromPage = applyPageData(c);
    try {
      let draftId = draftIdRef.current;
      if (!draftId) {
        setScreen({ id: 'expense_prepare', label: 'Creating draft…' });
        const draft = await api.createDraft();
        draftId = draft.id;
        draftIdRef.current = draftId;
      }

      if (!receiptUploadedRef.current) {
        setScreen({ id: 'expense_prepare', label: 'Reading receipt…' });
        const receipt = await api.uploadReceipt(draftId, c.imageDataUrl, c.fileName);
        receiptUploadedRef.current = true;
        const fields = receipt.ocrData?.fields;
        if (fields && (fields.merchant?.value || fields.amount?.value != null || fields.date?.value)) {
          // Page data wins: the DOM carries the exact figure, OCR is vision on
          // an image. OCR only fills fields the page could not provide.
          const usedOcr = new Set<string>();
          setForm((f) => {
            const next = { ...f };
            if (!fromPage.has('merchant') && fields.merchant?.value) {
              next.merchant = fields.merchant.value; usedOcr.add('merchant');
            }
            if (!fromPage.has('amount') && fields.amount?.value != null) {
              next.amount = String(fields.amount.value); usedOcr.add('amount');
            }
            if (!fromPage.has('date') && fields.date?.value) {
              next.date = fields.date.value; usedOcr.add('date');
            }
            if (!fromPage.has('referenceNumber') && !f.referenceNumber.trim() && fields.referenceNumber?.value) {
              next.referenceNumber = fields.referenceNumber.value; usedOcr.add('referenceNumber');
            }
            return next;
          });
          setFieldSources((prev) => {
            const next = { ...prev };
            usedOcr.forEach((k) => { next[k] = 'receipt'; });
            return next;
          });
          setOcrMissing(false);
        } else {
          setOcrMissing(fromPage.size === 0);
        }
      }

      // Reference data is best-effort: a failure hides the affected select
      // rather than blocking the form.
      const [pms, cos] = await Promise.all([
        api.paymentMethods().catch(() => [] as PaymentMethodOption[]),
        api.companies().catch(() => [] as CompanyOption[]),
      ]);
      setPaymentMethods(pms);
      setCompanies(cos);
      setScreen({ id: 'expense_form' });
    } catch (err) {
      const isAuth = err instanceof ApiError && err.isAuth;
      setScreen({
        id: 'error',
        message: err instanceof Error ? err.message : 'Could not prepare the expense',
        isAuth,
        retry: () => void runExpensePrepare(c),
      });
    }
  }

  async function submitExpense() {
    const id = draftIdRef.current;
    if (!id) return;
    setFormError('');
    setScreen({ id: 'submitting', label: 'Submitting expense…' });
    try {
      const selectedCompany = companies.find((co) => co.name === form.company);
      const zohoOn = selectedCompany ? selectedCompany.zohoEnabled : false;
      await api.updateExpense(id, {
        merchant: form.merchant.trim(),
        amount: Number(form.amount),
        date: form.date,
        paymentMethodId: form.paymentMethodId || undefined,
        zohoEntity: form.company || undefined,
        zohoExpenseAccountId: (zohoOn && form.zohoExpenseAccountId) || undefined,
        zohoExpenseAccountName: (zohoOn && form.zohoExpenseAccountName) || undefined,
        description: form.description.trim() || undefined,
        referenceNumber: form.referenceNumber.trim() || undefined,
      });
      const submitted = await api.submitExpense(id);
      const outcome = submitted.autoPushed
        ? 'auto_pushed'
        : submitted.expense.status === 'approved'
          ? 'approved'
          : 'pending';
      setScreen({ id: 'expense_done', outcome, expenseId: id });
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) {
        setScreen({ id: 'error', message: err.message, isAuth: true, retry: () => setScreen({ id: 'expense_form' }) });
        return;
      }
      // Keep the filled form; show the error inline with a retry affordance.
      setFormError(err instanceof Error ? err.message : 'Submission failed');
      setScreen({ id: 'expense_form' });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Shell midasWebUrl={midasWebUrl}>
      {screen.id === 'home' && (
        <HomeScreen
          onCrop={() => void startCapture('crop')}
          onFullPage={() => void startCapture('full')}
          onFile={(f) => void startFileCapture(f)}
        />
      )}

      {screen.id === 'starting' && <Spinner label="Capturing page…" />}

      {screen.id === 'expense_prepare' && <Spinner label={screen.label} />}

      {screen.id === 'expense_form' && capture && (
        <ExpenseFormScreen
          capture={capture}
          form={form}
          setForm={setForm}
          ocrMissing={ocrMissing}
          fieldSources={fieldSources}
          paymentMethods={paymentMethods}
          companies={companies}
          error={formError}
          onSubmit={submitExpense}
        />
      )}

      {screen.id === 'submitting' && <Spinner label={screen.label} />}

      {screen.id === 'expense_done' && (
        <SuccessScreen
          title={
            screen.outcome === 'auto_pushed'
              ? 'Approved — sent to accounting'
              : screen.outcome === 'approved'
                ? 'Approved'
                : 'Submitted for review'
          }
          body={
            screen.outcome === 'pending'
              ? "It's now in the accountant review queue. You'll be notified of any updates."
              : screen.outcome === 'auto_pushed'
                ? 'Your expense was complete, so it was approved and pushed to accounting automatically.'
                : 'Your expense was approved automatically.'
          }
          midasPath={`/expenses/${screen.expenseId}`}
          midasWebUrl={midasWebUrl}
          onAnother={() => setScreen({ id: 'home' })}
        />
      )}

      {screen.id === 'error' && (
        <ErrorScreen
          message={screen.message}
          isAuth={screen.isAuth}
          midasWebUrl={midasWebUrl}
          onRetry={screen.retry ?? (() => setScreen({ id: 'home' }))}
        />
      )}
    </Shell>
  );
}

// ── Screens ───────────────────────────────────────────────────────────────────

function HomeScreen({
  onCrop,
  onFullPage,
  onFile,
}: {
  onCrop: () => void;
  onFullPage: () => void;
  onFile: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pasteHint, setPasteHint] = useState('Paste a screenshot (⌘V / Ctrl+V)');

  // A real paste event carries the image — no clipboardRead permission needed.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      setPasteHint('Reading pasted image…');
      onFile(file);
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [onFile]);

  return (
    <div style={{ padding: '4px 0' }}>
      <p style={styles.hint}>File an expense from this page, a PDF, or your clipboard.</p>

      <ActionCard
        title="Crop this page"
        description="Drag a rectangle around the receipt — order details are read from the page automatically."
        onClick={onCrop}
        primary
      />
      <ActionCard
        title="Capture whole page"
        description="Snapshot the visible tab without cropping."
        onClick={onFullPage}
      />
      <ActionCard
        title="Upload a PDF"
        description="For emailed invoices and downloaded receipts."
        onClick={() => fileRef.current?.click()}
      />
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      <p style={{ ...styles.hint, textAlign: 'center', marginTop: 10, marginBottom: 0 }}>{pasteHint}</p>
    </div>
  );
}

/** File → data URL, the shape the receipt upload already expects. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}

function ExpenseFormScreen({
  capture,
  form,
  setForm,
  ocrMissing,
  fieldSources,
  paymentMethods,
  companies,
  error,
  onSubmit,
}: {
  capture: CaptureResult;
  form: ExpenseForm;
  setForm: React.Dispatch<React.SetStateAction<ExpenseForm>>;
  ocrMissing: boolean;
  fieldSources: Record<string, 'page' | 'receipt'>;
  paymentMethods: PaymentMethodOption[];
  companies: CompanyOption[];
  error: string;
  onSubmit: () => void;
}) {
  const [accounts, setAccounts] = useState<ExpenseAccountOption[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsFailed, setAccountsFailed] = useState(false);

  const selectedCompany = companies.find((c) => c.name === form.company);
  const zohoOn = !!selectedCompany?.zohoEnabled;

  // Zoho expense categories, only for zoho-enabled companies. A load failure
  // degrades gracefully: the select is simply hidden.
  useEffect(() => {
    if (!form.company || !zohoOn) {
      setAccounts([]);
      setAccountsFailed(false);
      return;
    }
    let cancelled = false;
    setAccountsLoading(true);
    setAccountsFailed(false);
    api.expenseAccounts(form.company)
      .then((rows) => {
        if (!cancelled) setAccounts(rows);
      })
      .catch(() => {
        if (!cancelled) {
          setAccounts([]);
          setAccountsFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setAccountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form.company, zohoOn]);

  function set<K extends keyof ExpenseForm>(k: K, v: ExpenseForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function setPaymentMethod(pmId: string) {
    const pm = paymentMethods.find((p) => p.id === pmId);
    setForm((f) => {
      // Auto-select the card's default company — only when it matches a real
      // company and the user hasn't picked one already.
      const matches = pm?.defaultZohoEntity && companies.some((c) => c.name === pm.defaultZohoEntity);
      const nextCompany = f.company || (matches ? pm!.defaultZohoEntity! : '');
      const changed = nextCompany !== f.company;
      return {
        ...f,
        paymentMethodId: pmId,
        company: nextCompany,
        ...(changed ? { zohoExpenseAccountId: '', zohoExpenseAccountName: '' } : {}),
      };
    });
  }

  function setCompany(name: string) {
    setForm((f) => ({ ...f, company: name, zohoExpenseAccountId: '', zohoExpenseAccountName: '' }));
  }

  function setAccount(accountId: string) {
    const account = accounts.find((a) => a.accountId === accountId);
    setForm((f) => ({
      ...f,
      zohoExpenseAccountId: accountId,
      zohoExpenseAccountName: account?.accountName ?? '',
    }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.merchant.trim() || !form.amount || Number(form.amount) <= 0) return;
    onSubmit();
  }

  return (
    <div>
      {/* Receipt thumbnail — a PDF has no inline preview, so name it instead. */}
      {capture.mimeType === 'application/pdf' ? (
        <div style={{ ...styles.preview, maxHeight: 110, background: '#f9fafb', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 4, padding: 12 }}>
          <span style={{ fontSize: 22 }}>📄</span>
          <span style={{ fontSize: 11, color: '#6b7280', wordBreak: 'break-all', textAlign: 'center' }}>
            {capture.fileName ?? 'receipt.pdf'}
          </span>
        </div>
      ) : (
        <img src={capture.imageDataUrl} alt="Receipt preview" style={{ ...styles.preview, maxHeight: 110, objectFit: 'contain', background: '#f9fafb' }} />
      )}
      <p style={styles.pageInfo}>{capture.pageTitle || capture.pageUrl}</p>

      {ocrMissing && (
        <p style={{ fontSize: 11, color: '#92400e', background: '#fef3c7', borderRadius: 6, padding: '6px 8px', marginBottom: 8, lineHeight: 1.4 }}>
          We couldn't read the receipt automatically — fill in the details below.
        </p>
      )}

      {error && (
        <p style={{ fontSize: 12, color: '#dc2626', background: '#fef2f2', borderRadius: 6, padding: '6px 8px', marginBottom: 8, lineHeight: 1.4 }}>
          {error} — check the fields and try again.
        </p>
      )}

      <form onSubmit={handleSubmit} style={{ marginTop: 6 }}>
        <Field label="Merchant *" source={fieldSources.merchant}>
          <input
            required
            value={form.merchant}
            onChange={(e) => set('merchant', e.target.value)}
            placeholder="Amazon, Uber, Coffee Shop…"
            style={styles.input}
          />
        </Field>

        <div style={styles.row}>
          <Field label="Amount (USD) *" source={fieldSources.amount} style={{ flex: 1 }}>
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              value={form.amount}
              onChange={(e) => set('amount', e.target.value)}
              placeholder="0.00"
              style={styles.input}
            />
          </Field>
          <Field label="Date *" source={fieldSources.date} style={{ flex: 1 }}>
            <input
              required
              type="date"
              value={form.date}
              onChange={(e) => set('date', e.target.value)}
              style={styles.input}
            />
          </Field>
        </div>

        {paymentMethods.length > 0 && (
          <Field label="Payment method">
            <select value={form.paymentMethodId} onChange={(e) => setPaymentMethod(e.target.value)} style={styles.input}>
              <option value="">— Select card (optional) —</option>
              {paymentMethods.map((pm) => (
                <option key={pm.id} value={pm.id}>
                  {pm.label}{pm.lastFour ? ` ····${pm.lastFour}` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}

        {companies.length > 0 && (
          <Field label="Company">
            <select value={form.company} onChange={(e) => setCompany(e.target.value)} style={styles.input}>
              <option value="">— Select company (optional) —</option>
              {companies.map((c) => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
          </Field>
        )}

        {zohoOn && accountsLoading && (
          <p style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10 }}>Loading expense categories…</p>
        )}
        {zohoOn && !accountsLoading && !accountsFailed && accounts.length > 0 && (
          <Field label="Expense category">
            <SearchableSelect
              value={form.zohoExpenseAccountId}
              onChange={setAccount}
              placeholder="Search categories…"
              style={styles.input}
              options={accounts.map((a) => ({ value: a.accountId, label: a.accountName }))}
            />
          </Field>
        )}

        <Field label="Reference number" source={fieldSources.referenceNumber}>
          <input
            value={form.referenceNumber}
            onChange={(e) => set('referenceNumber', e.target.value)}
            placeholder="Receipt #, invoice #, sales order…"
            maxLength={50}
            style={styles.input}
          />
        </Field>

        <Field label="Notes">
          <input
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Optional description"
            style={styles.input}
          />
        </Field>

        <Btn type="submit" primary flex disabled={!form.merchant.trim() || !form.amount || Number(form.amount) <= 0}>
          Submit Expense
        </Btn>
      </form>

      <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 10, lineHeight: 1.4 }}>
        Complete expenses may be approved and sent to accounting automatically; anything else goes to accountant review.
      </p>
    </div>
  );
}

function SuccessScreen({
  title,
  body,
  midasPath,
  midasWebUrl,
  onAnother,
}: {
  title: string;
  body: string;
  midasPath: string;
  midasWebUrl: string;
  onAnother: () => void;
}) {
  function openMidas() {
    chrome.tabs.create({ url: `${midasWebUrl}${midasPath}` });
    window.close();
  }

  return (
    <div style={{ textAlign: 'center', padding: '8px 0' }}>
      <p style={{ fontWeight: 700, fontSize: 15, color: '#15803d', marginBottom: 6 }}>{title}</p>
      <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 16, lineHeight: 1.5 }}>{body}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Btn onClick={openMidas} primary>Open in Midas</Btn>
        <Btn onClick={onAnother}>Done</Btn>
      </div>
    </div>
  );
}

function ErrorScreen({
  message,
  isAuth,
  midasWebUrl,
  onRetry,
}: {
  message: string;
  isAuth: boolean;
  midasWebUrl: string;
  onRetry: () => void;
}) {
  function openLogin() {
    chrome.tabs.create({ url: `${midasWebUrl}/login` });
    window.close();
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: '#dc2626', marginBottom: 8, fontWeight: 600 }}>
        {isAuth ? 'Not logged in to Midas' : 'Something went wrong'}
      </p>
      <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 14, lineHeight: 1.5 }}>{message}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {isAuth && <Btn onClick={openLogin} primary>Log in to Midas</Btn>}
        <Btn onClick={onRetry} primary={!isAuth}>Try again</Btn>
      </div>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '16px 0' }}>
      <p style={{ fontSize: 13, color: '#6b7280' }}>{label}</p>
    </div>
  );
}

// ── Layout primitives ─────────────────────────────────────────────────────────

function Shell({ children, midasWebUrl: _midasWebUrl }: { children: React.ReactNode; midasWebUrl: string }) {
  return (
    <div style={{ padding: 14, fontFamily: 'system-ui, -apple-system, sans-serif', minHeight: 120 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, borderBottom: '1px solid #f3f4f6', paddingBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 800, fontSize: 16, color: '#7c5831' }}>Midas</span>
        </div>
        <button
          onClick={() => chrome.runtime.openOptionsPage()}
          title="Settings"
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#9ca3af', padding: 2 }}
        >
          Settings
        </button>
      </div>
      {children}
    </div>
  );
}

function ActionCard({ title, description, onClick, primary }: { title: string; description: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        padding: '10px 12px',
        marginBottom: 8,
        border: primary ? '2px solid #9a6f3b' : '1px solid #e5e7eb',
        borderRadius: 10,
        background: primary ? '#fdf8f3' : 'white',
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <p style={{ fontSize: 14, fontWeight: 700, color: primary ? '#7c5831' : '#111827', margin: 0 }}>{title}</p>
      <p style={{ fontSize: 11, color: '#6b7280', margin: '2px 0 0', lineHeight: 1.4 }}>{description}</p>
    </button>
  );
}

function Field({
  label,
  children,
  style,
  source,
}: {
  label: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
  /** Shows where a prefilled value came from, so a wrong one is traceable. */
  source?: 'page' | 'receipt';
}) {
  return (
    <div style={{ marginBottom: 10, ...style }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 3 }}>
        {label}
        {source && (
          <span
            title={source === 'page' ? 'Read from the page' : 'Read from the receipt image'}
            style={{
              fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
              padding: '1px 4px', borderRadius: 3,
              background: source === 'page' ? '#e0f2fe' : '#f3e8ff',
              color: source === 'page' ? '#075985' : '#6b21a8',
            }}
          >
            {source === 'page' ? 'page' : 'receipt'}
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

function Btn({
  onClick,
  children,
  primary,
  flex,
  disabled,
  type = 'button',
}: {
  onClick?: () => void;
  children: React.ReactNode;
  primary?: boolean;
  flex?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '8px 12px',
        borderRadius: 8,
        border: primary ? 'none' : '1px solid #d1d5db',
        background: primary ? '#9a6f3b' : 'white',
        color: primary ? 'white' : '#374151',
        fontSize: 13,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        flex: flex ? 1 : undefined,
        width: flex ? undefined : '100%',
      }}
    >
      {children}
    </button>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendMessage<T>(message: object): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res: T) => resolve(res));
  });
}

// ── Inline styles ─────────────────────────────────────────────────────────────

const styles = {
  hint: { fontSize: 12, color: '#9ca3af', marginBottom: 10 } as React.CSSProperties,
  preview: { width: '100%', borderRadius: 8, border: '1px solid #e5e7eb', marginBottom: 6, display: 'block' } as React.CSSProperties,
  pageInfo: { fontSize: 11, color: '#9ca3af', marginBottom: 6, wordBreak: 'break-all', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' } as React.CSSProperties,
  row: { display: 'flex', gap: 8, alignItems: 'flex-start' } as React.CSSProperties,
  input: { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '6px 9px', fontSize: 13, outline: 'none', boxSizing: 'border-box' } as React.CSSProperties,
};
