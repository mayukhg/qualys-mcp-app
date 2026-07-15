'use strict';

const { createHash, randomUUID } = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

class RiskService {
  constructor({ root, dataFile }) {
    this.root = root; this.dataFile = dataFile;
    this.stateFile = process.env.QUALYS_RISK_STATE_FILE || path.join(root, 'logs', 'risk-state.json');
    this.source = process.env.QUALYS_DATA_SOURCE || 'mock';
    this.savedViews = new Map(); this.proposals = new Map(); this.baseline = null; this.restore();
  }
  restore() {
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.baseline = state.baseline || null;
      (state.savedViews || []).forEach((v) => this.savedViews.set(v.id, v));
      (state.proposals || []).forEach((p) => this.proposals.set(p.id, p));
    } catch {}
  }
  persist() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify({ baseline: this.baseline, savedViews: [...this.savedViews.values()], proposals: [...this.proposals.values()] }, null, 2));
  }
  async assets() {
    if (this.source !== 'live') return JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
    const { stdout } = await execFileAsync(process.env.QUALYS_CLI_PATH || 'qualys-cli', ['csam', 'risk-ranking', '--format', 'json'], { timeout: Number(process.env.QUALYS_LIVE_TIMEOUT_MS || 30000), maxBuffer: 2000000 });
    const assets = JSON.parse(stdout);
    if (!Array.isArray(assets)) throw new Error('qualys-cli did not return an asset array');
    return assets.map((a) => ({ id: String(a.id || a.assetId), name: a.name || a.hostname || String(a.id), meta: a.meta || 'Live Qualys asset', score: Number(a.score || a.truRisk || 0), sev: a.sev || a.severity || 'unknown', top: a.top || a.summary || 'No summary returned', owner: a.owner || 'unassigned', environment: a.environment || 'unknown', tags: a.tags || [], modules: a.modules || [], evidence: a.evidence || [] }));
  }
  provenance() {
    return { source: this.source, label: this.source === 'live' ? 'Live Qualys data' : 'Mock demonstration data', freshness: new Date().toISOString(), staleAfterSeconds: Number(process.env.QUALYS_DATA_STALE_AFTER_SECONDS || 900), inferredFields: ['priority.confidence', 'priority.reasons'], directSource: this.source === 'live' ? 'qualys-cli csam risk-ranking --format json' : 'app/data/assets.json' };
  }
  prioritise(asset) {
    const evidence = asset.evidence || [];
    const text = evidence.map((e) => e.text || '').join(' ').toLowerCase();
    const reasons = []; let delta = 0;
    if (/actively exploited|exploited in the wild|known.exploited/.test(text)) { delta += 18; reasons.push('known or active exploitation'); }
    if (/internet-facing|publicly accessible|open ports/.test(`${asset.meta || ''} ${text}`.toLowerCase())) { delta += 12; reasons.push('internet exposure'); }
    if (evidence.some((e) => e.mod === 'PC')) { delta += 6; reasons.push('compliance control gap'); }
    if (evidence.some((e) => e.mod === 'PM' && /no job scheduled|has not run/.test(e.text || ''))) { delta += 8; reasons.push('remediation is not complete'); }
    if (/no cloud agent|blind spot/.test(text)) { delta += 10; reasons.push('visibility coverage gap'); }
    const priority = Math.min(100, Math.round(Number(asset.score || 0) + delta)); const coverage = (asset.modules || []).length;
    return { priority, confidence: Math.min(0.98, Number((0.45 + Math.min(coverage, 6) * 0.07 + (evidence.length ? 0.1 : 0)).toFixed(2))), reasons, warnings: coverage < 2 ? ['Limited module coverage; priority may be understated.'] : [] };
  }
  async query(filters = {}) {
    const assets = await this.assets();
    return assets.filter((a) => {
      const haystack = [a.name, a.meta, a.owner, a.environment, ...(a.tags || [])].join(' ').toLowerCase();
      return (!filters.tag || (a.tags || []).map(String).map((x) => x.toLowerCase()).includes(filters.tag.toLowerCase())) &&
        (!filters.owner || String(a.owner || a.meta || '').toLowerCase().includes(filters.owner.toLowerCase())) &&
        (!filters.environment || String(a.environment || a.meta || '').toLowerCase().includes(filters.environment.toLowerCase())) &&
        (!filters.q || haystack.includes(filters.q.toLowerCase())) &&
        (!filters.minScore || Number(a.score) >= Number(filters.minScore)) &&
        (!filters.severity || String(a.sev).toLowerCase() === filters.severity.toLowerCase()) &&
        (!filters.exposure || filters.exposure !== 'internet' || /internet-facing|publicly accessible/.test(haystack));
    }).map((a) => ({ ...a, priority: this.prioritise(a) })).sort((a, b) => b.priority.priority - a.priority.priority);
  }
  saveView(input) {
    if (!input || !input.name || typeof input.filters !== 'object') throw new Error('name and filters are required');
    const view = { id: randomUUID(), name: String(input.name).slice(0, 100), filters: input.filters, createdAt: new Date().toISOString() }; this.savedViews.set(view.id, view); this.persist(); return view;
  }
  changes(current) {
    const snapshot = current.map((a) => ({ id: a.id, priority: a.priority.priority }));
    if (!this.baseline) { this.baseline = { capturedAt: new Date().toISOString(), assets: snapshot }; this.persist(); return { baselineCreated: true, changes: [] }; }
    const previous = new Map(this.baseline.assets.map((a) => [a.id, a]));
    const changes = snapshot.map((a) => ({ ...a, previous: previous.get(a.id) || null })).filter((a) => !a.previous || a.previous.priority !== a.priority).map((a) => ({ id: a.id, currentPriority: a.priority, previousPriority: a.previous && a.previous.priority, delta: a.previous ? a.priority - a.previous.priority : null }));
    this.baseline = { capturedAt: new Date().toISOString(), assets: snapshot }; this.persist(); return { baselineCreated: false, changes };
  }
  createProposal(input) {
    if (!input || !input.assetId || !input.action || !input.riskImpact || !input.rollbackPlan) throw new Error('assetId, action, riskImpact, and rollbackPlan are required');
    const proposal = { id: randomUUID(), assetId: String(input.assetId), action: String(input.action), riskImpact: String(input.riskImpact), rollbackPlan: String(input.rollbackPlan), verificationQuery: String(input.verificationQuery || 'Re-query asset evidence after the change window'), status: 'pending', createdAt: new Date().toISOString(), expiresAt: input.expiresAt || new Date(Date.now() + 86400000).toISOString(), approvals: [], execution: null };
    this.proposals.set(proposal.id, proposal); this.persist(); return proposal;
  }
  decideProposal(id, decision, input) {
    const p = this.proposals.get(id); if (!p) throw new Error('unknown proposal');
    if (!input || !input.approver || !input.justification) throw new Error('approver and justification are required');
    if (p.status !== 'pending') throw new Error('proposal is no longer pending');
    if (Date.parse(p.expiresAt) < Date.now()) { p.status = 'expired'; this.persist(); throw new Error('proposal has expired'); }
    p.approvals.push({ decision, approver: String(input.approver), justification: String(input.justification), at: new Date().toISOString() });
    if (decision === 'reject') p.status = 'rejected';
    else { p.status = 'approved'; p.execution = { status: 'queued', at: new Date().toISOString(), result: 'Demo only: no live change executed', verification: { status: 'pending', query: p.verificationQuery } }; }
    this.persist(); return p;
  }
  async deliver(type, payload) {
    const urls = { jira: process.env.JIRA_WEBHOOK_URL, servicenow: process.env.SERVICENOW_WEBHOOK_URL, slack: process.env.SLACK_WEBHOOK_URL, teams: process.env.TEAMS_WEBHOOK_URL };
    if (!urls[type]) return { delivered: false, status: 'not_configured', type, payload };
    const response = await fetch(urls[type], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return { delivered: response.ok, status: response.status, type };
  }
  report(type, assets, query) {
    if (!['executive', 'engineering', 'audit'].includes(type)) throw new Error('report type must be executive, engineering, or audit');
    return { id: createHash('sha256').update(JSON.stringify({ type, query, assets: assets.map((a) => a.id) })).digest('hex').slice(0, 16), type, generatedAt: new Date().toISOString(), query, provenance: this.provenance(), summary: { assetCount: assets.length, critical: assets.filter((a) => a.sev === 'critical').length, topPriority: assets[0] ? assets[0].priority : null }, assets: type === 'executive' ? assets.slice(0, 10).map((a) => ({ id: a.id, name: a.name, priority: a.priority, top: a.top })) : assets };
  }
}
module.exports = { RiskService };
