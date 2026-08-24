/**
 * Smoke-test Ext API Required endpoints against a running API.
 *
 *   MIDAS_API_KEY=... MIDAS_BASE_URL=http://localhost:4000/api/v1 npm run ext:smoke -w @midas/api
 */
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const BASE = (process.env.MIDAS_BASE_URL || 'http://localhost:4000/api/v1').replace(/\/$/, '');
const KEY = process.env.MIDAS_API_KEY;
if (!KEY) {
  console.error('MIDAS_API_KEY is required');
  process.exit(1);
}

const jsonHeaders = {
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  'X-Actor-External-User-Id': '00000000-0000-4000-8000-000000000001',
  'X-Actor-Name': 'Ext Smoke',
};

async function req(method: string, pathName: string, body?: unknown) {
  const res = await fetch(`${BASE}${pathName}`, {
    method,
    headers: body !== undefined ? jsonHeaders : { Authorization: `Bearer ${KEY}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** Minimal valid 1x1 PNG */
function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}

async function uploadReceipt(expenseId: string) {
  const form = new FormData();
  const buf = tinyPng();
  form.append('file', new Blob([buf], { type: 'image/png' }), 'smoke.png');
  const res = await fetch(`${BASE}/ext/expenses/${expenseId}/receipts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
  });
  const json = await res.json() as { receipt?: { id: string }; ocrMode?: string };
  return { status: res.status, json };
}

async function main() {
  const steps: Array<{ name: string; ok: boolean; detail: string }> = [];

  const cats = await req('GET', '/ext/categories');
  steps.push({
    name: 'GET /ext/categories',
    ok: cats.status === 200 && Array.isArray((cats.json as { categories?: unknown[] })?.categories),
    detail: `HTTP ${cats.status}`,
  });

  const ocrForm = new FormData();
  ocrForm.append('file', new Blob([tinyPng()], { type: 'image/png' }), 'ocr.png');
  const ocrRes = await fetch(`${BASE}/ext/ocr/process`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
    body: ocrForm,
  });
  const ocrJson = await ocrRes.json() as { ocrMode?: string; fields?: { merchant?: { value?: string } } };
  steps.push({
    name: 'POST /ext/ocr/process',
    ok: ocrRes.status === 200 && ocrJson.ocrMode === 'sync' && !!ocrJson.fields,
    detail: `HTTP ${ocrRes.status} mode=${ocrJson.ocrMode}`,
  });

  const sourceRefId = `smoke-${Date.now()}`;
  const eventId = '11111111-1111-4111-8111-111111111111';
  const create = await req('POST', '/ext/expenses', {
    sourceApp: 'trade_show',
    sourceRefId,
    submitterEmail: 'smoke-ts@midas.local',
    externalUserId: '00000000-0000-4000-8000-000000000001',
    eventId,
    sourceLabel: 'Smoke Event',
    sourceType: 'trade_show_event',
    merchant: 'Smoke Cafe',
    amount: 12.34,
    date: '2026-08-03',
    status: 'pending',
    categoryName: 'Meal and Entertainment',
  });
  const created = create.json as { created?: boolean; expense?: { id: string; midasUrl?: string }; midasUrl?: string };
  const expenseId = created.expense?.id;
  steps.push({
    name: 'POST /ext/expenses (create)',
    ok: create.status === 201 && created.created === true && !!expenseId && !!created.midasUrl,
    detail: `HTTP ${create.status} created=${created.created}`,
  });

  const again = await req('POST', '/ext/expenses', {
    sourceApp: 'trade_show',
    sourceRefId,
    submitterEmail: 'smoke-ts@midas.local',
    eventId,
    sourceLabel: 'Smoke Event',
    sourceType: 'trade_show_event',
    merchant: 'Smoke Cafe',
    amount: 12.34,
    date: '2026-08-03',
  });
  const againBody = again.json as { created?: boolean };
  steps.push({
    name: 'POST /ext/expenses (idempotent)',
    ok: again.status === 200 && againBody.created === false,
    detail: `HTTP ${again.status} created=${againBody.created}`,
  });

  if (expenseId) {
    const patch = await req('PATCH', `/ext/expenses/${expenseId}`, {
      merchant: 'Smoke Cafe Updated',
      amount: 15.5,
    });
    const patched = patch.json as { expense?: { merchant?: string; amount?: string } };
    steps.push({
      name: 'PATCH /ext/expenses/:id',
      ok: patch.status === 200 && patched.expense?.merchant === 'Smoke Cafe Updated',
      detail: `HTTP ${patch.status} merchant=${patched.expense?.merchant}`,
    });

    const upload = await uploadReceipt(expenseId);
    const receiptId = upload.json.receipt?.id;
    steps.push({
      name: 'POST /ext/expenses/:id/receipts (sync OCR)',
      ok: upload.status === 201 && !!receiptId && upload.json.ocrMode === 'sync',
      detail: `HTTP ${upload.status} ocrMode=${upload.json.ocrMode}`,
    });

    if (receiptId) {
      const content = await fetch(`${BASE}/ext/expenses/${expenseId}/receipts/${receiptId}/content`, {
        headers: { Authorization: `Bearer ${KEY}` },
      });
      const bytes = Buffer.from(await content.arrayBuffer());
      steps.push({
        name: 'GET …/receipts/:id/content',
        ok: content.status === 200 && bytes.length > 0 && (content.headers.get('content-type') ?? '').includes('image'),
        detail: `HTTP ${content.status} bytes=${bytes.length}`,
      });
    }

    const getOne = await req('GET', `/ext/expenses/${expenseId}`);
    const full = getOne.json as { expense?: { receipts?: unknown[]; eventId?: string } };
    steps.push({
      name: 'GET /ext/expenses/:id (full DTO)',
      ok: getOne.status === 200
        && full.expense?.eventId === eventId
        && (full.expense?.receipts?.length ?? 0) >= 1,
      detail: `HTTP ${getOne.status} receipts=${full.expense?.receipts?.length}`,
    });
  }

  const list = await req('GET', `/ext/expenses?sourceApp=trade_show&eventId=${eventId}`);
  const listBody = list.json as { expenses?: unknown[] };
  steps.push({
    name: 'GET /ext/expenses?eventId=',
    ok: list.status === 200 && (listBody.expenses?.length ?? 0) >= 1,
    detail: `HTTP ${list.status} count=${listBody.expenses?.length}`,
  });

  const byRef = await req('GET', `/ext/expenses/by-ref?sourceApp=trade_show&sourceRefId=${sourceRefId}`);
  steps.push({
    name: 'GET /ext/expenses/by-ref',
    ok: byRef.status === 200,
    detail: `HTTP ${byRef.status}`,
  });

  const importRef = `import-${Date.now()}`;
  const pngB64 = tinyPng().toString('base64');
  const sha = createHash('sha256').update(tinyPng()).digest('hex');
  const importReal = await req('POST', '/ext/expenses/import', {
    sourceApp: 'trade_show',
    dryRun: false,
    items: [{
      sourceRefId: importRef,
      submitterEmail: 'smoke-ts@midas.local',
      externalUserId: '00000000-0000-4000-8000-000000000002',
      eventId,
      sourceLabel: 'Smoke Event',
      merchant: 'Import Merchant',
      amount: 9.99,
      date: '2026-08-01',
      status: 'approved',
      categoryName: 'Other',
      ocrText: 'imported ocr text',
      createdAt: '2026-07-01T12:00:00.000Z',
      receipt: {
        filename: 'imported.png',
        mimeType: 'image/png',
        contentBase64: pngB64,
        skipOcr: true,
        sha256: sha,
      },
    }],
  });
  const importBody = importReal.json as {
    totals?: { created?: number; skipped?: number; failed?: number };
    results?: Array<{ status: string }>;
  };
  steps.push({
    name: 'POST /ext/expenses/import (skipOcr)',
    ok: importReal.status === 200
      && (importBody.totals?.created ?? 0) >= 1
      && (importBody.totals?.failed ?? 0) === 0,
    detail: `HTTP ${importReal.status} totals=${JSON.stringify(importBody.totals)}`,
  });

  const importAgain = await req('POST', '/ext/expenses/import', {
    sourceApp: 'trade_show',
    dryRun: false,
    items: [{
      sourceRefId: importRef,
      submitterEmail: 'smoke-ts@midas.local',
      eventId,
      sourceLabel: 'Smoke Event',
      merchant: 'Import Merchant',
      amount: 9.99,
      date: '2026-08-01',
      status: 'approved',
      categoryName: 'Other',
    }],
  });
  const againImp = importAgain.json as { totals?: { skipped?: number; created?: number } };
  steps.push({
    name: 'POST /ext/expenses/import (idempotent skip)',
    ok: importAgain.status === 200 && (againImp.totals?.skipped ?? 0) >= 1,
    detail: `HTTP ${importAgain.status} totals=${JSON.stringify(againImp.totals)}`,
  });

  // DELETE path: create a disposable draft-like pending expense then delete
  const delRef = `del-${Date.now()}`;
  const delCreate = await req('POST', '/ext/expenses', {
    sourceApp: 'trade_show',
    sourceRefId: delRef,
    submitterEmail: 'smoke-ts@midas.local',
    eventId,
    sourceLabel: 'Smoke Event',
    sourceType: 'trade_show_event',
    merchant: 'Delete Me',
    amount: 1,
    date: '2026-08-03',
    status: 'pending',
  });
  const delId = (delCreate.json as { expense?: { id: string } }).expense?.id;
  if (delId) {
    const del = await req('DELETE', `/ext/expenses/${delId}`);
    steps.push({
      name: 'DELETE /ext/expenses/:id (pending unreviewed)',
      ok: del.status === 200,
      detail: `HTTP ${del.status}`,
    });
    const gone = await req('GET', `/ext/expenses/${delId}`);
    steps.push({
      name: 'GET deleted expense → 404',
      ok: gone.status === 404,
      detail: `HTTP ${gone.status}`,
    });
  }

  // Missing scope check: use a garbage key
  const bad = await fetch(`${BASE}/ext/categories`, {
    headers: { Authorization: 'Bearer midas_invalid' },
  });
  steps.push({
    name: 'Invalid key → 401',
    ok: bad.status === 401,
    detail: `HTTP ${bad.status}`,
  });

  // ── Messages ───────────────────────────────────────────────────────────────
  const postMsg = await req('POST', `/ext/expenses/${expenseId}/messages`, {
    body: 'Smoke test message',
    // jsonHeaders carries no X-Actor-Email/-Username, so resolveExtUser needs a
    // submitter identity from the body — Zod strips this key from `parsed`, but
    // actorEmail(req) reads it off the raw req.body before that happens.
    submitterEmail: 'smoke-ts@midas.local',
  });
  steps.push({
    name: 'POST /ext/expenses/:id/messages',
    ok: postMsg.status === 201
      && !!(postMsg.json as { message?: { id?: string } })?.message?.id,
    detail: `HTTP ${postMsg.status}`,
  });

  const thread = await req('GET', `/ext/expenses/${expenseId}/messages`);
  const threadMessages = (thread.json as { messages?: unknown[] })?.messages;
  steps.push({
    name: 'GET /ext/expenses/:id/messages',
    ok: thread.status === 200 && Array.isArray(threadMessages) && threadMessages.length > 0,
    detail: `HTTP ${thread.status} count=${threadMessages?.length ?? 0}`,
  });

  // internalNote must never cross the Ext boundary, for any consumer.
  steps.push({
    name: 'Ext thread omits internalNote',
    ok: !thread.text.includes('internalNote'),
    detail: thread.text.includes('internalNote') ? 'LEAKED internalNote' : 'absent',
  });

  const feed = await req('GET', '/ext/messages?sourceApp=trade_show&limit=5');
  const feedJson = feed.json as { messages?: Array<{ expense?: { ownerUserId?: string } }> };
  steps.push({
    name: 'GET /ext/messages',
    ok: feed.status === 200
      && Array.isArray(feedJson?.messages)
      && (feedJson.messages.length === 0 || !!feedJson.messages[0].expense?.ownerUserId),
    detail: `HTTP ${feed.status} count=${feedJson?.messages?.length ?? 0}`,
  });

  steps.push({
    name: 'Ext feed omits internalNote',
    ok: !feed.text.includes('internalNote'),
    detail: feed.text.includes('internalNote') ? 'LEAKED internalNote' : 'absent',
  });

  // A mismatched sourceApp must be refused, not silently served.
  const wrongApp = await req('GET', '/ext/messages?sourceApp=not_trade_show&limit=1');
  steps.push({
    name: 'GET /ext/messages rejects a foreign sourceApp',
    ok: wrongApp.status === 403,
    detail: `HTTP ${wrongApp.status}`,
  });

  let failed = 0;
  for (const s of steps) {
    console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`);
    if (!s.ok) failed += 1;
  }

  // Keep a tiny artifact for debugging failed CI-like runs
  const reportPath = path.join(tmpdir(), 'midas-ext-smoke-report.json');
  writeFileSync(reportPath, JSON.stringify({ steps, failed }, null, 2));
  if (failed) console.error(`Report: ${reportPath}`);

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
