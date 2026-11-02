import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildRemoteScript,
  buildSshArgs,
  runOnHost,
  shellQuote,
  sshDestination,
} from '../lib/ssh.js'

const CONFIG = Object.freeze({
  sshBinary: 'ssh',
  connectTimeoutSec: 10,
  defaultTimeoutMs: 60000,
  maxOutputBytes: 200000,
})

/** Create an executable fake `ssh` script in a fresh temporary directory. */
async function withFakeSsh(body, run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-ssh-ssh-'))
  try {
    const binary = join(dir, 'fake-ssh')
    await writeFile(binary, '#!/bin/sh\n' + body + '\n', 'utf8')
    await chmod(binary, 0o755)
    await run(binary)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const HOST = Object.freeze({
  id: 'h1',
  name: 'prod',
  user: 'root',
  host: '10.0.0.5',
  port: 2222,
  identityFile: '/home/me/.ssh/id_ed25519',
  proxyJump: 'me@bastion:22',
})

test('shellQuote survives embedded single quotes', () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'")
})

test('sshDestination brackets IPv6 literals', () => {
  assert.equal(sshDestination({ user: 'root', host: 'example.com' }), 'root@example.com')
  assert.equal(sshDestination({ user: 'root', host: '::1' }), 'root@[::1]')
  assert.equal(sshDestination({ user: 'root', host: '[::1]' }), 'root@[::1]')
})

test('buildRemoteScript prefixes a quoted cwd only when requested', () => {
  assert.equal(buildRemoteScript('uptime', undefined), 'uptime')
  assert.equal(buildRemoteScript('uptime', '   '), 'uptime')
  assert.equal(buildRemoteScript('ls -la', "/srv/it's"), "cd -- '/srv/it'\\''s' && ls -la")
})

test('buildSshArgs is non-interactive and forwards connection facts', () => {
  const args = buildSshArgs(HOST, { command: 'uptime', cwd: '/srv/app' }, CONFIG)
  assert.deepEqual(args.slice(0, 8), [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ])
  assert.ok(args.includes('-p'))
  assert.equal(args[args.indexOf('-p') + 1], '2222')
  assert.equal(args[args.indexOf('-i') + 1], '/home/me/.ssh/id_ed25519')
  assert.equal(args[args.indexOf('-J') + 1], 'me@bastion:22')
  assert.equal(args[args.indexOf('--') + 1], 'root@10.0.0.5')
  assert.equal(args.at(-1), "cd -- '/srv/app' && uptime")
})

test('runOnHost captures argv, stdio and the exit code of a successful call', async () => {
  await withFakeSsh('printf "ARG:%s\\n" "$@"; cat; printf "done\\n"', async (binary) => {
    const result = await runOnHost(
      HOST,
      { command: 'uptime', stdin: 'piped-input' },
      { ...CONFIG, sshBinary: binary },
      undefined,
    )
    assert.equal(result.ok, true)
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /ARG:--/)
    assert.match(result.stdout, /ARG:root@10\.0\.0\.5/)
    assert.match(result.stdout, /piped-input/)
    assert.match(result.stdout, /done/)
    assert.equal(result.timedOut, false)
  })
})

test('runOnHost reports a non-zero exit as data, not as a rejection', async () => {
  await withFakeSsh('echo boom >&2; exit 7', async (binary) => {
    const result = await runOnHost(HOST, { command: 'false' }, { ...CONFIG, sshBinary: binary }, undefined)
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, 7)
    assert.match(result.stderr, /boom/)
    assert.equal(result.error, undefined)
  })
})

test('runOnHost times out and reports it', async () => {
  await withFakeSsh('exec sleep 5', async (binary) => {
    const result = await runOnHost(
      HOST,
      { command: 'sleep 5', timeoutMs: 1000 },
      { ...CONFIG, sshBinary: binary },
      undefined,
    )
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, true)
    assert.ok(result.durationMs < 4000)
  })
})

test('runOnHost honors an abort signal', async () => {
  await withFakeSsh('exec sleep 5', async (binary) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const result = await runOnHost(HOST, { command: 'sleep 5' }, { ...CONFIG, sshBinary: binary }, controller.signal)
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /aborted/)
    assert.equal(result.timedOut, false)
  })
})

test('runOnHost truncates oversized output', async () => {
  await withFakeSsh("i=0; while [ $i -lt 9000 ]; do printf 'a'; i=$((i+1)); done", async (binary) => {
    const result = await runOnHost(
      HOST,
      { command: 'yes' },
      { ...CONFIG, sshBinary: binary, maxOutputBytes: 4096 },
      undefined,
    )
    assert.equal(result.truncated, true)
    assert.equal(result.stdout.length, 4096)
  })
})

test('runOnHost reports a missing ssh binary without rejecting', async () => {
  const result = await runOnHost(HOST, { command: 'uptime' }, { ...CONFIG, sshBinary: '/nonexistent/ssh' }, undefined)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /cannot (run|start)/)
})
