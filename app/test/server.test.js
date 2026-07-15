'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');

const port = 5155;
const base = `http://127.0.0.1:${port}`;
let server;

before(async () => {
  server = spawn(process.execPath, ['server/server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(port), BIND_HOST: '127.0.0.1', QUALYS_MCP_AUDIT_LOG: __dirname + '/audit.test.jsonl' }
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start')), 5000);
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening')) { clearTimeout(timeout); resolve(); }
    });
    server.once('error', reject);
  });
});

after(() => {
  if (server && !server.killed) server.kill('SIGTERM');
});

test('security-sensitive endpoints are disabled by default', async () => {
  for (const path of ['/api/audit', '/api/qualys-cli/help']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 403);
  }
  const session = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: 'manager' }) });
  assert.equal(session.status, 403);
});

test('API rejects malformed JSON and returns security headers', async () => {
  const response = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});
