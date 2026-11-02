import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import {
  buildRemoteScript,
  buildSshArgs,
  controlSocketPath,
  disconnectHost,
  resolveTimeouts,
  reuseSupported,
  runOnHost,
  shellQuote,
  sshDestination,
} from '../lib/ssh.js'

const CONFIG = resolveConfig({})

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

/**
 * Run one test with an isolated `$DSH_HOME`, so control-socket paths and the
 * master directory never touch the real user home.
 */
async function withTempHome(run) {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-ssh-home-'))
  process.env.DSH_HOME = home
  try {
    await run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
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

test('buildSshArgs is non-interactive, reuses a master and forwards connection facts', () => {
  const args = buildSshArgs(HOST, { command: 'uptime', cwd: '/srv/app' }, CONFIG)
  assert.ok(args.includes('BatchMode=yes'))
  assert.ok(args.includes('ControlMaster=auto'))
  assert.ok(args.includes('ControlPersist=300'))
  const controlPath = args.find((entry) => entry.startsWith('ControlPath='))
  assert.ok(controlPath !== undefined)
  assert.match(controlPath, /\/ssh-masters\/m-[0-9a-f]{16}\.sock$/)
  assert.equal(args[args.indexOf('-p') + 1], '2222')
  assert.equal(args[args.indexOf('-i') + 1], '/home/me/.ssh/id_ed25519')
  assert.equal(args[args.indexOf('-J') + 1], 'me@bastion:22')
  assert.equal(args[args.indexOf('--') + 1], 'root@10.0.0.5')
  assert.equal(args.at(-1), "cd -- '/srv/app' && uptime")
})

test('buildSshArgs omits multiplexing when reuse is disabled', () => {
  const args = buildSshArgs(HOST, { command: 'uptime' }, { ...CONFIG, reuseSession: false })
  assert.ok(!args.some((entry) => entry.startsWith('ControlMaster=') || entry.startsWith('ControlPath=')))
})

test('the control socket follows the connection identity, not the host record id', () => {
  const a = controlSocketPath({ ...HOST, id: 'one' })
  const b = controlSocketPath({ ...HOST, id: 'two' })
  const other = controlSocketPath({ ...HOST, port: 22 })
  assert.equal(a, b)
  assert.notEqual(a, other)
  assert.ok(reuseSupported(CONFIG))
  assert.equal(reuseSupported({ ...CONFIG, reuseSession: false }), false)
})

test('resolveTimeouts clamps the idle window and never caps below it', () => {
  assert.deepEqual(resolveTimeouts(undefined, 120000, 3600000), { idleTimeoutMs: 120000, maxTimeMs: 3600000 })
  assert.deepEqual(resolveTimeouts(500, 120000, 3600000), { idleTimeoutMs: 1000, maxTimeMs: 3600000 })
  assert.deepEqual(resolveTimeouts(7200000, 120000, 3600000), { idleTimeoutMs: 7200000, maxTimeMs: 7200000 })
  assert.deepEqual(resolveTimeouts(undefined, undefined, undefined), { idleTimeoutMs: 120000, maxTimeMs: 3600000 })
})

test('runOnHost captures argv, stdio and the exit code of a successful call', async () => {
  await withTempHome(async () => {
    await withFakeSsh('printf "ARG:%s\\n" "$@"; cat; printf "done\\n"', async (binary) => {
      const result = await runOnHost(
        HOST,
        { command: 'uptime', stdin: 'piped-input' },
        { ...CONFIG, sshBinary: binary },
        undefined,
      )
      assert.equal(result.ok, true)
      assert.equal(result.exitCode, 0)
      assert.equal(result.timeoutKind, 'none')
      assert.equal(result.timedOut, false)
      assert.match(result.stdout, /ARG:--/)
      assert.match(result.stdout, /ARG:root@10\.0\.0\.5/)
      assert.match(result.stdout, /piped-input/)
      assert.match(result.stdout, /done/)
      assert.equal(result.sessionReused, false)
    })
  })
})

test('runOnHost reports a non-zero exit as data, not as a rejection', async () => {
  await withTempHome(async () => {
    await withFakeSsh('echo boom >&2; exit 7', async (binary) => {
      const result = await runOnHost(HOST, { command: 'false' }, { ...CONFIG, sshBinary: binary }, undefined)
      assert.equal(result.ok, false)
      assert.equal(result.exitCode, 7)
      assert.match(result.stderr, /boom/)
      assert.equal(result.error, undefined)
    })
  })
})

test('runOnHost stops a silent command on the idle timeout', async () => {
  await withTempHome(async () => {
    await withFakeSsh('exec sleep 5', async (binary) => {
      const result = await runOnHost(
        HOST,
        { command: 'sleep 5', timeoutMs: 1000 },
        { ...CONFIG, sshBinary: binary },
        undefined,
      )
      assert.equal(result.ok, false)
      assert.equal(result.timedOut, true)
      assert.equal(result.timeoutKind, 'idle')
      assert.match(result.error ?? '', /no output/)
      assert.ok(result.durationMs < 4000)
    })
  })
})

test('runOnHost keeps a chatty command alive past the idle window', async () => {
  await withTempHome(async () => {
    const body = 'i=0; while [ $i -lt 6 ]; do printf "tick\\n"; sleep 0.4; i=$((i+1)); done; exit 0'
    await withFakeSsh(body, async (binary) => {
      const result = await runOnHost(
        HOST,
        { command: 'build', timeoutMs: 1000 },
        { ...CONFIG, sshBinary: binary },
        undefined,
      )
      // ~2.4s of runtime, far beyond the 1s idle window: output kept it alive.
      assert.equal(result.ok, true)
      assert.equal(result.timedOut, false)
      assert.equal(result.timeoutKind, 'none')
      assert.equal((result.stdout.match(/tick/g) || []).length, 6)
      assert.ok(result.durationMs > 2000)
    })
  })
})

test('runOnHost enforces the hard time cap even while output continues', async () => {
  await withTempHome(async () => {
    const body = 'i=0; while [ $i -lt 30 ]; do printf "x\\n"; sleep 0.2; i=$((i+1)); done; exit 0'
    await withFakeSsh(body, async (binary) => {
      const result = await runOnHost(
        HOST,
        { command: 'loop', timeoutMs: 1200 },
        { ...CONFIG, sshBinary: binary, maxTimeoutMs: 1500 },
        undefined,
      )
      assert.equal(result.ok, false)
      assert.equal(result.timedOut, true)
      assert.equal(result.timeoutKind, 'total')
      assert.match(result.error ?? '', /hard time cap/)
      assert.ok(result.durationMs < 4000)
    })
  })
})

test('runOnHost honors an abort signal', async () => {
  await withTempHome(async () => {
    await withFakeSsh('exec sleep 5', async (binary) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 50)
      const result = await runOnHost(HOST, { command: 'sleep 5' }, { ...CONFIG, sshBinary: binary }, controller.signal)
      assert.equal(result.ok, false)
      assert.match(result.error ?? '', /aborted/)
      assert.equal(result.timedOut, false)
    })
  })
})

test('runOnHost truncates oversized output', async () => {
  await withTempHome(async () => {
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
})

test('runOnHost reports a missing ssh binary without rejecting', async () => {
  await withTempHome(async () => {
    const result = await runOnHost(HOST, { command: 'uptime' }, { ...CONFIG, sshBinary: '/nonexistent/ssh' }, undefined)
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /cannot (run|start)/)
  })
})

test('runOnHost reports a reused master when its socket already exists', async () => {
  await withTempHome(async () => {
    const socket = controlSocketPath(HOST)
    await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
    await writeFile(socket, '', 'utf8')
    await withFakeSsh('echo hi', async (binary) => {
      const result = await runOnHost(HOST, { command: 'echo hi' }, { ...CONFIG, sshBinary: binary }, undefined)
      assert.equal(result.sessionReused, true)
      assert.equal(result.ok, true)
    })
  })
})

test('disconnectHost closes an existing master socket', async () => {
  await withTempHome(async () => {
    const socket = controlSocketPath(HOST)
    await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
    await writeFile(socket, '', 'utf8')
    await withFakeSsh('exit 0', async (binary) => {
      const result = await disconnectHost(HOST, { ...CONFIG, sshBinary: binary })
      assert.equal(result.ok, true)
      assert.equal(result.closed, true)
    })
  })
})

test('disconnectHost is a no-op when no master socket exists', async () => {
  await withTempHome(async () => {
    const result = await disconnectHost(HOST, CONFIG)
    assert.equal(result.ok, true)
    assert.equal(result.closed, false)
    assert.equal(result.alreadyClosed, true)
  })
})
