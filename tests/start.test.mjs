import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../scripts/start.sh', import.meta.url));

function run(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acme-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const stub = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const root = process.env.TEST_ROOT;
const log = (extra = {}) => appendFileSync(join(root, 'events'), JSON.stringify({tool, args, ...extra}) + '\\n');
const value = (flag) => args[args.indexOf(flag) + 1];
if (tool === 'certbot') {
  log();
  if (process.env.FAIL_PHASE === args[0]) process.exit(12);
  if (process.env.NO_CERT === 'true') process.exit(0);
  const dir = join(value('--config-dir'), 'live', value('--cert-name'));
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'fullchain.pem'), args[0]);
  writeFileSync(join(dir, 'privkey.pem'), 'private-key');
} else if (tool === 'kubectl') {
  if (args[0] === 'create') {
    log();
    if (process.env.FAIL_CREATE === 'true') process.exit(14);
    const cert = args.find(arg => arg.startsWith('--cert=')).slice(7);
    console.log(readFileSync(cert, 'utf8'));
  } else {
    const input = readFileSync(0, 'utf8');
    log({input});
    if (process.env.FAIL_APPLY === 'true') process.exit(15);
  }
} else if (tool === 'sleep') {
  log();
  const marker = join(root, 'slept');
  if (existsSync(marker)) process.exit(99);
  writeFileSync(marker, '');
} else if (tool === 'shuf') {
  console.log('1');
} else {
  log();
}
`;
  for (const name of ['certbot', 'kubectl', 'sleep', 'shuf', 'chown']) {
    writeFileSync(join(bin, name), stub, { mode: 0o755 });
  }
  const config = join(root, 'certs');
  const env = {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    TEST_ROOT: root,
    LETSENCRYPT_CONFIG_DIR: config,
    KUBECTL: join(bin, 'kubectl'),
    LETSENCRYPT_EMAIL: 'owner@example.com',
    DNS_PROVIDER: 'cloudflare',
    CLOUDFLARE_API_TOKEN: 'test-token-never-log-this',
    LETSENCRYPT_DOMAIN: 'home.example.com',
    LETSENCRYPT_WILDCARD: 'true',
    KUBERNETES_SECRET: 'home.example.com',
    UID: '1000',
    GID: '1001',
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const result = spawnSync('bash', [script], { env, encoding: 'utf8', timeout: 10000 });
  const eventsFile = join(root, 'events');
  let events = [];
  try {
    events = readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert.equal(result.error, undefined);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('test-token-never-log-this'));
  return { ...result, events, config };
}

test('Cloudflare issues base + wildcard and publishes initial and renewed files', t => {
  const result = run(t);
  assert.equal(result.status, 99, result.stderr);
  const certbot = result.events.filter(event => event.tool === 'certbot');
  assert.deepEqual(certbot.map(event => event.args[0]), ['certonly', 'renew']);
  const initial = certbot[0].args;
  assert.ok(initial.includes('--dns-cloudflare'));
  assert.ok(!initial.includes('--manual'));
  assert.deepEqual(initial.slice(-4), ['-d', '*.home.example.com', '-d', 'home.example.com']);
  assert.ok(certbot[1].args.includes('--cert-name'));
  const publications = result.events.filter(event => event.tool === 'kubectl' && event.args[0] === 'apply');
  assert.deepEqual(publications.map(event => event.input.trim()), ['certonly', 'renew']);
  assert.ok(result.events.some(event => event.tool === 'chown' && event.args.includes('1000:1001')));
});

test('Cloudflare credentials are persisted privately for renewal', t => {
  const result = run(t);
  assert.equal(readFileSync(join(result.config, 'cloudflare.ini'), 'utf8'),
    'dns_cloudflare_api_token = test-token-never-log-this\n');
  assert.equal(statSync(join(result.config, 'cloudflare.ini')).mode & 0o777, 0o600);
});

test('existing DuckDNS configuration defaults to manual hooks and wildcard only', t => {
  const result = run(t, {
    DNS_PROVIDER: undefined,
    CLOUDFLARE_API_TOKEN: undefined,
    LETSENCRYPT_DOMAIN: undefined,
    DUCKDNS_TOKEN: 'duck-token',
    DUCKDNS_DOMAIN: 'existing.duckdns.org',
  });
  assert.equal(result.status, 99, result.stderr);
  const initial = result.events.find(event => event.tool === 'certbot').args;
  assert.ok(initial.includes('--manual'));
  assert.ok(initial.includes('--manual-auth-hook'));
  assert.ok(!initial.includes('--dns-cloudflare'));
  assert.deepEqual(initial.slice(-2), ['-d', '*.existing.duckdns.org']);
});

test('staging isolates storage and only publishes to a staging Secret', t => {
  const result = run(t, { TESTING: 'true', KUBERNETES_SECRET: 'home.example.com-staging' });
  assert.equal(result.status, 99, result.stderr);
  const initial = result.events.find(event => event.tool === 'certbot').args;
  assert.ok(initial.includes('--test-cert'));
  assert.equal(initial[initial.indexOf('--config-dir') + 1], join(result.config, 'staging'));
  assert.equal(initial[initial.indexOf('--dns-cloudflare-credentials') + 1],
    join(result.config, 'staging', 'cloudflare.ini'));
});

test('staging cannot overwrite a production TLS Secret', t => {
  const result = run(t, { TESTING: 'true' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ending in -staging/);
  assert.ok(!result.events.some(event => event.tool === 'certbot'));
});

test('standalone non-wildcard issuance does not require Kubernetes', t => {
  const result = run(t, { KUBERNETES_SECRET: '', LETSENCRYPT_WILDCARD: 'false' });
  assert.equal(result.status, 99, result.stderr);
  assert.ok(!result.events.some(event => event.tool === 'kubectl'));
  assert.deepEqual(result.events.find(event => event.tool === 'certbot').args.slice(-2),
    ['-d', 'home.example.com']);
});

for (const [name, overrides, message] of [
  ['missing token', { CLOUDFLARE_API_TOKEN: '' }, /CLOUDFLARE_API_TOKEN is required/],
  ['unsupported provider', { DNS_PROVIDER: 'other' }, /Unsupported DNS_PROVIDER/],
  ['DuckDNS domain with Cloudflare', { LETSENCRYPT_DOMAIN: 'existing.duckdns.org' }, /cannot manage a DuckDNS/],
  ['invalid propagation interval', { CLOUDFLARE_PROPAGATION_SECONDS: 'oops' }, /non-negative integer/],
]) {
  test(`rejects ${name} before issuing`, t => {
    const result = run(t, overrides);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.ok(!result.events.some(event => event.tool === 'certbot'));
  });
}

for (const [name, overrides, status] of [
  ['initial issuance', { FAIL_PHASE: 'certonly' }, 12],
  ['renewal', { FAIL_PHASE: 'renew' }, 12],
  ['Secret generation', { FAIL_CREATE: 'true' }, 14],
  ['Secret publication', { FAIL_APPLY: 'true' }, 15],
  ['missing certificate files', { NO_CERT: 'true' }, 1],
]) {
  test(`propagates ${name} failures`, t => {
    const result = run(t, overrides);
    assert.equal(result.status, status, result.stderr);
    if (overrides.FAIL_PHASE === 'certonly' || overrides.NO_CERT) {
      assert.ok(!result.events.some(event => event.tool === 'kubectl'));
    }
    if (overrides.FAIL_PHASE === 'renew') {
      assert.equal(result.events.filter(event => event.tool === 'kubectl' && event.args[0] === 'apply').length, 1);
    }
  });
}
