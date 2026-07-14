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
const { randomUUID } = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data', 'assets.json');

const PORT = parseInt(process.env.PORT || '5050', 10);
const QUALYS_PROFILE_DEFAULT = process.env.QUALYS_PROFILE || 'analyst';
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

function audit(entry) {
  const record = {
    ts: new Date().toISOString(),
    actor: `${session.profile}.session`,
    mode: QUALYS_MCP_DENY_WRITE ? 'read-only' : 'read-write',
    ...entry
  };
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
function loadAssets() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
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
          status: 'pending'
        });
      }
    });
  });
}
seedProposals();

function proposalView(p) {
  return { id: p.id, action: p.action, status: p.status };
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
function send(res, status, body, headers) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const buf = Buffer.from(payload.slice(0, QUALYS_MCP_MAX_RESPONSE), 'utf8');
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    ...headers
  });
  res.end(buf);
}

function sendJson(res, status, obj) { send(res, status, obj); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
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
    const body = JSON.parse((await readBody(req)) || '{}');
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
    const assets = loadAssets().map((a) => ({
      id: a.id, name: a.name, meta: a.meta, score: a.score, sev: a.sev, top: a.top,
      modules: a.modules,
      lockedModules: a.modules.filter((m) => !allow.includes(m))
    }));
    audit({ tool: 'csam.risk_ranking', module: 'CSAM', result: 'ok', detail: `${assets.length} assets` });
    return sendJson(res, 200, { assets });
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

    // approve -> a human signed off, so this one pre-vetted action runs despite DENY_WRITE
    audit({ tool: 'remediation.approve', module: 'PM', result: 'ok', detail: `${prop.assetName}: ${prop.action}` });
    prop.status = 'executed';
    audit({ tool: 'remediation.execute', module: 'PM', result: 'ok', detail: `${prop.assetName}: ${prop.action}` });
    return sendJson(res, 200, { proposal: proposalView(prop) });
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
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
    audit({ tool: 'qualys_cli_help', module: 'GENERIC', result: 'ok' });
    return send(res, 200, CLI_HELP);
  }

  if (url.pathname === '/api/qualys-cli' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const command = (body.command || '').toString().slice(0, 500);
    if (!command.trim()) return sendJson(res, 400, { error: 'command required' });
    const result = runQualysCli(command);
    audit({ tool: 'qualys_cli', module: 'GENERIC', result: result.blocked ? 'denied' : 'ok', detail: command });
    return sendJson(res, result.blocked ? 403 : 200, { command, output: result.output });
  }

  if (url.pathname === '/api/audit' && req.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500);
    return sendJson(res, 200, { entries: readAudit(limit) });
  }

  return sendJson(res, 404, { error: 'no such route' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`[risk-copilot] listening on http://localhost:${PORT}`);
  console.log(`[risk-copilot] profile=${session.profile} deny_write=${QUALYS_MCP_DENY_WRITE} audit_log=${QUALYS_MCP_AUDIT_LOG}`);
});

process.on('SIGTERM', () => { console.log('[risk-copilot] SIGTERM received, shutting down'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { console.log('[risk-copilot] SIGINT received, shutting down'); server.close(() => process.exit(0)); });
