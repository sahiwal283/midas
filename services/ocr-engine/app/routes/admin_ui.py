"""
OCR Cost Monitoring UI — served at GET /admin/ui.

The HTML page itself is public (no auth required to load it).
All data API calls within the page require X-Internal-Token via JavaScript fetch().
The token is stored only in sessionStorage — never persisted to localStorage or cookies.

Access: http://192.168.1.195:8000/admin/ui  (internal LAN only)
"""

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.config import settings

router = APIRouter(prefix="/admin", tags=["admin-ui"], include_in_schema=False)

# ---------------------------------------------------------------------------
# HTML template — substituted with VERSION at request time
# ---------------------------------------------------------------------------

_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OCR Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#f5f5f5;color:#333;min-height:100vh}
.hdr{background:#1a1a2e;color:#fff;padding:12px 24px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.hdr h1{font-size:1.05rem;font-weight:600;flex:1}
.hdr-badges{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.badge{background:#e74c3c;color:#fff;padding:2px 7px;border-radius:4px;font-size:.68rem;font-weight:700;letter-spacing:.05em}
.hdr-badge{padding:2px 8px;border-radius:4px;font-size:.68rem;font-weight:600}
.hdr-badge.up{background:#1e6e42;color:#a9e6c2}
.hdr-badge.down{background:#7d2020;color:#f5a0a0}
.hdr-badge.warn{background:#7d5a00;color:#fde68a}
.hdr-badge.off{background:#444;color:#aaa}
.ver{font-size:.72rem;color:#aaa}
.wrap{max-width:1400px;margin:0 auto;padding:18px 24px}
/* auth */
.btn{padding:7px 15px;background:#1a1a2e;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:.83rem;white-space:nowrap}
.btn:hover{background:#2d2d5e}
.msg{margin-top:7px;font-size:.8rem}
.msg.err{color:#e74c3c}
.msg.ok{color:#27ae60}
/* SSO sign-in card */
.sso-card{background:#fff;border:1px solid #ddd;border-radius:10px;padding:36px 32px;max-width:400px;margin:32px auto 24px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.07)}
.sso-icon{font-size:2rem;margin-bottom:12px}
.sso-card h2{font-size:1.15rem;margin-bottom:8px;color:#1a1a2e}
.sso-card p{font-size:.83rem;color:#666;margin-bottom:18px;line-height:1.5}
.sso-btn{display:inline-block;padding:10px 24px;background:#1a1a2e;color:#fff;border-radius:5px;font-size:.9rem;font-weight:600;text-decoration:none;cursor:pointer;transition:background .15s}
.sso-btn:hover{background:#2d2d5e;color:#fff}
.sso-note{font-size:.72rem;color:#aaa;margin-top:12px}
/* identity badge in header */
.identity-badge{display:flex;align-items:center;gap:5px;background:rgba(255,255,255,.1);border-radius:4px;padding:3px 9px;font-size:.72rem;color:#d4d4d4}
.identity-badge .id-name{font-weight:600;color:#fff}
/* break-glass token section */
.bg-section{margin-top:18px;text-align:left}
.bg-section summary{font-size:.72rem;color:#aaa;cursor:pointer;padding:4px 0;list-style:none;user-select:none}
.bg-section summary::before{content:"▶ ";font-size:.6rem}
details[open].bg-section summary::before{content:"▼ "}
.bg-inner{margin-top:9px;padding:12px;background:#fafafa;border:1px solid #e8e8e8;border-radius:6px}
.bg-inner p{font-size:.75rem;color:#888;margin-bottom:9px;line-height:1.5}
.bg-inner .auth-row{display:flex;gap:7px}
.bg-inner input{flex:1;padding:6px 9px;border:1px solid #ccc;border-radius:4px;font-size:.83rem}
/* auth-box (break-glass direct mode) */
.auth-box{background:#fff;border:1px solid #ddd;border-radius:8px;padding:22px;max-width:460px;margin-bottom:22px}
.auth-box h2{font-size:.92rem;margin-bottom:7px}
.auth-box p{font-size:.8rem;color:#777;margin-bottom:9px}
.auth-hint{font-size:.73rem;color:#888;margin-bottom:12px;line-height:1.55}
.auth-row{display:flex;gap:8px}
.auth-row input{flex:1;padding:7px 10px;border:1px solid #ccc;border-radius:4px;font-size:.88rem}
/* cards */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:12px;padding:14px 16px;border-bottom:1px solid #f0f0f0}
.card{background:#f9f9f9;border-radius:7px;padding:14px 16px;border:1px solid #e8e8e8}
.card.warn{border-left:4px solid #f39c12}
.card.good{border-left:4px solid #27ae60}
.card.bad{border-left:4px solid #e74c3c}
.card-lbl{font-size:.68rem;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px}
.card-val{font-size:1.5rem;font-weight:700}
.card-sub{font-size:.75rem;color:#666;margin-top:3px}
/* sections */
.sec{background:#fff;border-radius:8px;border:1px solid #e0e0e0;margin-bottom:16px;overflow:hidden}
.sec-hdr{padding:12px 16px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:44px}
.sec-hdr h2{font-size:.87rem;font-weight:600;flex:1}
.sec-body{overflow-x:auto}
/* collapsible detail sections */
details.det-sec{background:#fff;border-radius:8px;border:1px solid #e0e0e0;margin-bottom:16px;overflow:hidden}
details.det-sec>summary{padding:12px 16px;cursor:pointer;font-size:.87rem;font-weight:600;list-style:none;display:flex;align-items:center;gap:8px;user-select:none;border-bottom:1px solid transparent}
details.det-sec>summary::-webkit-details-marker{display:none}
details.det-sec>summary::before{content:"▶";font-size:.65rem;color:#aaa;margin-right:2px;transition:transform .15s}
details.det-sec[open]>summary{border-bottom-color:#eee}
details.det-sec[open]>summary::before{transform:rotate(90deg)}
details.det-sec>summary .sec-cnt{font-size:.73rem;color:#aaa;margin-left:auto}
/* global filter bar */
.gfilter{display:flex;align-items:center;gap:8px;padding:10px 16px;background:#fafafa;border-bottom:1px solid #eee;flex-wrap:wrap}
.gfilter label{font-size:.73rem;color:#777;white-space:nowrap}
.gfilter select,.gfilter input{padding:5px 8px;border:1px solid #ccc;border-radius:4px;font-size:.8rem;background:#fff}
/* filter row */
.filter-row{display:flex;align-items:center;gap:8px;padding:9px 14px;background:#fafafa;border-bottom:1px solid #eee;flex-wrap:wrap}
.filter-row label{font-size:.73rem;color:#777;white-space:nowrap}
.filter-row input,.filter-row select{padding:5px 8px;border:1px solid #ccc;border-radius:4px;font-size:.8rem}
.btn-sm{padding:5px 10px;background:#1a1a2e;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:.76rem}
.btn-sm:hover{background:#2d2d5e}
.btn-clr{padding:5px 10px;background:none;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-size:.76rem;color:#666}
.btn-clr:hover{background:#f0f0f0}
/* table */
table{width:100%;border-collapse:collapse;font-size:.8rem}
th{background:#f9f9f9;padding:8px 12px;text-align:left;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#666;border-bottom:1px solid #e0e0e0;white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid #f0f0f0;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafafa}
/* tags */
.tag{display:inline-block;padding:2px 6px;border-radius:10px;font-size:.7rem;font-weight:600}
.tag.completed,.tag.success,.tag.succeeded{background:#d5f5e3;color:#1e8449}
.tag.failed,.tag.error{background:#fce4e4;color:#c0392b}
.tag.blocked{background:#fdf2cc;color:#9a6700}
.tag.started,.tag.running{background:#d6eaf8;color:#1a5276}
.tag.queued{background:#f0f0f0;color:#555}
.tag.metered{background:#fce4e4;color:#c0392b}
.tag.local{background:#d5f5e3;color:#1e8449}
/* charts */
.chart-area{display:flex;gap:16px;padding:16px;flex-wrap:wrap;border-bottom:1px solid #f0f0f0}
.chart-main{flex:2;min-width:280px}
.chart-side{flex:1;min-width:200px;display:flex;flex-direction:column;gap:14px}
.chart-lbl{font-size:.7rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:7px}
.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:.78rem}
.bar-lbl{width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#555;text-align:right;flex-shrink:0}
.bar-track{flex:1;height:10px;background:#f0f0f0;border-radius:5px;overflow:hidden}
.bar-fill{height:10px;background:#3498db;border-radius:5px;transition:width .3s}
.bar-fill.cost{background:#e67e22}
.bar-val{width:68px;font-size:.73rem;color:#888;text-align:right;flex-shrink:0}
/* status dots */
.st-row{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:.8rem}
.st-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
/* job lookup */
.lookup-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.lookup-row input{flex:1;min-width:260px;padding:6px 10px;border:1px solid #ccc;border-radius:4px;font-size:.83rem;font-family:monospace}
.lookup-row select{padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:.8rem}
.job-card{background:#f8f8f8;border:1px solid #e0e0e0;border-radius:6px;padding:14px;font-size:.8rem}
.job-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px 12px;margin-bottom:10px}
.jf{display:flex;flex-direction:column;gap:1px}
.jf-lbl{font-size:.65rem;color:#999;text-transform:uppercase;letter-spacing:.04em}
.jf-val{font-family:monospace;font-size:.78rem;overflow:hidden;text-overflow:ellipsis}
/* providers */
.prov-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;padding:14px}
.prov-card{border:1px solid #e0e0e0;border-radius:6px;padding:12px}
.prov-name{font-weight:600;font-size:.86rem;margin-bottom:5px}
.prov-roles{margin-bottom:6px;display:flex;flex-wrap:wrap;gap:3px}
.prov-meta{font-size:.76rem;color:#666}
.prov-note{font-size:.71rem;color:#999;margin-top:4px}
/* warnings/info */
.warn-box{background:#fef9e7;border:1px solid #f39c12;border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:.8rem;line-height:1.5}
.info-box{background:#eaf4fb;border:1px solid #aed6f1;border-radius:6px;padding:9px 13px;margin-bottom:14px;font-size:.78rem;line-height:1.5;color:#1a5276}
.val-err{background:#fce4e4;border:1px solid #e74c3c;border-radius:6px;padding:9px 13px;margin:9px 14px;font-size:.78rem;color:#c0392b}
.val-err ul{margin:5px 0 0 13px}
/* pagination */
.pager{display:flex;align-items:center;gap:8px;padding:9px 13px;border-top:1px solid #eee;font-size:.78rem;color:#666}
.pager-info{flex:1}
.pg-btn{background:none;border:1px solid #ccc;border-radius:4px;padding:3px 8px;font-size:.75rem;cursor:pointer}
.pg-btn:hover:not(:disabled){background:#f0f0f0}
.pg-btn:disabled{opacity:.4;cursor:default}
/* misc */
.mono{font-family:'SF Mono',Consolas,monospace;font-size:.76rem}
.spin{display:inline-block;width:15px;height:15px;border:2px solid #ccc;border-top-color:#555;border-radius:50%;animation:sp .7s linear infinite;vertical-align:middle}
@keyframes sp{to{transform:rotate(360deg)}}
.muted{color:#aaa;font-size:.8rem;padding:12px}
.refresh-btn{background:none;border:1px solid #ccc;border-radius:4px;padding:3px 8px;font-size:.75rem;cursor:pointer}
.refresh-btn:hover{background:#f0f0f0}
footer{text-align:center;padding:18px;color:#bbb;font-size:.73rem}
/* preview/apply */
.preview-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;margin-bottom:14px}
.preview-field label{display:block;font-size:.7rem;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.preview-field select{width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:.8rem;background:#fff}
.preview-result-box{border:1px solid #e0e0e0;border-radius:6px;padding:13px;margin-top:13px;font-size:.8rem}
.preview-result-box.ok{border-color:#27ae60}
.preview-result-box.fail{border-color:#e74c3c}
.chg-list{margin:5px 0 0 0;padding:0;list-style:none}
.chg-list li{padding:3px 0;border-bottom:1px solid #f5f5f5;font-size:.77rem}
.chg-list li:last-child{border-bottom:none}
.apply-note{background:#fef9e7;border:1px solid #f39c12;border-radius:4px;padding:7px 11px;margin-top:9px;font-size:.77rem;color:#7d5a00}
.confirm-block{background:#fff8f0;border:1px solid #e67e22;border-radius:6px;padding:13px;margin-top:11px}
.confirm-block label{display:block;font-size:.76rem;font-weight:600;color:#7d5a00;margin-bottom:5px}
.confirm-block input{width:100%;padding:6px 9px;border:1px solid #ccc;border-radius:4px;font-size:.84rem;font-family:monospace;letter-spacing:.05em}
.confirm-block input.match{border-color:#27ae60}
.btn-apply{padding:7px 16px;background:#c0392b;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:.84rem;margin-top:9px;font-weight:600}
.btn-apply:hover:not(:disabled){background:#922b21}
.btn-apply:disabled{opacity:.4;cursor:default;background:#999}
.apply-success{background:#d5f5e3;border:1px solid #27ae60;border-radius:6px;padding:13px;margin-top:13px;font-size:.8rem}
.apply-error{background:#fce4e4;border:1px solid #e74c3c;border-radius:6px;padding:13px;margin-top:13px;font-size:.8rem;color:#c0392b}
</style>
</head>
<body>
<div class="hdr">
  <h1>OCR Admin</h1>
  <div class="hdr-badges" id="hdr-badges" style="display:none">
    <span class="hdr-badge off" id="hdr-db">DB —</span>
    <span class="hdr-badge off" id="hdr-llm">LLM —</span>
    <span class="hdr-badge off" id="hdr-prov">— —</span>
  </div>
  <div class="identity-badge" id="identity-badge" style="display:none">
    <span>&#128100;</span>
    <span class="id-name" id="identity-name"></span>
    <span style="color:#aaa">via Authentik</span>
  </div>
  <span class="ver" id="svc-ver">v__VERSION__</span>
  <span class="badge">Internal Admin</span>
</div>

<div class="wrap">

  <!-- SSO sign-in card (shown when not authenticated via trusted proxy headers) -->
  <div class="sso-card" id="sso-card" style="display:none">
    <div class="sso-icon">&#128274;</div>
    <h2>OCR Admin</h2>
    <p>Sign in with SSO to access the OCR dashboard.</p>
    <a href="#" class="sso-btn" id="sso-btn" onclick="return ssoClick()">Sign in with SSO</a>
    <p class="sso-note">Access is restricted to the <code>ocr-admins</code> Authentik group.</p>

    <!-- Break-glass token (collapsed, only shown when token mode available) -->
    <details class="bg-section" id="break-glass-section" style="display:none">
      <summary>Break-glass token access</summary>
      <div class="bg-inner">
        <p>&#9888; Emergency/break-glass only. Not the normal access path.<br>
           Retrieve from the OCR LXC:<br>
           <code>pct exec 9500 -- cat /root/ocr-service-secrets/admin_internal_token.txt</code></p>
        <div class="auth-row">
          <input type="password" id="tok" placeholder="Admin token"
                 onkeydown="if(event.key==='Enter')connect()">
          <button class="btn" onclick="connect()">Connect</button>
        </div>
        <div id="auth-msg"></div>
      </div>
    </details>
  </div>

  <!-- Direct token login card (shown in internal_token mode / fallback) -->
  <div class="auth-box" id="auth-box" style="display:none">
    <h2>Admin Authentication</h2>
    <p>Enter the <code>OCR_ADMIN_INTERNAL_TOKEN</code> value to access admin data.</p>
    <p class="auth-hint">&#9432; Retrieve from the OCR LXC:<br>
      <code>pct exec 9500 -- cat /root/ocr-service-secrets/admin_internal_token.txt</code><br>
      Admin token grants <code>/admin/*</code> access only.</p>
    <div class="auth-row">
      <input type="password" id="tok-direct" placeholder="Admin token"
             onkeydown="if(event.key==='Enter')connectDirect()">
      <button class="btn" onclick="connectDirect()">Connect</button>
    </div>
    <div id="auth-msg-direct"></div>
  </div>

  <!-- Dashboard (hidden until authenticated) -->
  <div id="dash" style="display:none">
    <div id="warn-area"></div>

    <!-- Analytics Dashboard card -->
    <div class="sec">
      <div class="sec-hdr">
        <h2>Analytics Dashboard</h2>
        <span id="dash-ts" style="font-size:.72rem;color:#bbb"></span>
        <button class="refresh-btn" onclick="loadAll()">&#8635; Refresh</button>
      </div>
      <!-- Global filters -->
      <div class="gfilter">
        <label>Client App</label>
        <select id="g-client-app"><option value="">All apps</option></select>
        <label>Workflow</label>
        <select id="g-workflow"><option value="">All</option></select>
        <label>Window</label>
        <select id="g-days">
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30" selected>30 days</option>
          <option value="90">90 days</option>
        </select>
        <button class="btn-sm" onclick="loadAll()">Load</button>
        <button class="btn-clr" onclick="resetGlobalFilters()">Reset</button>
      </div>
      <!-- Cost cards -->
      <div id="cost-cards" class="cards"><span class="spin" style="margin:8px 4px"></span></div>
      <!-- Charts -->
      <div class="chart-area">
        <div class="chart-main">
          <div class="chart-lbl">Daily Cost (USD)</div>
          <div id="ts-chart"><span class="spin"></span></div>
        </div>
        <div class="chart-side">
          <div>
            <div class="chart-lbl">Cost by Provider</div>
            <div id="prov-chart"><span class="spin"></span></div>
          </div>
          <div>
            <div class="chart-lbl">Cost by Client App</div>
            <div id="app-chart"><span class="spin"></span></div>
          </div>
        </div>
      </div>
      <!-- Status breakdown + recent failures row -->
      <div style="display:flex;gap:16px;padding:14px 16px;flex-wrap:wrap;border-top:1px solid #f0f0f0">
        <div style="flex:1;min-width:160px">
          <div class="chart-lbl">Status Breakdown</div>
          <div id="status-breakdown"><span class="spin"></span></div>
        </div>
        <div style="flex:3;min-width:280px" id="failures-panel">
          <div class="chart-lbl" style="color:#c0392b">Recent Failures</div>
          <div id="recent-failures"><span class="muted">None in window</span></div>
        </div>
      </div>
    </div>

    <!-- Job Lookup -->
    <div class="sec">
      <div class="sec-hdr"><h2>Job Lookup</h2>
        <span style="font-size:.73rem;color:#aaa">Search by job ID, request ID, or external reference</span>
      </div>
      <div style="padding:14px 16px">
        <div class="lookup-row">
          <select id="lookup-type">
            <option value="job_id">Job ID (UUID)</option>
            <option value="request_id">Request ID (UUID)</option>
            <option value="external_reference_id">External Reference ID</option>
          </select>
          <input type="text" id="lookup-value" placeholder="Paste ID here…"
                 onkeydown="if(event.key==='Enter')lookupJob()">
          <button class="btn" onclick="lookupJob()">Look Up</button>
          <button class="btn-clr" onclick="clearLookup()">Clear</button>
        </div>
        <div id="lookup-result" style="margin-top:12px"></div>
      </div>
    </div>

    <!-- Recent Jobs (from dashboard, always visible) -->
    <div class="sec">
      <div class="sec-hdr">
        <h2>Recent Jobs</h2>
        <span style="font-size:.72rem;color:#aaa">Last 10 &mdash; expand Full Jobs below for more</span>
      </div>
      <div id="recent-jobs-tbl"><span class="muted"><span class="spin"></span></span></div>
    </div>

    <!-- Full Jobs (collapsible) -->
    <details class="det-sec" id="sec-jobs"
             ontoggle="if(this.open){jobOff=0;loadJobs(0)}">
      <summary>
        Full Jobs List
        <span class="sec-cnt" id="jobs-cnt"></span>
      </summary>
      <div>
        <div class="filter-row">
          <label>Client App</label>
          <select id="jobs-client-app" style="min-width:110px"><option value="">All apps</option></select>
          <label>Workflow</label>
          <select id="jobs-workflow" style="min-width:100px"><option value="">All</option></select>
          <label>Ext. Ref. Type</label>
          <select id="jobs-ext-ref-type" style="min-width:120px"><option value="">All types</option></select>
          <label>Status</label>
          <select id="jobs-status" style="min-width:100px"><option value="">All</option></select>
        </div>
        <div class="filter-row">
          <label>Ext. Ref. ID</label>
          <input type="text" id="jobs-ext-ref-id" placeholder="receipt:uuid…" style="width:200px">
          <label>After</label>
          <input type="date" id="jobs-after">
          <label>Before</label>
          <input type="date" id="jobs-before">
          <button class="btn-sm" onclick="loadJobs(0)">Filter</button>
          <button class="btn-clr" onclick="clearJobFilters()">Clear</button>
        </div>
        <div class="sec-body">
          <div id="jobs-tbl"><span class="muted"><span class="spin"></span></span></div>
          <div class="pager" id="jobs-pager"></div>
        </div>
      </div>
    </details>

    <!-- Provider Calls (collapsible) -->
    <details class="det-sec" id="sec-calls"
             ontoggle="if(this.open){callOff=0;loadCalls(0)}">
      <summary>
        Provider Calls
        <span class="sec-cnt" id="calls-cnt"></span>
      </summary>
      <div>
        <div class="filter-row">
          <label>Provider</label>
          <select id="calls-provider" style="min-width:120px"><option value="">All providers</option></select>
          <label>Status</label>
          <select id="calls-status" style="min-width:100px"><option value="">All</option></select>
          <label>After</label>
          <input type="date" id="calls-after">
          <label>Before</label>
          <input type="date" id="calls-before">
          <button class="btn-sm" onclick="loadCalls(0)">Filter</button>
          <button class="btn-clr" onclick="clearCallFilters()">Clear</button>
        </div>
        <div class="sec-body">
          <div id="calls-tbl"><span class="muted"><span class="spin"></span></span></div>
          <div class="pager" id="calls-pager"></div>
        </div>
      </div>
    </details>

    <!-- Async OCR Jobs (collapsible) -->
    <details class="det-sec" id="sec-async"
             ontoggle="if(this.open)loadAsyncJobs(0)">
      <summary>
        Async OCR Jobs
        <span class="sec-cnt" id="async-jobs-cnt"></span>
      </summary>
      <div>
        <div class="filter-row">
          <label>Status</label>
          <select id="async-status">
            <option value="">All</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
          </select>
          <label>Client App</label>
          <input type="text" id="async-client-app" placeholder="e.g. expense-app" style="width:150px">
          <button class="btn-sm" onclick="loadAsyncJobs(0)">Filter</button>
          <button class="btn-clr" onclick="clearAsyncFilters()">Clear</button>
        </div>
        <div class="sec-body">
          <div id="async-jobs-tbl"><span class="muted"><span class="spin"></span></span></div>
          <div class="pager" id="async-jobs-pager"></div>
        </div>
      </div>
    </details>

    <!-- Audit Log (collapsible) -->
    <details class="det-sec" id="sec-audit"
             ontoggle="if(this.open){auditOff=0;loadAudit(0)}">
      <summary>
        Admin Audit Log
        <span class="sec-cnt" id="audit-cnt"></span>
      </summary>
      <div class="sec-body">
        <div id="audit-tbl"><span class="muted"><span class="spin"></span></span></div>
        <div class="pager" id="audit-pager"></div>
      </div>
    </details>

    <!-- Ledger Health (collapsible) -->
    <details class="det-sec" id="sec-health"
             ontoggle="if(this.open)loadHealth()">
      <summary>Ledger Health &amp; Config</summary>
      <div style="padding:14px 16px" id="health-body"><span class="spin"></span></div>
    </details>

    <!-- Provider Configuration (collapsible) -->
    <details class="det-sec" id="sec-providers"
             ontoggle="if(this.open)loadProviders()">
      <summary>Provider Configuration</summary>
      <div>
        <div id="prov-errors"></div>
        <div class="prov-grid" id="prov-body"><span class="spin"></span></div>
      </div>
    </details>

    <!-- Settings (collapsible) -->
    <details class="det-sec" id="sec-settings"
             ontoggle="if(this.open)loadSettings()">
      <summary>Settings &amp; Runtime Config</summary>
      <div style="padding:14px 16px" id="settings-body"><span class="spin"></span></div>
    </details>

    <!-- Preview Config Change (collapsible) -->
    <details class="det-sec" id="sec-preview">
      <summary>Preview &amp; Apply Config Change</summary>
      <div style="padding:14px 16px">
        <div class="info-box" style="margin-bottom:14px">
          &#128204; <strong>Preview &amp; Apply.</strong>
          Preview validates a proposed configuration. If valid, an Apply button writes the change to <code>.env</code>.
          The <strong>running container is not restarted automatically</strong> — run
          <code>docker compose up -d --force-recreate ocr_service</code> after applying.
        </div>
        <div class="preview-grid">
          <div class="preview-field">
            <label>Primary OCR Provider</label>
            <select id="prev-primary">
              <option value="">— keep current —</option>
              <option value="document_ai">document_ai</option>
              <option value="google_vision">google_vision</option>
              <option value="rapidocr">rapidocr</option>
              <option value="tesseract">tesseract</option>
              <option value="easyocr">easyocr</option>
            </select>
          </div>
          <div class="preview-field">
            <label>Fallback OCR Provider</label>
            <select id="prev-fallback">
              <option value="">— keep current —</option>
              <option value="document_ai">document_ai</option>
              <option value="google_vision">google_vision</option>
              <option value="rapidocr">rapidocr</option>
              <option value="tesseract">tesseract</option>
              <option value="easyocr">easyocr</option>
            </select>
          </div>
          <div class="preview-field">
            <label>Ledger-Unavailable Fallback</label>
            <select id="prev-ledger-fb">
              <option value="">— keep current —</option>
              <option value="rapidocr">rapidocr (local)</option>
              <option value="tesseract">tesseract (local)</option>
              <option value="easyocr">easyocr (local)</option>
            </select>
          </div>
          <div class="preview-field">
            <label>Async Worker Mode</label>
            <select id="prev-worker-mode">
              <option value="">— keep current —</option>
              <option value="stopped">stopped</option>
              <option value="local_only">local_only</option>
              <option value="paid_normal">paid_normal &#9888;</option>
            </select>
          </div>
        </div>
        <button class="btn" onclick="runPreview()">Preview changes</button>
        <div id="preview-result"></div>
      </div>
    </details>

  </div><!-- /dash -->
</div>

<footer>OCR Service v__VERSION__ &nbsp;&middot;&nbsp; Internal Admin Only &nbsp;&middot;&nbsp;
  <a href="/health/ledger" target="_blank" style="color:#ccc">/health/ledger</a> &nbsp;&middot;&nbsp;
  <a href="/docs" target="_blank" style="color:#ccc">API docs</a>
</footer>

<script>
"use strict";
const PER_PAGE = 25;
const AUDIT_PER_PAGE = 20;
let TOKEN = "";              // set only in break-glass / direct-token mode
let _authSource = null;      // "authentik_proxy" | "admin_token" | null
let jobOff = 0, callOff = 0, auditOff = 0, asyncJobOff = 0;
let _previewToken = null, _previewChanges = null;
const _CONFIRM_PHRASE = "APPLY PROVIDER CONFIG";

// On page load: check auth status first, then decide what to show
checkAuthStatus();

async function checkAuthStatus() {
  let status = null;
  try {
    const r = await fetch("/admin/auth/status", {headers:{"Accept":"application/json"}});
    if (r.ok) status = await r.json();
  } catch(e) {}

  if (status && status.authenticated) {
    // Trusted proxy headers valid — show dashboard directly
    _authSource = "authentik_proxy";
    TOKEN = "";  // no token needed; headers come from proxy
    showIdentityBadge(status.username || "");
    showDashboard();
    return;
  }

  // Not authenticated via proxy — determine which login UI to show
  const breakGlass = status && status.break_glass_available;
  const ssoUrl = (status && status.sso_url) || null;

  if (ssoUrl) {
    // Show SSO card (primary path)
    document.getElementById("sso-card").style.display = "";
    document.getElementById("sso-btn").href = ssoUrl;
    if (breakGlass) document.getElementById("break-glass-section").style.display = "";
    // Check sessionStorage for a previously entered break-glass token
    const saved = sessionStorage.getItem("ocr_tok");
    if (saved) { TOKEN = saved; _authSource = "admin_token"; verifyAndShow(); }
  } else {
    // No SSO URL configured — fall back to direct token login
    const saved = sessionStorage.getItem("ocr_tok");
    document.getElementById("auth-box").style.display = "";
    if (saved) { TOKEN = saved; _authSource = "admin_token"; verifyAndShow(); }
  }
}

function showIdentityBadge(username) {
  if (!username) return;
  document.getElementById("identity-name").textContent = username;
  document.getElementById("identity-badge").style.display = "";
}

function showDashboard() {
  document.getElementById("sso-card").style.display = "none";
  document.getElementById("auth-box").style.display = "none";
  document.getElementById("dash").style.display = "";
  loadAll();
}

function ssoClick() {
  const href = document.getElementById("sso-btn").href;
  if (href && href !== "#" && href !== window.location.href) {
    window.location.href = href;
  }
  return false;
}

// Break-glass connect (from SSO card's collapsed section)
function connect() {
  TOKEN = (document.getElementById("tok").value || "").trim();
  if (!TOKEN) { _authMsg("tok", "Token is required.", true); return; }
  _authSource = "admin_token";
  sessionStorage.setItem("ocr_tok", TOKEN);
  verifyAndShow();
}

// Direct token connect (from auth-box in fallback mode)
function connectDirect() {
  TOKEN = (document.getElementById("tok-direct").value || "").trim();
  if (!TOKEN) { _authMsg("tok-direct", "Token is required.", true); return; }
  _authSource = "admin_token";
  sessionStorage.setItem("ocr_tok", TOKEN);
  verifyAndShow();
}

async function verifyAndShow() {
  const r = await req("/admin/ledger/health");
  if (r.status === 401 || r.status === 503) {
    const msg = "Invalid token or admin auth not configured on this server.";
    _authMsg("tok", msg, true);
    _authMsg("tok-direct", msg, true);
    TOKEN = ""; _authSource = null; sessionStorage.removeItem("ocr_tok"); return;
  }
  showDashboard();
}

function _authMsg(inputId, t, err) {
  const ids = { "tok": "auth-msg", "tok-direct": "auth-msg-direct" };
  const el = document.getElementById(ids[inputId] || "auth-msg");
  if (!el) return;
  el.className = "msg " + (err ? "err" : "ok");
  el.textContent = t;
}

function authMsg(t, err) { _authMsg("tok", t, err); }

async function req(path, qs) {
  const url = qs ? path + "?" + new URLSearchParams(qs) : path;
  const hdrs = {"Accept": "application/json"};
  if (TOKEN) hdrs["X-Internal-Token"] = TOKEN;  // only set in break-glass/token mode
  return fetch(url, { headers: hdrs });
}
async function get(path, qs) {
  const r = await req(path, qs);
  return r.ok ? r.json() : null;
}

function _gv(id) { return (document.getElementById(id)||{}).value || ""; }

function loadAll() {
  const ca = _gv("g-client-app");
  const wf = _gv("g-workflow");
  const dy = parseInt(_gv("g-days") || "30");
  document.getElementById("dash-ts").textContent = "Loading…";
  Promise.all([
    loadFilterOptions().then(() => { if (ca) setSelectVal("g-client-app", ca); if (wf) setSelectVal("g-workflow", wf); }),
    loadDashboard(ca, wf, dy),
    loadHeaderBadges(),
  ]);
  // Reload any currently-open collapsible sections
  if ((document.getElementById("sec-jobs")||{}).open)     { jobOff = 0; loadJobs(0); }
  if ((document.getElementById("sec-calls")||{}).open)    { callOff = 0; loadCalls(0); }
  if ((document.getElementById("sec-async")||{}).open)    loadAsyncJobs(0);
  if ((document.getElementById("sec-audit")||{}).open)    { auditOff = 0; loadAudit(0); }
  if ((document.getElementById("sec-health")||{}).open)   loadHealth();
  if ((document.getElementById("sec-providers")||{}).open) loadProviders();
  if ((document.getElementById("sec-settings")||{}).open) loadSettings();
}

function resetGlobalFilters() {
  document.getElementById("g-client-app").value = "";
  document.getElementById("g-workflow").value = "";
  document.getElementById("g-days").value = "30";
  loadAll();
}

function setSelectVal(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  for (const opt of el.options) { if (opt.value === val) { opt.selected = true; return; } }
}

// ---------------------------------------------------------------------------
// Header badges
// ---------------------------------------------------------------------------

async function loadHeaderBadges() {
  const d = await get("/admin/ledger/health");
  const wrap = document.getElementById("hdr-badges");
  if (!d) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  const db = document.getElementById("hdr-db");
  db.textContent = "DB " + (d.db_available ? "✓" : "✗");
  db.className = "hdr-badge " + (d.db_available ? "up" : "down");
  const settings2 = await get("/admin/settings");
  if (settings2) {
    const llm = document.getElementById("hdr-llm");
    llm.textContent = "LLM " + (settings2.llm_inference_enabled ? "on" : "off");
    llm.className = "hdr-badge " + (settings2.llm_inference_enabled ? "up" : "off");
  }
  const prov = document.getElementById("hdr-prov");
  prov.textContent = d.primary_provider || "—";
  prov.className = "hdr-badge " + (d.primary_provider ? "up" : "warn");
}

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

async function loadFilterOptions() {
  const d = await get("/admin/ledger/filter-options");
  if (!d || !d.available) return;
  _populate("g-client-app", d.client_apps || [], "All apps");
  _populate("g-workflow",    d.workflows || [],   "All");
  _populate("jobs-client-app", d.client_apps || [], "All apps");
  _populate("jobs-workflow",   d.workflows || [],   "All");
  _populate("jobs-ext-ref-type", d.external_reference_types || [], "All types");
  _populate("jobs-status",   d.job_statuses || [],  "All");
  _populate("calls-provider", d.providers || [],    "All providers");
  _populate("calls-status",   d.call_statuses || [], "All");
}

function _populate(id, values, allLabel) {
  const el = document.getElementById(id);
  if (!el) return;
  const cur = el.value;
  el.innerHTML = `<option value="">${allLabel}</option>` +
    values.map(v => `<option value="${esc(v)}"${v===cur?" selected":""}>${esc(v)}</option>`).join("");
}

// ---------------------------------------------------------------------------
// Dashboard (charts, cards, recent activity)
// ---------------------------------------------------------------------------

async function loadDashboard(ca, wf, dy) {
  const qs = {days: dy};
  if (ca) qs.client_app = ca;
  if (wf) qs.workflow = wf;
  const d = await get("/admin/ledger/dashboard", qs);
  const now = new Date().toLocaleTimeString();
  document.getElementById("dash-ts").textContent = "Updated " + now;

  if (!d || !d.available) {
    document.getElementById("cost-cards").innerHTML = '<p class="muted">Cost data unavailable.</p>';
    document.getElementById("ts-chart").innerHTML = '<p class="muted">—</p>';
    document.getElementById("prov-chart").innerHTML = '<p class="muted">—</p>';
    document.getElementById("app-chart").innerHTML = '<p class="muted">—</p>';
    document.getElementById("status-breakdown").innerHTML = '<p class="muted">—</p>';
    return;
  }

  // Compute totals from timeseries
  const ts = d.timeseries || [];
  const today = new Date().toISOString().substring(0, 10);
  const d7cut = new Date(); d7cut.setDate(d7cut.getDate() - 7);
  const d7str = d7cut.toISOString().substring(0, 10);
  let cost1d = 0, cost7d = 0, cost30d = 0, jobs30d = 0;
  for (const row of ts) {
    cost30d += row.cost_usd; jobs30d += row.job_count;
    if (row.date >= d7str) cost7d += row.cost_usd;
    if (row.date === today) cost1d += row.cost_usd;
  }
  const failCount = (d.status_breakdown || []).find(r => r.status === "failed")?.count || 0;
  const f = v => "$" + v.toFixed(4);
  document.getElementById("cost-cards").innerHTML = [
    card("Est. Cost Today",   f(cost1d),  "estimated USD"),
    card("Est. Cost 7 Days",  f(cost7d),  "estimated USD"),
    card("Est. Cost " + dy + " Days", f(cost30d), "estimated USD"),
    card("Jobs (" + dy + " days)", jobs30d, failCount + " failed", failCount > 0 ? "warn" : "good"),
  ].join("");

  // Timeseries SVG chart
  document.getElementById("ts-chart").innerHTML = buildSVGChart(ts);

  // Cost by provider bar chart
  document.getElementById("prov-chart").innerHTML =
    buildBarChart(d.cost_by_provider || [], "provider", "cost_usd", v => "$" + v.toFixed(4));

  // Cost by client app bar chart
  document.getElementById("app-chart").innerHTML =
    buildBarChart(d.cost_by_client_app || [], "client_app", "cost_usd", v => "$" + v.toFixed(4));

  // Status breakdown
  const st = d.status_breakdown || [];
  const stColors = {completed:"#27ae60",failed:"#e74c3c",blocked:"#f39c12",started:"#3498db",received:"#9b59b6"};
  document.getElementById("status-breakdown").innerHTML = st.length
    ? st.map(r => `<div class="st-row">
        <div class="st-dot" style="background:${stColors[r.status]||"#aaa"}"></div>
        <span class="tag ${esc(r.status)}" style="font-size:.7rem">${esc(r.status)}</span>
        <span style="color:#555;font-size:.8rem">${r.count}</span>
      </div>`).join("")
    : '<span class="muted">No data</span>';

  // Recent failures
  const rf = d.recent_failures || [];
  if (rf.length) {
    const fmt_ts = s => s ? s.replace("T"," ").substring(0,16) : "—";
    document.getElementById("recent-failures").innerHTML =
      `<table><thead><tr><th>Job ID</th><th>Client App</th><th>Provider</th><th>Created (UTC)</th></tr></thead>
      <tbody>${rf.map(j=>`<tr>
        <td class="mono" title="${esc(j.id)}">${esc(j.id.substring(0,8))}…</td>
        <td>${esc(j.client_app||"—")}</td>
        <td class="mono">${esc(j.ocr_provider_used||"—")}</td>
        <td class="mono">${fmt_ts(j.created_at)}</td>
      </tr>`).join("")}</tbody></table>`;
  } else {
    document.getElementById("recent-failures").innerHTML = '<span class="muted">None in window ✓</span>';
  }

  // Recent jobs table (last 10)
  renderRecentJobs(d.recent_jobs || []);

  // Warning banner from provider data (if already loaded)
  // Defer to provider loader
}

function card(lbl, val, sub, cls="") {
  return `<div class="card ${cls}">
    <div class="card-lbl">${lbl}</div>
    <div class="card-val">${val}</div>
    <div class="card-sub">${sub}</div>
  </div>`;
}

function renderRecentJobs(items) {
  const el = document.getElementById("recent-jobs-tbl");
  if (!items.length) { el.innerHTML = '<p class="muted">No jobs in window.</p>'; return; }
  const fmt_cost = v => v!=null ? "$"+v.toFixed(4) : "—";
  const fmt_ts   = s => s ? s.replace("T"," ").substring(0,16) : "—";
  el.innerHTML = `<table><thead><tr>
    <th>Job ID</th><th>Client App</th><th>Workflow</th><th>Provider</th>
    <th>Status</th><th>Est. Cost</th><th>Created (UTC)</th>
  </tr></thead><tbody>${items.map(j=>`<tr>
    <td class="mono" title="${esc(j.id)}"
        style="cursor:pointer;color:#3498db" onclick="quickLookup('${esc(j.id)}')"
        >${esc(j.id.substring(0,8))}…</td>
    <td>${esc(j.client_app||"—")}</td>
    <td>${esc(j.workflow||"—")}</td>
    <td class="mono">${esc(j.ocr_provider_used||"—")}</td>
    <td><span class="tag ${esc(j.status)}">${esc(j.status)}</span></td>
    <td>${fmt_cost(j.total_estimated_cost_usd)}</td>
    <td class="mono">${fmt_ts(j.created_at)}</td>
  </tr>`).join("")}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// SVG timeseries chart
// ---------------------------------------------------------------------------

function buildSVGChart(data) {
  if (!data || !data.length) return '<p class="muted">No data for selected window.</p>';
  const W=640, H=130, pL=52, pB=28, pT=8, pR=12;
  const iW=W-pL-pR, iH=H-pT-pB;
  const maxC = Math.max(...data.map(d=>d.cost_usd), 0.0001);
  const n = data.length;
  const xOf = i => pL + (n>1 ? i*iW/(n-1) : iW/2);
  const yOf = v => pT + iH - (v/maxC)*iH;
  const pts = data.map((d,i) => xOf(i).toFixed(1)+","+yOf(d.cost_usd).toFixed(1)).join(" ");
  const area = xOf(0).toFixed(1)+","+(pT+iH).toFixed(1)+" "+pts+" "+xOf(n-1).toFixed(1)+","+(pT+iH).toFixed(1);
  // Y labels (4 ticks)
  const yTicks = [0,.33,.67,1].map(f => {
    const v=maxC*f, y=yOf(v);
    const lbl = v===0 ? "$0" : v>=0.01 ? "$"+v.toFixed(3) : "$"+v.toFixed(5);
    return `<text x="${pL-4}" y="${y+4}" text-anchor="end" font-size="9" fill="#bbb">${lbl}</text>
            <line x1="${pL}" y1="${y}" x2="${pL+iW}" y2="${y}" stroke="#f0f0f0" stroke-width="1"/>`;
  }).join("");
  // X labels (adaptive step)
  const step = n<=10?1:n<=20?2:n<=30?5:10;
  const xLabels = data.map((d,i) => {
    if (i%step!==0 && i!==n-1) return "";
    return `<text x="${xOf(i).toFixed(1)}" y="${H-4}" text-anchor="middle" font-size="9" fill="#bbb">${esc(d.date.slice(5))}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;max-width:${W}px">
    <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3498db" stop-opacity=".25"/>
      <stop offset="100%" stop-color="#3498db" stop-opacity=".03"/>
    </linearGradient></defs>
    ${yTicks}
    <polygon points="${area}" fill="url(#cg)"/>
    <polyline points="${pts}" fill="none" stroke="#3498db" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${xLabels}
    <line x1="${pL}" y1="${pT}" x2="${pL}" y2="${pT+iH}" stroke="#e8e8e8" stroke-width="1"/>
    <line x1="${pL}" y1="${pT+iH}" x2="${pL+iW}" y2="${pT+iH}" stroke="#e8e8e8" stroke-width="1"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// CSS bar chart
// ---------------------------------------------------------------------------

function buildBarChart(items, keyField, valField, fmt) {
  if (!items || !items.length) return '<p class="muted" style="font-size:.78rem">No data</p>';
  const maxV = Math.max(...items.map(d=>d[valField]), 0.0001);
  return items.map(item => {
    const v = item[valField] || 0;
    const pct = (v/maxV*100).toFixed(1);
    return `<div class="bar-row">
      <div class="bar-lbl" title="${esc(String(item[keyField]))}">${esc(String(item[keyField]||"—"))}</div>
      <div class="bar-track"><div class="bar-fill cost" style="width:${pct}%"></div></div>
      <div class="bar-val">${fmt(v)}</div>
    </div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Job Lookup
// ---------------------------------------------------------------------------

async function lookupJob() {
  const type = _gv("lookup-type");
  const val  = (document.getElementById("lookup-value")||{}).value?.trim() || "";
  const el   = document.getElementById("lookup-result");
  if (!val) { el.innerHTML = '<p class="muted">Enter an ID to look up.</p>'; return; }
  el.innerHTML = '<span class="spin"></span>';
  const qs = {};
  qs[type] = val;
  const d = await get("/admin/ledger/job-lookup", qs);
  if (!d) { el.innerHTML = '<p class="muted">Request failed.</p>'; return; }
  if (!d.available && d.available !== undefined) { el.innerHTML = '<p class="muted">DB unavailable.</p>'; return; }
  if (d.error && !d.found) { el.innerHTML = `<p class="muted">${esc(d.error)}</p>`; return; }
  if (!d.found) { el.innerHTML = '<p class="muted">No job found for that ID.</p>'; return; }
  const j = d.job;
  const fmt_cost = v => v!=null ? "$"+v.toFixed(4) : "—";
  const fmt_ts   = s => s ? s.replace("T"," ").substring(0,19) : "—";
  const fmt_dur  = v => v!=null ? (v/1000).toFixed(2)+"s" : "—";
  const fields = [
    ["Job ID",          j.id],
    ["Request ID",      j.request_id],
    ["Client App",      j.client_app||"—"],
    ["Workflow",        j.workflow||"—"],
    ["Brand",           j.brand||"—"],
    ["Ext. Ref. Type",  j.external_reference_type||"—"],
    ["Ext. Ref. ID",    j.external_reference_id||"—"],
    ["Status",          null],
    ["Provider",        j.ocr_provider_used||"—"],
    ["Est. Cost",       fmt_cost(j.total_estimated_cost_usd)],
    ["Created",         fmt_ts(j.created_at)],
    ["Updated",         fmt_ts(j.updated_at)],
  ];
  const statusBadge = `<span class="tag ${esc(j.status)}">${esc(j.status)}</span>`;
  let html = `<div class="job-card">
    <div class="job-card-grid">${fields.map(([lbl,v])=>`<div class="jf">
      <span class="jf-lbl">${lbl}</span>
      <span class="jf-val">${lbl==="Status"?statusBadge:esc(String(v))}</span>
    </div>`).join("")}</div>`;
  const calls = j.provider_calls || [];
  if (calls.length) {
    html += `<div class="chart-lbl" style="margin-top:10px;margin-bottom:7px">Provider Calls (${calls.length})</div>
    <div class="sec-body" style="margin:-8px">
    <table><thead><tr>
      <th>Provider</th><th>Purpose</th><th>Status</th><th>Usage</th>
      <th>Est. Cost</th><th>Duration</th><th>Error</th><th>Started (UTC)</th>
    </tr></thead><tbody>${calls.map(c=>`<tr>
      <td class="mono">${esc(c.provider_name)}</td>
      <td>${esc(c.call_purpose||"—")}</td>
      <td><span class="tag ${esc(c.status)}">${esc(c.status)}</span></td>
      <td class="mono">${c.usage_units!=null?c.usage_units+" "+(c.usage_unit_type||""):"—"}</td>
      <td>${fmt_cost(c.estimated_cost_usd)}</td>
      <td>${fmt_dur(c.duration_ms)}</td>
      <td title="${esc(c.error_summary||"")}">${esc((c.error_summary||"—").substring(0,40))}</td>
      <td class="mono">${fmt_ts(c.started_at)}</td>
    </tr>`).join("")}</tbody></table></div>`;
  } else {
    html += '<p class="muted" style="margin-top:8px">No provider calls recorded.</p>';
  }
  html += "</div>";
  el.innerHTML = html;
}

function clearLookup() {
  const inp = document.getElementById("lookup-value");
  if (inp) inp.value = "";
  document.getElementById("lookup-result").innerHTML = "";
}

function quickLookup(jobId) {
  document.getElementById("lookup-type").value = "job_id";
  document.getElementById("lookup-value").value = jobId;
  document.getElementById("lookup-result").scrollIntoView({behavior:"smooth", block:"nearest"});
  lookupJob();
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

async function loadHealth() {
  const d = await get("/admin/ledger/health");
  const el = document.getElementById("health-body");
  if (!d) { el.innerHTML = '<p class="muted">Health data unavailable.</p>'; return; }
  const row = (lbl, val) =>
    `<tr><td style="padding:3px 16px 3px 0;color:#888;font-size:.76rem;white-space:nowrap">${lbl}</td><td>${val}</td></tr>`;
  const ok = d.db_available;
  el.innerHTML = `<table style="border-collapse:separate;border-spacing:0 3px">
    ${row("DB Available", `<span class="tag ${ok?"completed":"failed"}">${ok?"yes":"no"}</span>`)}
    ${row("REQUIRE_COST_LEDGER", `<span class="tag ${d.require_cost_ledger?"completed":"blocked"}">${d.require_cost_ledger}</span>`)}
    ${row("Async Worker", `<span class="tag ${d.async_worker_enabled?"completed":"blocked"}">${d.async_worker_enabled?"enabled":"disabled"}</span>`)}
    ${row("Primary Provider", `<span class="mono">${d.primary_provider||"—"}</span>`)}
    ${row("Fallback Provider", `<span class="mono">${d.fallback_provider||"—"}</span>`)}
    ${row("Ledger Fallback", `<span class="mono">${d.ledger_unavailable_fallback_provider||"—"}</span>`)}
    ${row("Version", `<span class="mono">${d.version}</span>`)}
  </table>
  <p style="font-size:.7rem;color:#bbb;margin-top:8px">
    Deep-check: <a href="/health/ledger" target="_blank" style="color:#aaa">/health/ledger</a>
  </p>`;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function loadProviders() {
  const d = await get("/admin/providers/config");
  const el = document.getElementById("prov-body");
  const errEl = document.getElementById("prov-errors");
  if (!d) { el.innerHTML = '<p class="muted">Provider data unavailable.</p>'; return; }
  if (d.warnings && d.warnings.length) {
    document.getElementById("warn-area").innerHTML =
      `<div class="warn-box">${d.warnings.map(w=>`&#9888; ${esc(w)}`).join("<br>")}</div>`;
  } else {
    document.getElementById("warn-area").innerHTML = "";
  }
  if (d.validation_errors && d.validation_errors.length) {
    errEl.innerHTML = `<div class="val-err"><strong>Configuration errors:</strong>
      <ul>${d.validation_errors.map(e=>`<li>${esc(e)}</li>`).join("")}</ul></div>`;
  } else { errEl.innerHTML = ""; }
  el.innerHTML = Object.entries(d.providers||{}).map(([id, p]) => {
    const roles = [
      id===d.primary_provider ? `<span class="tag completed">primary</span>` : "",
      id===d.fallback_provider ? `<span class="tag started">fallback</span>` : "",
      id===d.ledger_unavailable_fallback_provider ? `<span class="tag blocked">ledger-fb</span>` : "",
    ].filter(Boolean).join(" ") || `<span style="color:#ccc;font-size:.72rem">not assigned</span>`;
    return `<div class="prov-card">
      <div class="prov-name">${esc(p.display_name)}</div>
      <div class="prov-roles">${roles}</div>
      <div class="prov-meta"><span class="tag ${p.is_metered?"metered":"local"}">${p.is_metered?"metered":"local"}</span> ${esc(p.cost_basis)}</div>
      ${p.notes?`<div class="prov-note">${esc(p.notes)}</div>`:""}
    </div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  const d = await get("/admin/settings");
  const el = document.getElementById("settings-body");
  if (!d) { el.innerHTML = '<p class="muted">Settings data unavailable.</p>'; return; }
  const row = (lbl, val) =>
    `<tr><td style="padding:3px 16px 3px 0;color:#888;font-size:.76rem;white-space:nowrap">${lbl}</td><td>${val}</td></tr>`;
  const bt = (v, tl, fl, tc, fc) => `<span class="tag ${v?tc:fc}">${v?tl:fl}</span>`;
  const aw = d.async_worker || {};
  const pendingBanner = d.pending_restart ? `
    <div style="background:#fef3cd;border:1px solid #e6a817;border-radius:5px;padding:10px 13px;margin-bottom:12px">
      <strong>&#9888; Pending Restart</strong> — config written to .env but container not yet restarted.
      <ul style="margin:5px 0 5px 16px;font-size:.78rem">
        ${(d.changed_fields||[]).map(c=>`<li><code>${esc(c.field)}</code>: runtime <code>${esc(c.runtime_value||"—")}</code> → file <code>${esc(c.file_value||"—")}</code></li>`).join("")}
      </ul>
      Run: <code style="user-select:all">${esc(d.restart_command||"docker compose up -d --force-recreate ocr_service")}</code>
    </div>` : "";
  el.innerHTML = `${pendingBanner}
    <table style="border-collapse:separate;border-spacing:0 3px;margin-bottom:12px">
      ${row("Version",           `<span class="mono">${esc(d.service_version||"—")}</span>`)}
      ${row("Environment",       `<span class="mono">${esc(d.environment||"—")}</span>`)}
      ${row("REQUIRE_COST_LEDGER", bt(d.require_cost_ledger,"true","false","completed","warn"))}
      ${row("LLM Inference",     bt(d.llm_inference_enabled,"enabled","disabled","started","blocked"))}
      ${row("Admin Auth Mode",   `<span class="mono">${esc(d.admin_auth_mode||"—")}</span>`)}
      ${row("SSO",               bt(d.sso_enabled,"enabled","pending","completed","blocked"))}
      ${d.sso_url?row("SSO URL", `<span class="mono" style="font-size:.72rem;word-break:break-all">${esc(d.sso_url)}</span>`):""}
      ${row("Primary Provider",  `<span class="mono">${esc(d.primary_ocr_provider||"—")}</span>`)}
      ${row("Fallback Provider", `<span class="mono">${esc(d.fallback_ocr_provider||"—")}</span>`)}
      ${row("Ledger Fallback",   `<span class="mono">${esc(d.ledger_unavailable_fallback_provider||"—")}</span>`)}
      ${row("Async Worker",      bt(aw.api_container_enabled,"enabled","disabled","completed","blocked"))}
    </table>
    ${(d.warnings&&d.warnings.length)?`<div class="warn-box">${d.warnings.map(w=>`&#9888; ${esc(w)}`).join("<br>")}</div>`:""}
    <div class="info-box" style="font-size:.74rem;margin-top:6px">
      Values shown are <strong>runtime (in-memory)</strong>. After applying a config change,
      restart with <code>docker compose up -d --force-recreate ocr_service</code> and refresh.
    </div>`;
}

// ---------------------------------------------------------------------------
// Preview / Apply
// ---------------------------------------------------------------------------

async function runPreview() {
  _previewToken = null; _previewChanges = null;
  const body = {};
  const prim = _gv("prev-primary");
  const fb   = _gv("prev-fallback");
  const lfb  = _gv("prev-ledger-fb");
  const wm   = _gv("prev-worker-mode");
  if (prim) body.primary_ocr_provider = prim;
  if (fb)   body.fallback_ocr_provider = fb;
  if (lfb)  body.ledger_unavailable_fallback_provider = lfb;
  if (wm)   body.async_worker_mode = wm;
  const el = document.getElementById("preview-result");
  if (!Object.keys(body).length) {
    el.innerHTML = '<p class="muted" style="margin-top:9px">Select at least one field to preview.</p>'; return;
  }
  el.innerHTML = '<span class="spin" style="margin-top:9px;display:inline-block"></span>';
  let d;
  try {
    const r = await fetch("/admin/settings/preview", {
      method:"POST",
      headers:{...(TOKEN?{"X-Internal-Token":TOKEN}:{}),"Content-Type":"application/json","Accept":"application/json"},
      body:JSON.stringify(body)
    });
    if (!r.ok) { el.innerHTML = `<p class="muted">Preview failed (HTTP ${r.status}).</p>`; return; }
    d = await r.json();
  } catch(e) { el.innerHTML = '<p class="muted">Preview failed (network error).</p>'; return; }

  const cls = d.valid ? "ok" : "fail";
  let html = `<div class="preview-result-box ${cls}">
    <div style="display:flex;align-items:center;gap:7px;margin-bottom:9px;flex-wrap:wrap">
      <strong>Preview result</strong>
      <span class="tag ${d.valid?"completed":"failed"}">${d.valid?"Valid":"Invalid"}</span>
      ${d.requires_restart?`<span class="tag blocked">Restart required</span>`:""}
      ${d.apply_supported?`<span class="tag started">Apply available</span>`:`<span class="tag blocked">Apply not available</span>`}
      ${d.expires_at?`<span style="font-size:.7rem;color:#aaa">Expires: ${esc(d.expires_at.substring(0,19).replace("T"," "))} UTC</span>`:""}
    </div>`;
  if (d.errors&&d.errors.length) html += `<div style="margin-bottom:7px"><strong style="color:#c0392b">Errors:</strong><ul style="margin:3px 0 0 14px">${d.errors.map(e=>`<li>${esc(e)}</li>`).join("")}</ul></div>`;
  if (d.warnings&&d.warnings.length) html += `<div style="margin-bottom:7px"><strong style="color:#9a6700">Warnings:</strong><ul style="margin:3px 0 0 14px">${d.warnings.map(w=>`<li>${esc(w)}</li>`).join("")}</ul></div>`;
  if (d.would_change&&d.would_change.length) {
    html += `<div style="margin-bottom:7px"><strong>Would change:</strong>
      <ul class="chg-list">${d.would_change.map(c=>`<li>
        <span class="mono">${esc(c.field)}</span> &#8594;
        <span class="tag completed">${esc(String(c.proposed))}</span>
        <span style="color:#aaa">(was: ${esc(String(c.current))})</span>
        ${c.note?`<br><span style="color:#999;font-size:.71rem">${esc(c.note)}</span>`:""}
      </li>`).join("")}</ul></div>`;
  } else { html += `<p style="color:#888;font-size:.77rem;margin-bottom:7px">No changes from current config.</p>`; }
  if (d.apply_supported && d.preview_token) {
    _previewToken = d.preview_token; _previewChanges = body;
    html += `<div class="confirm-block">
      <label>&#9888; Type <code>${_CONFIRM_PHRASE}</code> exactly to enable Apply:</label>
      <input type="text" id="confirm-phrase" placeholder="${_CONFIRM_PHRASE}"
             oninput="onConfirmInput(this)" autocomplete="off" spellcheck="false">
      <br>
      <button class="btn-apply" id="apply-btn" disabled onclick="runApply()">Apply provider config</button>
      <p style="font-size:.71rem;color:#888;margin-top:5px">
        This writes new values to .env. The running container is NOT restarted automatically.
        After applying, run: <code>docker compose up -d --force-recreate ocr_service</code>
      </p>
    </div>`;
  } else if (d.apply_note) {
    html += `<div class="apply-note">&#9888; ${esc(d.apply_note)}</div>`;
  }
  html += `</div><div id="apply-result"></div>`;
  el.innerHTML = html;
}

function onConfirmInput(el) {
  const ok = el.value === _CONFIRM_PHRASE;
  el.className = ok ? "match" : "";
  const btn = document.getElementById("apply-btn");
  if (btn) btn.disabled = !ok;
}

async function runApply() {
  if (!_previewToken || !_previewChanges) return;
  const applyBody = {..._previewChanges, preview_token: _previewToken};
  const el = document.getElementById("apply-result");
  if (!el) return;
  el.innerHTML = '<span class="spin" style="display:inline-block;margin-top:7px"></span>';
  const btn = document.getElementById("apply-btn");
  if (btn) btn.disabled = true;
  let d;
  try {
    const r = await fetch("/admin/settings/apply", {
      method:"POST",
      headers:{...(TOKEN?{"X-Internal-Token":TOKEN}:{}),"Content-Type":"application/json","Accept":"application/json"},
      body:JSON.stringify(applyBody)
    });
    d = await r.json();
    if (!r.ok) {
      el.innerHTML = `<div class="apply-error"><strong>Apply failed:</strong> ${esc(String(d.detail||JSON.stringify(d)))}</div>`;
      return;
    }
  } catch(e) { el.innerHTML = '<div class="apply-error"><strong>Apply failed:</strong> network error.</div>'; return; }
  _previewToken = null; _previewChanges = null;
  const changed = (d.changed_fields||[]).map(c=>
    `<li><span class="mono">${esc(c.field)}</span> &#8594; <span class="tag completed">${esc(String(c.proposed))}</span> (was: ${esc(String(c.current))})</li>`
  ).join("");
  el.innerHTML = `<div class="apply-success">
    <strong>&#10003; Provider config applied.</strong>
    <ul class="chg-list" style="margin-top:7px">${changed}</ul>
    <p style="margin-top:9px;font-size:.77rem">
      <strong>Backup:</strong> <code>${esc(d.backup_filename||"")}</code><br>
      <strong>&#9888; Restart required</strong> — container still uses old config.<br>
      Run: <code style="user-select:all">${esc(d.restart_command||"")}</code>
    </p>
  </div>`;
  if ((document.getElementById("sec-settings")||{}).open) loadSettings();
}

// ---------------------------------------------------------------------------
// Full Jobs list
// ---------------------------------------------------------------------------

async function loadJobs(off) {
  jobOff = off;
  const qs = {limit: PER_PAGE, offset: off};
  if (_gv("jobs-client-app"))   qs.client_app              = _gv("jobs-client-app");
  if (_gv("jobs-workflow"))     qs.workflow                = _gv("jobs-workflow");
  if (_gv("jobs-ext-ref-type")) qs.external_reference_type = _gv("jobs-ext-ref-type");
  if (_gv("jobs-ext-ref-id"))   qs.external_reference_id   = _gv("jobs-ext-ref-id");
  if (_gv("jobs-status"))       qs.status                  = _gv("jobs-status");
  if (_gv("jobs-after"))        qs.created_after           = _gv("jobs-after");
  if (_gv("jobs-before"))       qs.created_before          = _gv("jobs-before");
  const d = await get("/admin/ledger/jobs", qs);
  const el = document.getElementById("jobs-tbl");
  if (!d || !d.available) { el.innerHTML = '<p class="muted">Jobs data unavailable.</p>'; return; }
  document.getElementById("jobs-cnt").textContent = d.total + " total";
  if (!d.items.length) { el.innerHTML = '<p class="muted">No jobs.</p>'; pager("jobs",0,PER_PAGE,0); return; }
  const fmt_cost = v => v!=null ? "$"+v.toFixed(4) : "—";
  const fmt_ts   = s => s ? s.replace("T"," ").substring(0,16) : "—";
  el.innerHTML = `<table><thead><tr>
    <th>Job ID</th><th>Client App</th><th>Workflow</th>
    <th>Provider</th><th>Status</th><th>Est. Cost</th><th>Created (UTC)</th>
  </tr></thead><tbody>${d.items.map(j=>`<tr>
    <td class="mono" title="${esc(j.id)}" style="cursor:pointer;color:#3498db"
        onclick="quickLookup('${esc(j.id)}')">${esc(j.id.substring(0,8))}…</td>
    <td>${esc(j.client_app||"—")}</td>
    <td>${esc(j.workflow||"—")}</td>
    <td class="mono">${esc(j.ocr_provider_used||"—")}</td>
    <td><span class="tag ${esc(j.status)}">${esc(j.status)}</span></td>
    <td>${fmt_cost(j.total_estimated_cost_usd)}</td>
    <td class="mono">${fmt_ts(j.created_at)}</td>
  </tr>`).join("")}</tbody></table>`;
  pager("jobs", d.offset, d.limit, d.total);
}

function clearJobFilters() {
  ["jobs-client-app","jobs-workflow","jobs-ext-ref-type","jobs-status"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  ["jobs-ext-ref-id","jobs-after","jobs-before"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  loadJobs(0);
}

// ---------------------------------------------------------------------------
// Async OCR Jobs
// ---------------------------------------------------------------------------

async function loadAsyncJobs(off) {
  asyncJobOff = off;
  const qs = {limit: PER_PAGE, offset: off};
  if (_gv("async-status"))     qs.status     = _gv("async-status");
  if (_gv("async-client-app")) qs.client_app = _gv("async-client-app");
  const d = await get("/admin/ocr/jobs", qs);
  const el = document.getElementById("async-jobs-tbl");
  if (!d || !d.available) {
    el.innerHTML = '<p class="muted">Async jobs unavailable (worker DB not connected or no jobs).</p>';
    return;
  }
  document.getElementById("async-jobs-cnt").textContent = d.total + " total";
  if (!d.items.length) { el.innerHTML = '<p class="muted">No async jobs.</p>'; pager("async-jobs",0,PER_PAGE,0); return; }
  const fmt_ts = s => s ? s.replace("T"," ").substring(0,16) : "—";
  el.innerHTML = `<table><thead><tr>
    <th>Job ID</th><th>Status</th><th>Client App</th><th>Workflow</th>
    <th>File</th><th>Attempts</th><th>Queued (UTC)</th><th>Completed (UTC)</th><th>Error</th>
  </tr></thead><tbody>${d.items.map(j=>`<tr>
    <td class="mono" title="${esc(j.job_id)}">${esc(j.job_id.substring(0,8))}…</td>
    <td><span class="tag ${esc(j.status)}">${esc(j.status)}</span></td>
    <td>${esc(j.client_app||"—")}</td>
    <td>${esc(j.workflow||"—")}</td>
    <td title="${esc(j.original_filename||"")}">${esc((j.original_filename||"—").substring(0,22))}</td>
    <td class="mono">${j.attempt_count||0}/${j.max_attempts||3}</td>
    <td class="mono">${fmt_ts(j.queued_at)}</td>
    <td class="mono">${fmt_ts(j.completed_at)}</td>
    <td title="${esc(j.error_summary||"")}">${esc((j.error_summary||"—").substring(0,38))}</td>
  </tr>`).join("")}</tbody></table>`;
  pager("async-jobs", d.offset, d.limit, d.total);
}

function clearAsyncFilters() {
  document.getElementById("async-status").value = "";
  document.getElementById("async-client-app").value = "";
  loadAsyncJobs(0);
}

// ---------------------------------------------------------------------------
// Provider Calls
// ---------------------------------------------------------------------------

async function loadCalls(off) {
  callOff = off;
  const qs = {limit: PER_PAGE, offset: off};
  if (_gv("calls-provider")) qs.provider_name = _gv("calls-provider");
  if (_gv("calls-status"))   qs.status        = _gv("calls-status");
  if (_gv("calls-after"))    qs.started_after  = _gv("calls-after");
  if (_gv("calls-before"))   qs.started_before = _gv("calls-before");
  const d = await get("/admin/ledger/provider-calls", qs);
  const el = document.getElementById("calls-tbl");
  if (!d || !d.available) { el.innerHTML = '<p class="muted">Provider call data unavailable.</p>'; return; }
  document.getElementById("calls-cnt").textContent = d.total + " total";
  if (!d.items.length) { el.innerHTML = '<p class="muted">No provider calls.</p>'; pager("calls",0,PER_PAGE,0); return; }
  const fmt_cost = v => v!=null ? "$"+v.toFixed(4) : "—";
  const fmt_ts   = s => s ? s.replace("T"," ").substring(0,16) : "—";
  const fmt_dur  = v => v!=null ? (v/1000).toFixed(2)+"s" : "—";
  el.innerHTML = `<table><thead><tr>
    <th>Provider</th><th>Purpose</th><th>Status</th><th>Usage</th>
    <th>Est. Cost</th><th>Pricing Source</th><th>Error</th><th>Duration</th><th>Started (UTC)</th>
  </tr></thead><tbody>${d.items.map(c=>`<tr>
    <td class="mono">${esc(c.provider_name)}</td>
    <td>${esc(c.call_purpose||"—")}</td>
    <td><span class="tag ${esc(c.status)}">${esc(c.status)}</span></td>
    <td class="mono">${c.usage_units!=null?c.usage_units+" "+(c.usage_unit_type||""):"—"}</td>
    <td>${fmt_cost(c.estimated_cost_usd)}</td>
    <td>${esc(c.pricing_source||"—")}</td>
    <td title="${esc(c.error_summary||"")}">${esc((c.error_summary||"—").substring(0,38))}</td>
    <td>${fmt_dur(c.duration_ms)}</td>
    <td class="mono">${fmt_ts(c.started_at)}</td>
  </tr>`).join("")}</tbody></table>`;
  pager("calls", d.offset, d.limit, d.total);
}

function clearCallFilters() {
  ["calls-provider","calls-status"].forEach(id => { const el=document.getElementById(id); if(el) el.value=""; });
  ["calls-after","calls-before"].forEach(id => { const el=document.getElementById(id); if(el) el.value=""; });
  loadCalls(0);
}

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------

async function loadAudit(off) {
  auditOff = off;
  const d = await get("/admin/audit/logs", {limit: AUDIT_PER_PAGE, offset: off});
  const el = document.getElementById("audit-tbl");
  if (!d || !d.available) {
    el.innerHTML = '<p class="muted">Audit log unavailable (DB not connected or no records).</p>'; return;
  }
  document.getElementById("audit-cnt").textContent = d.total + " total";
  if (!d.items.length) { el.innerHTML = '<p class="muted">No audit entries.</p>'; pager("audit",0,AUDIT_PER_PAGE,0); return; }
  const fmt_ts = s => s ? s.replace("T"," ").substring(0,16) : "—";
  el.innerHTML = `<table><thead><tr>
    <th>Time (UTC)</th><th>Action</th><th>Resource</th><th>Actor</th><th>IP</th><th>Result</th>
  </tr></thead><tbody>${d.items.map(a=>`<tr>
    <td class="mono">${fmt_ts(a.created_at)}</td>
    <td class="mono">${esc(a.action)}</td>
    <td>${esc(a.resource_type||"—")}</td>
    <td class="mono">${esc(a.actor_username||"—")}</td>
    <td class="mono">${esc(a.source_ip||"—")}</td>
    <td><span class="tag ${a.success?"completed":"failed"}">${a.success?"ok":"fail"}</span>
        ${a.error_summary?`<span title="${esc(a.error_summary)}" style="font-size:.7rem;color:#e74c3c"> &#9888;</span>`:""}</td>
  </tr>`).join("")}</tbody></table>`;
  pager("audit", d.offset, d.limit, d.total);
}

// ---------------------------------------------------------------------------
// Pager + utils
// ---------------------------------------------------------------------------

function pager(type, off, lim, total) {
  const el = document.getElementById(type+"-pager");
  if (!el) return;
  const page = Math.floor(off/lim)+1, pages = Math.ceil(total/lim)||1;
  const fns = {jobs:"loadJobs", calls:"loadCalls", audit:"loadAudit", "async-jobs":"loadAsyncJobs"};
  const fn = fns[type] || "loadJobs";
  el.innerHTML = `<span class="pager-info">Page ${page}/${pages} (${total} records)</span>
    <button class="pg-btn" onclick="${fn}(${off-lim})" ${off<=0?"disabled":""}>&#8592; Prev</button>
    <button class="pg-btn" onclick="${fn}(${off+lim})" ${off+lim>=total?"disabled":""}>Next &#8594;</button>`;
}

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
</script>
</body>
</html>"""


_UI_HEADERS = {
    # Signal to proxies/CDNs this is internal — does not enforce auth on the page shell.
    "X-Internal-Only": "true",
    # Do not cache: the page embeds a sessionStorage token flow.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    # All resources are inline/same-origin; no external CDN, fonts, or images.
    "Content-Security-Policy": (
        "default-src 'none'; "
        "script-src 'unsafe-inline'; "
        "style-src 'unsafe-inline'; "
        "connect-src 'self'; "
        "frame-ancestors 'none'"
    ),
}


@router.get("/ui", response_class=HTMLResponse, include_in_schema=False)
async def admin_ui_page():
    """
    Internal admin page — cost monitoring, provider config, and audit log.

    The page itself is public (no auth to load HTML).
    All data fetches within the page require X-Internal-Token via JavaScript.
    sessionStorage use is interim-only; Authentik forward-auth will handle session once NPM Plus is configured.
    Intended for trusted internal LAN access only until proper auth integration exists.
    """
    html = _HTML.replace("__VERSION__", settings.VERSION)
    return HTMLResponse(content=html, headers=_UI_HEADERS)
