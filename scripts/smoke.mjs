#!/usr/bin/env node
/**
 * Manual smoke test for the parts of dsh-plugin-remote-ssh that do not need the DSH
 * runtime: the hosts document, the ssh argv builder and the process wrapper.
 *
 * It uses a fake `ssh` executable, so it never touches the network. Run with
 * `npm run smoke`.
 */
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHostStore, hostDestination } from '../lib/hosts.js'
import { buildSshArgs, runOnHost } from '../lib/ssh.js'
import { resolveConfig } from '../lib/config.js'

const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-remote-ssh-smoke-home-'))
process.env.DSH_HOME = home
const config = resolveConfig({})

function check(name) {
  process.stdout.write('ok - ' + name + '\n')
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-remote-ssh-smoke-'))
try {
  const store = createHostStore({ file: join(dir, 'ssh-hosts.json') })

  const host = await store.upsert({ name: 'smoke', host: '127.0.0.1', user: 'root', port: 2222 })
  assert.equal(host.port, 2222)
  assert.equal(hostDestination(host), 'root@127.0.0.1:2222')
  check('host persisted to ' + store.file)

  const listed = await store.list()
  assert.equal(listed.hosts.length, 1)
  check('host listed')

  const args = buildSshArgs(host, { command: 'echo hello', cwd: '/srv/app' }, config)
  assert.equal(args.at(-1), "cd -- '/srv/app' && echo hello")
  assert.equal(args[args.indexOf('--') + 1], 'root@127.0.0.1')
  check('ssh argv composed')

  const fake = join(dir, 'fake-ssh')
  await writeFile(
    fake,
    '#!/bin/sh\nprintf "REMOTE: %s\\n" "$@"\nexit 0\n',
    'utf8',
  )
  await chmod(fake, 0o755)

  const result = await runOnHost(host, { command: 'echo hello' }, { ...config, sshBinary: fake }, undefined)
  assert.equal(result.ok, true)
  assert.match(result.stdout, /REMOTE: root@127\.0\.0\.1/)
  check('fake ssh executed and output captured')

  const failure = await runOnHost(
    host,
    { command: 'false' },
    { ...config, sshBinary: join(dir, 'missing-ssh') },
    undefined,
  )
  assert.equal(failure.ok, false)
  assert.match(failure.error, /cannot (run|start)/)
  check('missing ssh binary surfaced as data')

  await store.remove(host.id)
  assert.equal((await store.list()).hosts.length, 0)
  check('host removed')

  process.stdout.write('\nsmoke ok\n')
} finally {
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
}
