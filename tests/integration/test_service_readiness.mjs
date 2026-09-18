// tests/integration/test_service_readiness.mjs
// Automated probe integration test validating /healthz and /readyz endpoints across running services

import assert from 'node:assert';

const SERVICES = [
  {
    name: 'Auth Service',
    url: 'http://localhost:8080',
    probes: [
      { path: '/healthz', expectedStatus: 200, checkBody: (data, raw) => assert.strictEqual(raw.trim(), 'ok') },
      { path: '/readyz', expectedStatus: 200, checkBody: (data) => assert.strictEqual(data.database, 'connected') },
    ],
  },
  {
    name: 'Gateway Service',
    url: 'http://localhost:8081',
    probes: [
      { path: '/healthz', expectedStatus: 200, checkBody: (data, raw) => assert.strictEqual(raw.trim(), 'ok') },
      { path: '/readyz', expectedStatus: 200, checkBody: (data) => assert.strictEqual(data.redis, 'healthy') },
      { path: '/metrics', expectedStatus: 200, checkBody: (data, raw) => assert.ok(raw.includes('gateway_')) },
    ],
  },
  {
    name: 'Media Service',
    url: 'http://localhost:8082',
    probes: [
      { path: '/healthz', expectedStatus: 200, checkBody: (data) => assert.strictEqual(data.status, 'healthy') },
    ],
  },
];

async function runReadinessTest() {
  console.log('🚀 Running Multi-Service Health & Readiness Probe Suite...');
  let totalChecks = 0;
  let passedChecks = 0;

  for (const svc of SERVICES) {
    console.log(`\n🔍 Checking [${svc.name}] (${svc.url}):`);
    for (const probe of svc.probes) {
      totalChecks++;
      const endpoint = `${svc.url}${probe.path}`;
      try {
        const res = await fetch(endpoint, { method: 'GET', headers: { 'Accept': 'application/json' } });
        assert.strictEqual(res.status, probe.expectedStatus, `Expected HTTP ${probe.expectedStatus}, got ${res.status}`);
        
        const rawText = await res.text();
        let parsedData = null;
        try {
          parsedData = JSON.parse(rawText);
        } catch {
          // Plain text response
        }

        if (probe.checkBody) {
          probe.checkBody(parsedData, rawText);
        }

        console.log(`  ✅ ${probe.path.padEnd(12)} -> HTTP ${res.status} [Verified]`);
        passedChecks++;
      } catch (err) {
        console.error(`  ❌ ${probe.path.padEnd(12)} -> FAILED: ${err.message}`);
        throw err;
      }
    }
  }

  console.log(`\n🎉 All ${passedChecks}/${totalChecks} service health and readiness probes passed!`);
}

runReadinessTest().catch((err) => {
  console.error('Fatal probe suite failure:', err);
  process.exit(1);
});
