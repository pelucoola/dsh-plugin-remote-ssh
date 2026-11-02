/**
 * SSH invocation: turn one stored host record plus one command request into an
 * `ssh` argv, run it, and capture bounded stdout/stderr.
 *
 * Commands run through the user's own SSH client. No shell is involved
 * locally (argv is passed to `spawn` directly), so host/user/port/identity
 * values are never re-parsed by a local shell. The remote command string is
 * intentionally handed to the remote login shell, which is what "control a
 * remote host over SSH" means.
 *
 * @module dsh-plugin-ssh/ssh
 */

import { spawn } from 'node:child_process'

const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 600000

/** Quote one string for POSIX `sh` (used only inside the remote command). */
export function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'"
}

/** Format the destination, bracketing IPv6 literals the way OpenSSH expects. */
export function sshDestination(host) {
  let target = host.host
  if (target.includes(':')) {
    const bare = target.startsWith('[') && target.endsWith(']') ? target.slice(1, -1) : target
    target = '[' + bare + ']'
  }
  return host.user ? host.user + '@' + target : target
}

/** Compose what the remote shell receives after `ssh host` joins its argv. */
export function buildRemoteScript(command, cwd) {
  const script = String(command)
  if (typeof cwd !== 'string' || cwd.trim() === '') return script
  return 'cd -- ' + shellQuote(cwd.trim()) + ' && ' + script
}

/**
 * Build the `ssh` argv for one command.
 * @param {object} host - stored host record.
 * @param {{ command: string, cwd?: string, connectTimeoutSec?: number }} request
 * @param {{ connectTimeoutSec: number }} config
 * @returns {string[]}
 */
export function buildSshArgs(host, request, config) {
  const connectTimeout = request.connectTimeoutSec ?? config.connectTimeoutSec
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=' + String(connectTimeout),
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-p', String(host.port ?? 22),
  ]
  if (host.identityFile) args.push('-i', host.identityFile)
  if (host.proxyJump) args.push('-J', host.proxyJump)
  args.push('--', sshDestination(host), buildRemoteScript(request.command, request.cwd))
  return args
}

/** Clamp a requested timeout into the supported range. */
export function resolveTimeout(requested, fallback) {
  const value = typeof requested === 'number' && Number.isFinite(requested) ? Math.round(requested) : fallback
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, value))
}

/**
 * Capture one readable stream up to a byte budget.
 * @param {import('node:stream').Readable} stream
 * @param {number} maxBytes
 * @returns {{ text: () => string, truncated: () => boolean }}
 */
function capture(stream, maxBytes) {
  const chunks = []
  let bytes = 0
  let truncated = false
  stream.on('data', (chunk) => {
    if (bytes >= maxBytes) {
      truncated = true
      return
    }
    const room = maxBytes - bytes
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
    if (slice.length < chunk.length) truncated = true
    chunks.push(slice)
    bytes += slice.length
  })
  stream.on('error', () => {})
  return {
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => truncated,
  }
}

/**
 * Run one command on a host.
 *
 * Never rejects for a remote failure: a non-zero exit code, a timeout, an
 * aborted call and a missing `ssh` binary all resolve as data (`ok: false`),
 * because the caller (the agent tool) forwards it to the model verbatim.
 *
 * @param {object} host - stored host record.
 * @param {{ command: string, cwd?: string, stdin?: string, timeoutMs?: number }} request
 * @param {{ sshBinary: string, connectTimeoutSec: number, defaultTimeoutMs: number, maxOutputBytes: number }} config
 * @param {AbortSignal | undefined} signal
 */
export function runOnHost(host, request, config, signal) {
  const timeoutMs = resolveTimeout(request.timeoutMs, config.defaultTimeoutMs)
  const args = buildSshArgs(host, request, config)
  const startedAt = Date.now()

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        ok: false,
        host: host.name,
        command: request.command,
        exitCode: -1,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        durationMs: 0,
        error: 'the call was aborted before it started',
      })
      return
    }

    let child
    try {
      child = spawn(config.sshBinary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({
        ok: false,
        host: host.name,
        command: request.command,
        exitCode: -1,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        error: 'cannot start ' + config.sshBinary + ': ' + messageOf(error),
      })
      return
    }

    const stdout = capture(child.stdout, config.maxOutputBytes)
    const stderr = capture(child.stderr, config.maxOutputBytes)
    let settled = false
    let timedOut = false
    let aborted = false
    /** @type {NodeJS.Timeout | undefined} */
    let killTimer
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
      killTimer.unref?.()
    }, timeoutMs)
    timeoutTimer.unref?.()

    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
      killTimer.unref?.()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (exitCode, exitSignal, extraError) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      const error = extraError ?? (aborted ? 'the call was aborted' : undefined)
      resolve({
        ok: exitCode === 0 && error === undefined,
        host: host.name,
        command: request.command,
        exitCode,
        signal: exitSignal ?? '',
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated() || stderr.truncated(),
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(error === undefined ? {} : { error }),
      })
    }

    child.on('error', (error) => {
      finish(-1, null, 'cannot run ' + config.sshBinary + ': ' + messageOf(error))
    })
    child.on('close', (code, exitSignal) => {
      finish(typeof code === 'number' ? code : -1, exitSignal, undefined)
    })

    if (typeof request.stdin === 'string' && request.stdin !== '') {
      child.stdin.end(request.stdin)
    } else {
      child.stdin.end()
    }
  })
}

/**
 * Probe a host with a trivial command and report reachability plus latency.
 * @param {object} host
 * @param {{ sshBinary: string, connectTimeoutSec: number, maxOutputBytes: number }} config
 * @param {AbortSignal | undefined} signal
 */
export async function testHost(host, config, signal) {
  const result = await runOnHost(
    host,
    {
      command: "printf 'ok\\n'; uname -srm 2>/dev/null || true",
      timeoutMs: config.connectTimeoutSec * 1000 + 5000,
    },
    { ...config, defaultTimeoutMs: config.connectTimeoutSec * 1000 + 5000 },
    signal,
  )
  const output = result.stdout.trim()
  return {
    ok: result.ok,
    host: host.name,
    destination: (host.user ? host.user + '@' : '') + host.host + (host.port === 22 ? '' : ':' + host.port),
    latencyMs: result.durationMs,
    exitCode: result.exitCode,
    output,
    stderr: result.stderr,
    timedOut: result.timedOut,
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

/** @param {unknown} error */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
