'use strict';
/**
 * Risk Copilot demo backend.
 *
 * Mirrors the tool/module contract of qualys-cli-mcp (https://pypi.org/project/qualys-cli-mcp/)
 * against local mock data, since no live Qualys tenant/credentials are available in this
 * environment. Swap `loadAssets()` and `runQualysCli()` for real qualys-cli calls to go live —
 * the route surface, module allowlisting, and audit logging are already shaped to match.
 *
 * Zero external dependencies: Node's built-in http/fs only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data', 'assets.json');

const PORT = parseInt(process.env.PORT || '5050', 10);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const QUALYS_PROFILE_DEFAULT = process.env.QUALYS_PROFILE || 'analyst';
const QUALYS_MCP_ALLOW_PROFILE_SWITCH = process.env.QUALYS_MCP_ALLOW_PROFILE_SWITCH === '1';
const QUALYS_MCP_ENABLE_GENERIC_CLI = process.env.QUALYS_MCP_ENABLE_GENERIC_CLI === '1';
const QUALYS_MCP_EXPOSE_AUDIT = process.env.QUALYS_MCP_EXPOSE_AUDIT === '1';
const QUALYS_MCP_LIVE = process.env.QUALYS_MCP_LIVE === '1';
const QUALYS_CLI_PATH = process.env.QUALYS_CLI_PATH || 'qualys-cli';
const QUALYS_CLI_TIMEOUT = Number.parseInt(process.env.QUALYS_CLI_TIMEOUT || '30000', 10);
const QUALYS_TENANT = process.env.QUALYS_TENANT || 'mock-tenant';
const views = new Map();
const QUALYS_MCP_DENY_WRITE = process.env.QUALYS_MCP_DENY_WRITE !== '0'; // default: read-only ON
const QUALYS_MCP_AUDIT_LOG = process.env.QUALYS_MCP_AUDIT_LOG
  || path.join(ROOT, 'logs', 'mcp-audit.jsonl');
const QUALYS_MCP_MAX_RESPONSE = parseInt(process.env.QUALYS_MCP_MAX_RESPONSE || '800000', 10);
const SIMULATED_LATENCY_MS = parseInt(process.env.QUALYS_MCP_DEMO_LATENCY_MS || '220', 10);
// A narrow, pre-vetted exception to QUALYS_MCP_DENY_WRITE: specific, evidence-backed remediation
// actions (see `proposals` below) can still run if a human approves them, even in a read-only
// session. This does not open up arbitrary writes — the generic passthrough stays blocked by
// QUALYS_MCP_DENY_WRITE regardless. Set to '0' to disable this lane entirely (fully locked down).
const QUALYS_MCP_ALLOW_APPROVED_REMEDIATION = process.env.QUALYS_MCP_ALLOW_APPROVED_REMEDIATION !== '0';

const PROFILE_ALLOW = {
  analyst: ['CSAM', 'VM', 'PC', 'WAS', 'TC', 'CS', 'PM', 'CA'],
  manager: ['CSAM', 'VM', 'WAS']
};

// ---- in-memory session state (single-operator local demo) -----------------
const session = {
  id: randomUUID(),
  profile: PROFILE_ALLOW[QUALYS_PROFILE_DEFAULT] ? QUALYS_PROFILE_DEFAULT : 'analyst'
};

// ---- audit log --------------------------------------------------------------
fs.mkdirSync(path.dirname(QUALYS_MCP_AUDIT_LOG), { recursive: true });
let auditHead = '';

function redact(value) {
  return String(value || '').replace(/(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,]+/gi, '$1=[REDACTED]');
}

function audit(entry) {
  const record = {
    ts: new Date().toISOString(),
    actor: `${session.profile}.session`,
    mode: QUALYS_MCP_DENY_WRITE ? 'read-only' : 'read-write',
    ...entry,
    detail: redact(entry.detail),
    previousHash: auditHead
  };
  record.hash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  auditHead = record.hash;
  fs.appendFileSync(QUALYS_MCP_AUDIT_LOG, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

function readAudit(limit) {
  if (!fs.existsSync(QUALYS_MCP_AUDIT_LOG)) return [];
  const lines = fs.readFileSync(QUALYS_MCP_AUDIT_LOG, 'utf8').trim().split('\n').filter(Boolean);
  const parsed = lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return parsed.slice(-limit).reverse();
}

// ---- mock data ---------------------------------------------------------------
function loadMockAssets() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

// Optional live adapter. It expects the installed qualys-cli to return JSON for this
// stable command; failures fall back to mock data only when explicitly allowed.
function loadAssets() {
  if (!QUALYS_MCP_LIVE) return loadMockAssets();
  try {
    const raw = execFileSync(QUALYS_CLI_PATH, ['csam', 'risk-ranking', '--format', 'json'], { encoding: 'utf8', timeout: QUALYS_CLI_TIMEOUT });
    const parsed = JSON.parse(raw);
    const assets = Array.isArray(parsed) ? parsed : (parsed.assets || parsed.data || []);
    if (!Array.isArray(assets)) throw new Error('live adapter returned no assets array');
    return assets.map(normalizeLiveAsset);
  } catch (err) {
    if (process.env.QUALYS_MCP_LIVE_FALLBACK !== '1') throw new Error(`live Qualys adapter failed: ${err.message}`);
    return loadMockAssets();
  }
}

function normalizeLiveAsset(asset) {
  return {
    id: String(asset.id || asset.assetId || asset.name),
    name: asset.name || asset.hostname || String(asset.id),
    meta: asset.meta || asset.description || '',
    score: Number(asset.score || asset.truRiskScore || 0),
    sev: asset.sev || asset.severity || 'unknown',
    top: asset.top || asset.topFinding || 'No summary supplied by Qualys',
    modules: asset.modules || ['CSAM'],
    evidence: asset.evidence || []
  };
}

function assetMatches(asset, query) {
  const text = `${asset.name} ${asset.meta} ${asset.top} ${asset.modules.join(' ')}`.toLowerCase();
  if (query.q && !text.includes(query.q.toLowerCase())) return false;
  if (query.tag && !text.includes(query.tag.toLowerCase())) return false;
  if (query.owner && !text.includes(query.owner.toLowerCase())) return false;
  if (query.environment && !text.includes(query.environment.toLowerCase())) return false;
  if (query.severity && asset.sev.toLowerCase() !== query.severity.toLowerCase()) return false;
  if (query.module && !asset.modules.includes(query.module.toUpperCase())) return false;
  return true;
}

function filteredAssets(query = {}) {
  return loadAssets().filter((asset) => assetMatches(asset, query));
}

function explainRisk(asset) {
  const evidence = Array.isArray(asset.evidence) ? asset.evidence : [];
  const factors = [];
  if (asset.score >= 90) factors.push({ factor: 'high_tru_risk', impact: 'high', reason: 'TruRisk score is at least 90' });
  if (/internet|public|exposed/i.test(asset.meta)) factors.push({ factor: 'external_exposure', impact: 'high', reason: 'Asset metadata indicates internet/public exposure' });
  if (evidence.some((e) => /actively exploited|known.exploit|kev/i.test(e.text || ''))) factors.push({ factor: 'known_exploitation', impact: 'high', reason: 'Evidence indicates known or active exploitation' });
  if (evidence.some((e) => e.mod === 'CA' && /no cloud agent|coverage gap/i.test(e.text || ''))) factors.push({ factor: 'coverage_gap', impact: 'medium', reason: 'Cloud Agent coverage is missing' });
  const confidence = Math.max(0.35, Math.min(0.99, 0.45 + (evidence.length * 0.1) - (factors.some((f) => f.factor === 'coverage_gap') ? 0.15 : 0)));
  return { factors, confidence: Number(confidence.toFixed(2)), missingData: factors.some((f) => f.factor === 'coverage_gap') ? ['Cloud Agent coverage'] : [] };
}

function allowedModules() {
  return PROFILE_ALLOW[session.profile] || [];
}

function moduleAllowed(mod) {
  return allowedModules().includes(mod);
}

// ---- approval-gated remediation proposals ------------------------------------
// Seeded once from the `proposal` field on PM evidence in assets.json, then tracked
// in memory for the life of the process (a real implementation would persist this).
const proposals = new Map();

function seedProposals() {
  loadAssets().forEach((asset) => {
    asset.evidence.forEach((e) => {
      if (e.proposal && !proposals.has(e.proposal.id)) {
        proposals.set(e.proposal.id, {
          id: e.proposal.id,
          assetId: asset.id,
          assetName: asset.name,
          action: e.proposal.action,
          status: 'pending',
          impact: e.proposal.impact || 'Changes a Qualys remediation job state',
          rollback: e.proposal.rollback || 'Revert the job in Qualys and re-run verification',
          expiresAt: e.proposal.expiresAt || new Date(Date.now() + 86400000).toISOString(),
          approver: null,
          justification: null,
          verification: null
        });
      }
    });
  });
}
seedProposals();

function sourceInfo() {
  return { mode: QUALYS_MCP_LIVE ? 'live' : 'mock', tenant: QUALYS_TENANT, queriedAt: new Date().toISOString(), adapter: QUALYS_MCP_LIVE ? 'qualys-cli' : 'assets.json' };
}

function proposalView(p) {
  return { id: p.id, action: p.action, status: p.status, impact: p.impact, rollback: p.rollback, expiresAt: p.expiresAt, approver: p.approver, justification: p.justification, verification: p.verification };
}

// ---- simple keyword router standing in for LLM tool-selection ---------------
function routeChat(message) {
  const m = message.toLowerCase();
  const assets = loadAssets();

  const named = assets.find((a) => m.includes(a.name.toLowerCase()) || m.includes(a.id));
  if (named) {
    const allow = allowedModules();
    const visible = named.evidence.filter((e) => allow.includes(e.mod));
    if (!visible.length) {
      return {
        reply: `${named.name} has no evidence visible under the ${session.profile} allowlist.`,
        tool: 'csam.risk_ranking',
        module: 'CSAM'
      };
    }
    const lead = visible[0];
    return {
      reply: `${named.name} scores ${named.score}: ${named.top.toLowerCase()}. Expanded it in the workbench.`,
      tool: lead.tool,
      module: lead.mod,
      focusAsset: named.id
    };
  }

  if (/(agent|coverage|blind ?spot|missing)/.test(m)) {
    const gaps = assets.filter((a) => a.evidence.some((e) => e.mod === 'CA' && /no cloud agent/i.test(e.text)));
    return {
      reply: gaps.length
        ? `${gaps.length} asset${gaps.length > 1 ? 's have' : ' has'} no Cloud Agent installed — ${gaps.map((a) => a.name).join(', ')}. Their scores may be understated.`
        : 'No agent coverage gaps found across in-scope assets.',
      tool: 'ca.inventory',
      module: 'CA'
    };
  }

  if (/(patch|pm\.|remediat)/.test(m)) {
    return {
      reply: 'One job already covers the Log4Shell fix but has not run yet. The kernel CVE on the checkout node has a patch with no job scheduled.',
      tool: 'pm.jobs',
      module: 'PM'
    };
  }

  if (/(compliance|posture|cis|control)/.test(m)) {
    return {
      reply: 'Two assets are failing hardening controls: SSH root login on the checkout host, and an unencrypted RDS instance.',
      tool: 'pc.posture',
      module: 'PC'
    };
  }

  // default: rank
  return {
    reply: `Pulled CSAM risk ranking across all connected modules — ${assets.length} assets shown, sorted by TruRisk score.`,
    tool: 'csam.risk_ranking',
    module: 'CSAM'
  };
}

// ---- generic qualys_cli() passthrough (demo-scale command matcher) ----------
const WRITE_PATTERN = /\b(create|delete|remove|update|launch|start|stop|patch\s+apply|deploy|set|modify|purge)\b/i;
const READ_MOCKS = [
  { match: /kb\s+get.*cve[-_ ]?2021-44228/i, out: 'CVE-2021-44228 · Apache Log4j2 RCE (Log4Shell) · CVSS 10.0 · Actively exploited · Published 2021-12-10.' },
  { match: /vm\s+(list|detections)/i, out: 'Returned 14 detections across 5 hosts (mock). Use /api/assets/:id/evidence for structured data.' },
  { match: /help/i, out: null } // handled separately
];

function runQualysCli(command) {
  if (QUALYS_MCP_DENY_WRITE && WRITE_PATTERN.test(command)) {
    return { blocked: true, output: `blocked: '${command}' looks like a write operation and QUALYS_MCP_DENY_WRITE=1 is enforced for this session.` };
  }
  const hit = READ_MOCKS.find((r) => r.match.test(command));
  if (hit) return { blocked: false, output: hit.out };
  return { blocked: false, output: `No mock response wired for '${command}' in this demo. In production this proxies to the qualys-cli binary.` };
}

const CLI_HELP = [
  'qualys-cli — curated command groups (demo subset):',
  '  vm detections|hosts|kb          Vulnerability Management',
  '  pc posture                      Policy Compliance',
  '  was findings                    Web Application Scanning',
  '  tc connectors|cdr                TotalCloud / CSPM',
  '  cs image-scan                   Container Security',
  '  csam risk-ranking|inventory     Asset Management',
  '  pm jobs|patches                 Patch Management',
  '  ca inventory                    Cloud Agent'
].join('\n');

// ---- HTTP plumbing ------------------------------------------------------------
function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const buf = Buffer.from(payload.slice(0, QUALYS_MCP_MAX_RESPONSE), 'utf8');
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'",
    ...headers
  });
  res.end(buf);
}

function sendJson(res, status, obj) { send(res, status, obj); }

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('request body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw || '{}'); }
  catch { const error = new Error('invalid JSON body'); error.statusCode = 400; throw error; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { send(res, 403, 'Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { send(res, 404, 'Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  await new Promise((r) => setTimeout(r, SIMULATED_LATENCY_MS)); // stand-in for real Qualys API round-trip

  if (url.pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, source: sourceInfo(), genericCliEnabled: QUALYS_MCP_ENABLE_GENERIC_CLI });
  }

  if (url.pathname === '/api/assets' && req.method === 'GET') {
    const query = Object.fromEntries(url.searchParams.entries());
    return sendJson(res, 200, { assets: filteredAssets(query).map((a) => ({ ...a, risk: explainRisk(a), source: sourceInfo() })), filters: query, source: sourceInfo() });
  }

  if (url.pathname === '/api/views' && req.method === 'GET') {
    return sendJson(res, 200, { views: [...views.values()] });
  }

  if (url.pathname === '/api/views' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.name || typeof body.filters !== 'object') return sendJson(res, 400, { error: 'name and filters are required' });
    const view = { id: randomUUID(), name: String(body.name).slice(0, 100), filters: body.filters, createdAt: new Date().toISOString() };
    views.set(view.id, view);
    return sendJson(res, 201, view);
  }

  if (url.pathname.startsWith('/api/views/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    if (!views.delete(id)) return sendJson(res, 404, { error: 'unknown view' });
    return sendJson(res, 204, '');
  }

  if (url.pathname === '/api/integrations/notify' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const event = { type: body.type || 'risk-report', assetIds: body.assetIds || [], message: String(body.message || '').slice(0, 1000), createdAt: new Date().toISOString(), source: sourceInfo() };
    const targets = [];
    for (const [name, env] of [['slack', 'QUALYS_SLACK_WEBHOOK_URL'], ['teams', 'QUALYS_TEAMS_WEBHOOK_URL'], ['ticket', 'QUALYS_TICKET_WEBHOOK_URL']]) {
      if (process.env[env]) targets.push({ name, url: process.env[env] });
    }
    if (!targets.length) return sendJson(res, 202, { delivered: false, dryRun: true, event, message: 'No integration webhook configured' });
    const results = [];
    for (const target of targets) {
      try {
        const response = await fetch(target.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
        results.push({ target: target.name, status: response.status, ok: response.ok });
      } catch (err) { results.push({ target: target.name, ok: false, error: err.message }); }
    }
    audit({ tool: 'integration.notify', module: 'WORKFLOW', result: results.every((r) => r.ok) ? 'ok' : 'partial', detail: targets.map((t) => t.name).join(',') });
    return sendJson(res, 200, { delivered: true, results, event });
  }

  if (url.pathname === '/api/reports' && req.method === 'GET') {
    const query = Object.fromEntries(url.searchParams.entries());
    const assets = filteredAssets(query).map((a) => ({ ...a, risk: explainRisk(a), source: sourceInfo() }));
    const format = (query.format || 'json').toLowerCase();
    if (format === 'csv') {
      const rows = ['id,name,severity,score,confidence,missingData,source'];
      assets.forEach((a) => rows.push([a.id, a.name, a.sev, a.score, a.risk.confidence, a.risk.missingData.join('|'), sourceInfo().mode].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')));
      return send(res, 200, rows.join('\\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="qualys-risk-report.csv"' });
    }
    return sendJson(res, 200, { reportType: 'risk-summary', generatedAt: new Date().toISOString(), filters: query, assets, source: sourceInfo() });
  }

  if (url.pathname === '/api/session' && req.method === 'GET') {
    return sendJson(res, 200, {
      profile: session.profile,
      mode: QUALYS_MCP_DENY_WRITE ? 'read-only' : 'read-write',
      allowedModules: allowedModules(),
      allModules: ['CSAM', 'VM', 'PC', 'WAS', 'TC', 'CS', 'PM', 'CA'],
      allowApprovedRemediation: QUALYS_MCP_ALLOW_APPROVED_REMEDIATION
    });
  }

  if (url.pathname === '/api/session' && req.method === 'POST') {
    if (!QUALYS_MCP_ALLOW_PROFILE_SWITCH) return sendJson(res, 403, { error: 'profile switching is disabled; set QUALYS_MCP_ALLOW_PROFILE_SWITCH=1 only in a trusted local demo.' });
    const body = await readJsonBody(req);
    if (!PROFILE_ALLOW[body.profile]) return sendJson(res, 400, { error: 'unknown profile' });
    session.profile = body.profile;
    audit({ tool: 'session.set_profile', module: 'SESSION', result: 'ok', detail: session.profile });
    return sendJson(res, 200, { profile: session.profile, allowedModules: allowedModules() });
  }

  if (url.pathname === '/api/csam/risk-ranking' && req.method === 'GET') {
    if (!moduleAllowed('CSAM')) {
      audit({ tool: 'csam.risk_ranking', module: 'CSAM', result: 'denied' });
      return sendJson(res, 403, { error: 'CSAM is not in the current module allowlist' });
    }
    const allow = allowedModules();
    const query = Object.fromEntries(url.searchParams.entries());
    const assets = filteredAssets(query).map((a) => ({
      id: a.id, name: a.name, meta: a.meta, score: a.score, sev: a.sev, top: a.top,
      modules: a.modules,
      lockedModules: a.modules.filter((m) => !allow.includes(m)),
      risk: explainRisk(a),
      source: sourceInfo()
    }));
    audit({ tool: 'csam.risk_ranking', module: 'CSAM', result: 'ok', detail: `${assets.length} assets` });
    return sendJson(res, 200, { assets, filters: query, source: sourceInfo() });
  }

  const evidenceMatch = url.pathname.match(/^\/api\/assets\/([\w-]+)\/evidence$/);
  if (evidenceMatch && req.method === 'GET') {
    const asset = loadAssets().find((a) => a.id === evidenceMatch[1]);
    if (!asset) return sendJson(res, 404, { error: 'unknown asset' });
    const allow = allowedModules();
    const visible = asset.evidence.filter((e) => allow.includes(e.mod)).map((e) => {
      if (!e.proposal) return e;
      const live = proposals.get(e.proposal.id);
      return { ...e, proposal: live ? proposalView(live) : e.proposal };
    });
    const restrictedModules = [...new Set(asset.evidence.filter((e) => !allow.includes(e.mod)).map((e) => e.mod))];
    visible.forEach((e) => audit({ tool: e.tool, module: e.mod, result: 'ok', detail: asset.name }));
    if (restrictedModules.length) audit({ tool: 'evidence.restricted', module: restrictedModules.join(','), result: 'denied', detail: asset.name });
    return sendJson(res, 200, { asset: asset.name, evidence: visible, restrictedModules });
  }

  const remediationMatch = url.pathname.match(/^\/api\/remediation\/([\w-]+)\/(approve|reject)$/);
  if (remediationMatch && req.method === 'POST') {
    const [, propId, decision] = remediationMatch;
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const prop = proposals.get(propId);
    if (!prop) return sendJson(res, 404, { error: 'unknown proposal' });

    if (!QUALYS_MCP_ALLOW_APPROVED_REMEDIATION) {
      audit({ tool: `remediation.${decision}`, module: 'PM', result: 'denied', detail: `${prop.id}: remediation lane disabled` });
      return sendJson(res, 403, { error: 'Approved remediation is disabled for this session (QUALYS_MCP_ALLOW_APPROVED_REMEDIATION=0).' });
    }
    if (!moduleAllowed('PM')) {
      audit({ tool: `remediation.${decision}`, module: 'PM', result: 'denied', detail: `${prop.id}: PM outside ${session.profile} allowlist` });
      return sendJson(res, 403, { error: 'PM is not in the current module allowlist.' });
    }
    if (prop.status !== 'pending') {
      return sendJson(res, 409, { error: `Proposal is already ${prop.status}.`, proposal: proposalView(prop) });
    }

    if (decision === 'reject') {
      prop.status = 'rejected';
      audit({ tool: 'remediation.reject', module: 'PM', result: 'ok', detail: `${prop.assetName}: ${prop.action}` });
      return sendJson(res, 200, { proposal: proposalView(prop) });
    }

    // Approvals are explicit, expiring, and attributable even in this local demo.
    if (decision === 'approve') {
      if (!body.approver || !body.justification) return sendJson(res, 400, { error: 'approver and justification are required' });
      if (Date.parse(prop.expiresAt) < Date.now()) return sendJson(res, 409, { error: 'proposal has expired' });
      prop.approver = String(body.approver).slice(0, 120);
      prop.justification = String(body.justification).slice(0, 500);
      audit({ tool: 'remediation.approve', module: 'PM', result: 'ok', detail: `${prop.assetName}: ${prop.action}` });
      prop.status = 'executed';
      prop.verification = { status: 'pending', requestedAt: new Date().toISOString(), query: `verify remediation for ${prop.assetName}` };
      audit({ tool: 'remediation.execute', module: 'PM', result: 'ok', detail: `${prop.assetName}: ${prop.action}` });
      return sendJson(res, 200, { proposal: proposalView(prop) });
    }
    return sendJson(res, 400, { error: 'unsupported remediation decision' });
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const message = (body.message || '').toString().slice(0, 2000);
    if (!message.trim()) return sendJson(res, 400, { error: 'message required' });
    const result = routeChat(message);
    const allowed = moduleAllowed(result.module) || result.module === 'CSAM';
    const record = audit({ tool: result.tool, module: result.module, result: allowed ? 'ok' : 'denied', detail: message.slice(0, 120) });
    const reply = allowed
      ? result.reply
      : `${result.module} is outside the ${session.profile} allowlist, so I can't pull that. Ask Security for a report, or switch to a profile with access.`;
    return sendJson(res, 200, { reply, citation: allowed ? result.tool : null, focusAsset: allowed ? (result.focusAsset || null) : null, auditTs: record.ts });
  }

  if (url.pathname === '/api/qualys-cli/help' && req.method === 'GET') {
    if (!QUALYS_MCP_ENABLE_GENERIC_CLI) return sendJson(res, 403, { error: 'generic CLI passthrough is disabled by default.' });
    audit({ tool: 'qualys_cli_help', module: 'GENERIC', result: 'ok' });
    return send(res, 200, CLI_HELP);
  }

  if (url.pathname === '/api/qualys-cli' && req.method === 'POST') {
    if (!QUALYS_MCP_ENABLE_GENERIC_CLI) return sendJson(res, 403, { error: 'generic CLI passthrough is disabled by default.' });
    const body = await readJsonBody(req);
    const command = (body.command || '').toString().slice(0, 500);
    if (!command.trim()) return sendJson(res, 400, { error: 'command required' });
    const result = runQualysCli(command);
    audit({ tool: 'qualys_cli', module: 'GENERIC', result: result.blocked ? 'denied' : 'ok', detail: command });
    return sendJson(res, result.blocked ? 403 : 200, { command, output: result.output });
  }

  if (url.pathname === '/api/audit' && req.method === 'GET') {
    if (!QUALYS_MCP_EXPOSE_AUDIT) return sendJson(res, 403, { error: 'audit-log retrieval is disabled by default.' });
    const requested = Number.parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 500) : 50;
    return sendJson(res, 200, { entries: readAudit(limit) });
  }

  return sendJson(res, 404, { error: 'no such route' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error(err);
      sendJson(res, err.statusCode || 500, { error: err.statusCode ? err.message : 'internal error' });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`[risk-copilot] listening on http://${BIND_HOST}:${PORT}`);
  console.log(`[risk-copilot] profile=${session.profile} deny_write=${QUALYS_MCP_DENY_WRITE} audit_log=${QUALYS_MCP_AUDIT_LOG}`);
});

process.on('SIGTERM', () => { console.log('[risk-copilot] SIGTERM received, shutting down'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { console.log('[risk-copilot] SIGINT received, shutting down'); server.close(() => process.exit(0)); });
