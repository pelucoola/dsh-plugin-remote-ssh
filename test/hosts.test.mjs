import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createHostStore, hostDestination, normalizeHost } from '../lib/hosts.js'
import { resolveConfig } from '../lib/config.js'

/** Run one test against a store backed by a fresh temporary directory. */
async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-ssh-hosts-'))
  try {
    await run(createHostStore({ file: join(dir, 'ssh-hosts.json') }), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('creates, lists, updates and removes hosts', async () => {
  await withStore(async (store) => {
    assert.deepEqual((await store.list()).hosts, [])

    const created = await store.upsert({ name: 'prod-web', host: '10.0.0.5', user: 'root', port: '2222' })
    assert.ok(created.id)
    assert.equal(created.port, 2222)
    assert.equal(hostDestination(created), 'root@10.0.0.5:2222')

    const listed = await store.list()
    assert.equal(listed.hosts.length, 1)
    assert.equal(listed.hosts[0].name, 'prod-web')

    const updated = await store.upsert({ ...created, name: 'prod-web-2', description: 'web tier' })
    assert.equal(updated.id, created.id)
    assert.equal(updated.name, 'prod-web-2')
    assert.equal(updated.description, 'web tier')

    assert.equal((await store.get('prod-web-2')).host, '10.0.0.5')
    await store.remove(created.id)
    assert.deepEqual((await store.list()).hosts, [])
  })
})

test('persists hosts across store instances and restricts file mode', async () => {
  await withStore(async (store, dir) => {
    const saved = await store.upsert({ name: 'db', host: 'db.internal' })
    const reopened = createHostStore({ file: join(dir, 'ssh-hosts.json') })
    assert.equal((await reopened.list()).hosts[0].id, saved.id)

    const info = await stat(join(dir, 'ssh-hosts.json'))
    assert.equal(info.mode & 0o777, 0o600)
    const document = JSON.parse(await readFile(join(dir, 'ssh-hosts.json'), 'utf8'))
    assert.equal(document.version, 1)
    assert.equal(document.hosts.length, 1)
  })
})

test('validates host drafts', async () => {
  await withStore(async (store) => {
    await assert.rejects(store.upsert({ name: 'x' }), /invalid host\.host/)
    await assert.rejects(store.upsert({ host: 'x' }), /invalid host\.name/)
    await assert.rejects(store.upsert({ name: 'x', host: 'a b' }), /must not contain whitespace/)
    await assert.rejects(store.upsert({ name: 'x', host: '--oProxyCommand=evil' }), /must not start with/)
    await assert.rejects(store.upsert({ name: 'x', host: 'ok', port: 70000 }), /port/)
    await assert.rejects(store.upsert({ name: 'x', host: 'ok', port: 1.5 }), /port/)
    await assert.rejects(store.upsert({ name: 'x', host: 'ok', user: '-oProxyCommand=evil' }), /must not start with/)
  })
})

test('rejects duplicate names and unknown ids', async () => {
  await withStore(async (store) => {
    const first = await store.upsert({ name: 'web', host: 'one' })
    await assert.rejects(store.upsert({ name: 'WEB', host: 'two' }), /already exists/)
    await assert.rejects(store.upsert({ id: 'missing', name: 'web2', host: 'two' }), /unknown host id/)
    await assert.rejects(store.remove('missing'), /unknown SSH host/)

    const second = await store.upsert({ name: 'web-2', host: 'two' })
    assert.notEqual(first.id, second.id)
  })
})

test('reports a corrupt hosts document instead of silently emptying it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-ssh-corrupt-'))
  try {
    const file = join(dir, 'ssh-hosts.json')
    await writeFile(file, '{ this is not json', 'utf8')
    const store = createHostStore({ file })
    await assert.rejects(store.list(), /not valid JSON/)
    await assert.rejects(store.upsert({ name: 'x', host: 'y' }), /not valid JSON/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('normalizeHost expands ~ and defaults the port', () => {
  const host = normalizeHost({ name: 'box', host: 'example.com', identityFile: '~/.ssh/id_ed25519' })
  assert.equal(host.port, 22)
  assert.ok(host.identityFile.endsWith('/.ssh/id_ed25519'))
  assert.ok(!host.identityFile.startsWith('~'))
})

test('config rejects bad values and unknown keys', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key/)
  assert.throws(() => resolveConfig({ connectTimeoutSec: 0 }), /connectTimeoutSec/)
  assert.throws(() => resolveConfig({ defaultTimeoutMs: 'soon' }), /defaultTimeoutMs/)
  const resolved = resolveConfig({ connectTimeoutSec: 3.4 })
  assert.equal(resolved.connectTimeoutSec, 3)
  assert.equal(resolved.sshBinary, 'ssh')
})
