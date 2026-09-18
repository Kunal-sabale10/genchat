import { execSync } from 'child_process';

const PG_CONTAINER = process.env.PG_CONTAINER || 'deploy-postgres-1';
const REDIS_CONTAINER = process.env.REDIS_CONTAINER || 'deploy-redis-1';
const SCYLLA_CONTAINER = process.env.SCYLLA_CONTAINER || 'deploy-scylladb-1';

console.log('=== Database Infrastructure Health Diagnostic ===\n');

let allHealthy = true;

// 1. PostgreSQL Check
try {
  process.stdout.write('[1/3] Checking PostgreSQL status... ');
  const pgReady = execSync(`docker exec ${PG_CONTAINER} pg_isready -U genchat`).toString().trim();
  if (pgReady.includes('accepting connections')) {
    const tableCount = execSync(
      `docker exec ${PG_CONTAINER} psql -U genchat -d genchat -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"`
    ).toString().trim();
    console.log(`✓ HEALTHY (ready, ${tableCount} tables in public schema)`);
  } else {
    console.log(`❌ UNHEALTHY: ${pgReady}`);
    allHealthy = false;
  }
} catch (err) {
  console.log(`❌ FAILED: ${err.message}`);
  allHealthy = false;
}

// 2. Redis Check
try {
  process.stdout.write('[2/3] Checking Redis status... ');
  const ping = execSync(`docker exec ${REDIS_CONTAINER} redis-cli ping`).toString().trim();
  if (ping === 'PONG') {
    const memory = execSync(`docker exec ${REDIS_CONTAINER} redis-cli info memory`)
      .toString()
      .split('\n')
      .find((line) => line.startsWith('used_memory_human:'))
      ?.split(':')[1]
      ?.trim() || 'unknown';
    console.log(`✓ HEALTHY (PONG confirmed, memory: ${memory})`);
  } else {
    console.log(`❌ UNHEALTHY: ${ping}`);
    allHealthy = false;
  }
} catch (err) {
  console.log(`❌ FAILED: ${err.message}`);
  allHealthy = false;
}

// 3. ScyllaDB Check
try {
  process.stdout.write('[3/3] Checking ScyllaDB status... ');
  const cluster = execSync(`docker exec ${SCYLLA_CONTAINER} cqlsh -e "DESCRIBE CLUSTER;"`).toString();
  const hasCluster = cluster.includes('Cluster:');
  if (hasCluster) {
    const keyspace = execSync(
      `docker exec ${SCYLLA_CONTAINER} cqlsh -e "DESCRIBE KEYSPACES;"`
    ).toString();
    const hasGenchat = keyspace.includes('genchat');
    console.log(`✓ HEALTHY (cluster active, genchat keyspace: ${hasGenchat ? 'FOUND' : 'MISSING'})`);
    if (!hasGenchat) allHealthy = false;
  } else {
    console.log(`❌ UNHEALTHY: Cluster description returned unexpected output`);
    allHealthy = false;
  }
} catch (err) {
  console.log(`❌ FAILED: ${err.message}`);
  allHealthy = false;
}

console.log('\n-------------------------------------------------');
if (allHealthy) {
  console.log('🎉 ALL DATABASES (POSTGRES, REDIS, SCYLLADB) ARE HEALTHY!');
  process.exit(0);
} else {
  console.log('⚠️ ONE OR MORE DATABASE HEALTH CHECKS FAILED');
  process.exit(1);
}
