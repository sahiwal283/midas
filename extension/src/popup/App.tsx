import { useState, useEffect } from 'react';
import type { CaptureResult, ExtensionCategory } from '../shared/types';
import { getConfig } from '../shared/config';

// ── State machine ─────────────────────────────────────────────────────────────

type Screen =
  | { id: 'home' }
  | { id: 'taking_screenshot'; intent: 'capture' | 'expense' }
  | { id: 'capture_preview'; capture: CaptureResult }
  | { id: 'expense_form'; capture: CaptureResult }
  | { id: 'submitting'; label: string }
  | { id: 'capture_success' }
  | { id: 'expense_success'; midasUrl: string; expenseId: string }
  | { id: 'error'; message: string; isAuth: boolean; prev: Screen['id'] };

interface ExpenseForm {
  merchant: string;
  amount: string;
  date: string;
  currency: string;
  categoryId: string;
  description: string;
  reimbursementRequired: boolean;
}

const DEFAULT_FORM: ExpenseForm = {
  merchant: '',
  amount: '',
  date: new Date().toISOString().slice(0, 10),
  currency: 'USD',
  categoryId: '',
  description: '',
  reimbursementRequired: false,
};

// ── Root component ────────────────────────────────────────────────────────────

export function PopupApp() {
  const [screen, setScreen] = useState<Screen>({ id: 'home' });
  const [midasWebUrl, setMidasWebUrl] = useState('http://localhost:5173');

  useEffect(() => {
    getConfig().then((c) => setMidasWebUrl(c.midasUrl));
  }, []);

  async function takeScreenshot(intent: 'capture' | 'expense') {
    setScreen({ id: 'taking_screenshot', intent });

    const res = await sendMessage<{ dataUrl?: string; error?: string }>({ type: 'TAKE_SCREENSHOT' });

    if (res.error || !res.dataUrl) {
      setScreen({ id: 'error', message: res.error ?? 'Screenshot failed', isAuth: false, prev: 'home' });
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const capture: CaptureResult = {
      imageDataUrl: res.dataUrl,
      pageUrl: tab.url ?? '',
      pageTitle: tab.title ?? '',
      selectedText: await getSelectedText(),
    };

    if (intent === 'capture') {
      setScreen({ id: 'capture_preview', capture });
    } else {
      setScreen({ id: 'expense_form', capture });
    }
  }

  async function saveCapture(capture: CaptureResult) {
    setScreen({ id: 'submitting', label: 'Saving capture…' });
    const res = await sendMessage<{ type: string; error?: string; isAuth?: boolean }>({
      type: 'SAVE_CAPTURE',
      result: capture,
    });
    if (res.type === 'SAVE_CAPTURE_SUCCESS') {
      setScreen({ id: 'capture_success' });
    } else {
      setScreen({ id: 'error', message: res.error ?? 'Save failed', isAuth: !!res.isAuth, prev: 'capture_preview' });
    }
  }

  async function submitExpense(capture: CaptureResult, form: ExpenseForm) {
    setScreen({ id: 'submitting', label: 'Submitting expense…' });
    const res = await sendMessage<{ type: string; result?: { expenseId: string; midasUrl: string }; error?: string; isAuth?: boolean }>({
      type: 'SUBMIT_EXPENSE',
      payload: {
        capture,
        merchant: form.merchant,
        amount: Number(form.amount),
        date: form.date,
        currency: form.currency,
        categoryId: form.categoryId || undefined,
        description: form.description || undefined,
        reimbursementRequired: form.reimbursementRequired,
      },
    });

    if (res.type === 'SUBMIT_EXPENSE_SUCCESS' && res.result) {
      setScreen({ id: 'expense_success', midasUrl: res.result.midasUrl, expenseId: res.result.expenseId });
    } else {
      setScreen({ id: 'error', message: res.error ?? 'Submission failed', isAuth: !!res.isAuth, prev: 'expense_form' });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Shell midasWebUrl={midasWebUrl}>
      {screen.id === 'home' && (
        <HomeScreen
          onCapture={() => takeScreenshot('capture')}
          onExpense={() => takeScreenshot('expense')}
        />
      )}

      {screen.id === 'taking_screenshot' && (
        <Spinner label={screen.intent === 'capture' ? 'Capturing page…' : 'Preparing expense…'} />
      )}

      {screen.id === 'capture_preview' && (
        <CapturePreviewScreen
          capture={screen.capture}
          onSave={() => saveCapture(screen.capture)}
          onCancel={() => setScreen({ id: 'home' })}
        />
      )}

      {screen.id === 'expense_form' && (
        <ExpenseFormScreen
          capture={screen.capture}
          onSubmit={(form) => submitExpense(screen.capture, form)}
          onBack={() => setScreen({ id: 'home' })}
        />
      )}

      {screen.id === 'submitting' && <Spinner label={screen.label} />}

      {screen.id === 'capture_success' && (
        <SuccessScreen
          title="Capture saved"
          body="It's waiting in your Captures page. Link it to an expense whenever you're ready."
          midasPath="/captures"
          midasWebUrl={midasWebUrl}
          onAnother={() => setScreen({ id: 'home' })}
        />
      )}

      {screen.id === 'expense_success' && (
        <SuccessScreen
          title="Expense submitted"
          body="It's now in the accountant review queue. You'll be notified of any updates."
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
          onRetry={() => setScreen({ id: 'home' })}
        />
      )}
    </Shell>
  );
}

// ── Screens ───────────────────────────────────────────────────────────────────

function HomeScreen({ onCapture, onExpense }: { onCapture: () => void; onExpense: () => void }) {
  return (
    <div style={{ padding: '4px 0' }}>
      <p style={styles.hint}>What do you want to do with this page?</p>

      <ActionCard
        title="Save Capture"
        description="Screenshot this page and save it to your Midas Captures for later review."
        onClick={onCapture}
      />

      <ActionCard
        title="Submit Expense"
        description="Screenshot this receipt and submit it as a new expense for accountant review."
        onClick={onExpense}
        primary
      />
    </div>
  );
}

function CapturePreviewScreen({ capture, onSave, onCancel }: { capture: CaptureResult; onSave: () => void; onCancel: () => void }) {
  return (
    <div>
      <img src={capture.imageDataUrl} alt="Preview" style={styles.preview} />
      <p style={styles.pageInfo}>{capture.pageTitle || capture.pageUrl}</p>
      {capture.selectedText && (
        <p style={{ ...styles.pageInfo, fontStyle: 'italic' }}>"{capture.selectedText.slice(0, 120)}"</p>
      )}
      <div style={styles.row}>
        <Btn onClick={onSave} primary flex>Save Capture</Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}

function ExpenseFormScreen({
  capture,
  onSubmit,
  onBack,
}: {
  capture: CaptureResult;
  onSubmit: (form: ExpenseForm) => void;
  onBack: () => void;
}) {
  const [form, setForm] = useState<ExpenseForm>({
    ...DEFAULT_FORM,
    // Try to pre-fill merchant from page title (best-effort)
    merchant: guessmerchantFromTitle(capture.pageTitle),
  });
  const [categories, setCategories] = useState<ExtensionCategory[]>([]);

  useEffect(() => {
    sendMessage<{ categories: ExtensionCategory[] }>({ type: 'GET_CATEGORIES' })
      .then((res) => setCategories(res.categories ?? []))
      .catch(() => setCategories([]));
  }, []);

  function set<K extends keyof ExpenseForm>(k: K, v: ExpenseForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.merchant || !form.amount || !form.date) return;
    onSubmit(form);
  }

  return (
    <div>
      {/* Thumbnail */}
      <img src={capture.imageDataUrl} alt="Receipt preview" style={{ ...styles.preview, height: 80, objectFit: 'cover' }} />
      <p style={styles.pageInfo}>{capture.pageTitle || capture.pageUrl}</p>

      <form onSubmit={handleSubmit} style={{ marginTop: 10 }}>
        <Field label="Merchant *">
          <input
            required
            value={form.merchant}
            onChange={(e) => set('merchant', e.target.value)}
            placeholder="Amazon, Uber, Coffee Shop…"
            style={styles.input}
          />
        </Field>

        <div style={styles.row}>
          <Field label="Amount *" style={{ flex: 1 }}>
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
          <Field label="Currency" style={{ width: 72 }}>
            <select value={form.currency} onChange={(e) => set('currency', e.target.value)} style={styles.input}>
              <option>USD</option>
              <option>EUR</option>
              <option>GBP</option>
              <option>CAD</option>
              <option>MXN</option>
            </select>
          </Field>
        </div>

        <Field label="Date *">
          <input
            required
            type="date"
            value={form.date}
            onChange={(e) => set('date', e.target.value)}
            style={styles.input}
          />
        </Field>

        {categories.length > 0 ? (
          <Field label="Category">
            <select value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)} style={styles.input}>
              <option value="">— Select category (optional) —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        ) : (
          <p style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10, lineHeight: 1.4 }}>
            No categories loaded — accountant will assign one during review.
          </p>
        )}

        <Field label="Notes">
          <input
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Optional description"
            style={styles.input}
          />
        </Field>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', marginBottom: 14, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.reimbursementRequired}
            onChange={(e) => set('reimbursementRequired', e.target.checked)}
            style={{ width: 14, height: 14 }}
          />
          Reimbursement required
        </label>

        <div style={styles.row}>
          <Btn type="submit" primary flex disabled={!form.merchant || !form.amount}>Submit Expense</Btn>
          <Btn type="button" onClick={onBack}>Back</Btn>
        </div>
      </form>

      <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 10, lineHeight: 1.4 }}>
        Expense goes to the accountant review queue — not approved automatically.
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
        <Btn onClick={onAnother}>Do another</Btn>
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

function Shell({ children, midasWebUrl }: { children: React.ReactNode; midasWebUrl: string }) {
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

function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ marginBottom: 10, ...style }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 3 }}>{label}</label>
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

async function getSelectedText(): Promise<string | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return undefined;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString() ?? '',
    });
    return results?.[0]?.result?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function guessmerchantFromTitle(title: string): string {
  if (!title) return '';
  // Strip common suffixes like " - Order Confirmation", " | Receipt", etc.
  return title
    .replace(/\s*[-|–—]\s*(Order Confirmation|Receipt|Invoice|Checkout|Payment|Thank You|Confirmation).*$/i, '')
    .trim()
    .slice(0, 60);
}

// ── Inline styles ─────────────────────────────────────────────────────────────

const styles = {
  hint: { fontSize: 12, color: '#9ca3af', marginBottom: 10 } as React.CSSProperties,
  preview: { width: '100%', borderRadius: 8, border: '1px solid #e5e7eb', marginBottom: 6, display: 'block' } as React.CSSProperties,
  pageInfo: { fontSize: 11, color: '#9ca3af', marginBottom: 6, wordBreak: 'break-all', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' } as React.CSSProperties,
  row: { display: 'flex', gap: 8, alignItems: 'center' } as React.CSSProperties,
  input: { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '6px 9px', fontSize: 13, outline: 'none', boxSizing: 'border-box' } as React.CSSProperties,
};
