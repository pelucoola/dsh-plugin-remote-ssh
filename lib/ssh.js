/**
 * SSH invocation: turn one stored host record plus one command request into an
 * `ssh` argv, run it, and capture bounded stdout/stderr.
 *
 * Two behaviors make repeated calls cheap and long calls safe:
 *
 * - **Connection reuse.** On POSIX the client runs with `ControlMaster=auto`
 *   and a per-connection control socket under `$DSH_HOME/ssh-masters`, so the
 *   first call pays the handshake and later calls on the same host ride the
 *   existing master (`ControlPersist` keeps it alive between calls). The
 *   interactive shell itself is still per call — use `cwd` for the directory.
 * - **Dynamic timeout.** `timeoutMs` is an *idle* timeout: it only fires when
 *   the command produces no output for that long. A hard `maxTimeoutMs` cap
 *   bounds the total call regardless of activity.
 *
 * Commands run through the user's own SSH client. No shell is involved
 * locally (argv is passed to `spawn` directly), so host/user/port/identity
 * values are never re-parsed by a local shell. The remote command string is
 * intentionally handed to the remote login shell, which is what "control a
 * remote host over SSH" means.
 *
 * @module dsh-plugin-remote-ssh/ssh
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { dshHomeDir } from './hosts.js'

const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 86400000
const DEFAULT_MAX_TIMEOUT_MS = 3600000
const DEFAULT_IDLE_TIMEOUT_MS = 120000

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
 * Whether this deployment can multiplex connections: OpenSSH's ControlMaster
 * is a POSIX feature, and the user can switch reuse off in the plugin config.
 * @param {{ reuseSession?: boolean }} config
 */
export function reuseSupported(config) {
  return config.reuseSession !== false && process.platform !== 'win32'
}

/** Directory holding the background master sockets. */
export function controlSocketDir() {
  return join(dshHomeDir(), 'ssh-masters')
}

/**
 * Stable control-socket path for one connection identity. The identity covers
 * every fact that changes the wire connection, so editing a host's port/user/
 * key/jump host starts from a fresh master instead of reusing a stale one. The
 * client binary path is deliberately NOT part of it: switching `sshBinary`
 * (e.g. to a wrapper) still reaches the same server.
 * @param {object} host
 */
export function controlSocketPath(host) {
  const identity = JSON.stringify([
    host.host,
    host.port ?? 22,
    host.user ?? '',
    host.identityFile ?? '',
    host.proxyJump ?? '',
  ])
  const hash = createHash('sha1').update(identity).digest('hex').slice(0, 16)
  return join(controlSocketDir(), 'm-' + hash + '.sock')
}

/**
 * Build the `ssh` argv for one command.
 * @param {object} host - stored host record.
 * @param {{ command: string, cwd?: string, connectTimeoutSec?: number }} request
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @returns {string[]}
 */
export function buildSshArgs(host, request, config) {
  const connectTimeout = request.connectTimeoutSec ?? config.connectTimeoutSec
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=' + String(connectTimeout),
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ]
  if (reuseSupported(config)) {
    args.push(
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPath=' + controlSocketPath(host),
      '-o', 'ControlPersist=' + String(config.sessionPersistSeconds ?? 300),
    )
  }
  args.push('-p', String(host.port ?? 22))
  if (host.identityFile) args.push('-i', host.identityFile)
  if (host.proxyJump) args.push('-J', host.proxyJump)
  args.push('--', sshDestination(host), buildRemoteScript(request.command, request.cwd))
  return args
}

/**
 * Resolve the effective timeouts: the per-call request wins, both values stay
 * inside the supported range, and the hard cap is never shorter than the idle
 * window (an explicit request must not be pre-empted by the cap).
 * @param {number | undefined} requested
 * @param {number | undefined} fallback
 * @param {number | undefined} maxTimeMs
 * @returns {{ idleTimeoutMs: number, maxTimeMs: number }}
 */
export function resolveTimeouts(requested, fallback, maxTimeMs) {
  const rawIdle =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.round(requested)
      : typeof fallback === 'number' && Number.isFinite(fallback)
        ? Math.round(fallback)
        : DEFAULT_IDLE_TIMEOUT_MS
  const idleTimeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, rawIdle))
  const rawCap =
    typeof maxTimeMs === 'number' && Number.isFinite(maxTimeMs) ? Math.round(maxTimeMs) : DEFAULT_MAX_TIMEOUT_MS
  const cap = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, rawCap))
  return { idleTimeoutMs, maxTimeMs: Math.max(cap, idleTimeoutMs) }
}

/**
 * Capture one readable stream up to a byte budget.
 * @param {import('node:stream').Readable} stream
 * @param {number} maxBytes
 * @param {() => void} [onActivity] - called for every chunk, before truncation.
 * @returns {{ text: () => string, truncated: () => boolean }}
 */
function capture(stream, maxBytes, onActivity) {
  const chunks = []
  let bytes = 0
  let truncated = false
  stream.on('data', (chunk) => {
    if (onActivity !== undefined) onActivity()
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

/** @param {unknown} error */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
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
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @param {AbortSignal | undefined} signal
 */
export async function runOnHost(host, request, config, signal) {
  const { idleTimeoutMs, maxTimeMs } = resolveTimeouts(
    request.timeoutMs,
    config.defaultTimeoutMs,
    config.maxTimeoutMs,
  )
  const reuse = reuseSupported(config)
  const socketPath = reuse ? controlSocketPath(host) : undefined
  if (reuse) {
    await mkdir(controlSocketDir(), { recursive: true, mode: 0o700 }).catch(() => {})
  }
  // Heuristic: an existing socket file means a previous call left a master
  // behind, so this call should skip the handshake.
  const sessionReused = reuse && socketPath !== undefined ? existsSync(socketPath) : false
  const startedAt = Date.now()

  return new Promise((resolve) => {
    /**
     * @param {'none' | 'idle' | 'total'} kind
     * @param {string} error
     */
    const failedResult = (kind, error) => ({
      ok: false,
      host: host.name,
      command: request.command,
      exitCode: -1,
      signal: '',
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: kind !== 'none',
      timeoutKind: kind,
      idleTimeoutMs,
      maxTimeMs,
      sessionReused,
      durationMs: Date.now() - startedAt,
      error,
    })

    if (signal?.aborted) {
      resolve(failedResult('none', 'the call was aborted before it started'))
      return
    }

    let child
    try {
      child = spawn(config.sshBinary, buildSshArgs(host, request, config), {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve(failedResult('none', 'cannot start ' + config.sshBinary + ': ' + messageOf(error)))
      return
    }

    let settled = false
    /** @type {NodeJS.Timeout | undefined} */
    let idleTimer
    /** @type {NodeJS.Timeout | undefined} */
    let totalTimer
    /** @type {NodeJS.Timeout | undefined} */
    let killTimer
    /** @type {() => void} */
    let onAbort = () => {}

    const stdout = capture(child.stdout, config.maxOutputBytes)
    const stderr = capture(child.stderr, config.maxOutputBytes)

    /**
     * Resolve exactly once with the current capture. A late close (or a
     * second timeout) then finds `settled` and becomes a no-op.
     */
    const complete = (kind, error, exitCode, exitSignal) => {
      if (settled) return false
      settled = true
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      if (totalTimer !== undefined) clearTimeout(totalTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        ok: exitCode === 0 && error === undefined && kind === 'none',
        host: host.name,
        command: request.command,
        exitCode,
        signal: exitSignal ?? '',
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated() || stderr.truncated(),
        timedOut: kind !== 'none',
        timeoutKind: kind,
        idleTimeoutMs,
        maxTimeMs,
        sessionReused,
        durationMs: Date.now() - startedAt,
        ...(error === undefined ? {} : { error }),
      })
      return true
    }

    /**
     * Abandon the child WITHOUT waiting for its pipes. A multiplexed ssh
     * client can keep stdout/stderr open until the far side finishes, so
     * `close` may lag seconds behind the kill; releasing the streams first
     * makes the tool answer at the timeout instead of at the remote exit.
     */
    const abandon = () => {
      try {
        child.stdin?.destroy()
      } catch {
        /* already gone */
      }
      try {
        child.stdout?.destroy()
      } catch {
        /* already gone */
      }
      try {
        child.stderr?.destroy()
      } catch {
        /* already gone */
      }
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        child.unref?.()
      }, 1500)
      killTimer.unref?.()
    }

    const armIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (complete('idle', 'no output for ' + idleTimeoutMs + ' ms; the command was terminated (pass a larger timeoutMs for silent long-running commands)', -1, '')) {
          abandon()
        }
      }, idleTimeoutMs)
      idleTimer.unref?.()
    }

    const onActivity = () => {
      if (!settled) armIdle()
    }

    // Re-attach activity callbacks: capture() owns the data listeners, so the
    // idle clock is driven from the stream readers rather than duplicated.
    child.stdout.on('data', onActivity)
    child.stderr.on('data', onActivity)

    armIdle()
    totalTimer = setTimeout(() => {
      if (complete('total', 'the ' + maxTimeMs + ' ms hard time cap was reached; the command was terminated', -1, '')) {
        abandon()
      }
    }, maxTimeMs)
    totalTimer.unref?.()

    onAbort = () => {
      if (complete('none', 'the call was aborted', -1, '')) abandon()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => {
      if (complete('none', 'cannot run ' + config.sshBinary + ': ' + messageOf(error), -1, '')) {
        abandon()
      }
    })
    child.on('close', (code, exitSignal) => {
      complete('none', undefined, typeof code === 'number' ? code : -1, exitSignal)
    })

    if (typeof request.stdin === 'string' && request.stdin !== '') {
      child.stdin.end(request.stdin)
    } else {
      child.stdin.end()
    }
  })
}

/**
 * Ask a host's background master to exit and leave no reusable socket.
 * @param {object} host
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @returns {Promise<{ ok: boolean, closed: boolean, socket?: string, error?: string, alreadyClosed?: boolean }>}
 */
export async function disconnectHost(host, config) {
  if (!reuseSupported(config)) {
    return { ok: false, closed: false, error: 'connection reuse is disabled (reuseSession=false or Windows OpenSSH)' }
  }
  const socketPath = controlSocketPath(host)
  if (!existsSync(socketPath)) {
    return { ok: true, closed: false, socket: socketPath, alreadyClosed: true }
  }
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        config.sshBinary,
        ['-O', 'exit', '-o', 'ControlPath=' + socketPath, sshDestination(host)],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      resolve({
        ok: false,
        closed: false,
        socket: socketPath,
        error: 'cannot start ' + config.sshBinary + ': ' + messageOf(error),
      })
      return
    }
    const stderr = capture(child.stderr, config.maxOutputBytes ?? 200000)
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({ ok: false, closed: false, socket: socketPath, error: 'ssh -O exit did not answer within 5000 ms' })
    }, 5000)
    timer.unref?.()
    child.on('error', (error) => {
      finish({
        ok: false,
        closed: false,
        socket: socketPath,
        error: 'cannot run ' + config.sshBinary + ': ' + messageOf(error),
      })
    })
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, closed: true, socket: socketPath })
        return
      }
      const detail = stderr.text().trim()
      finish({
        ok: false,
        closed: false,
        socket: socketPath,
        error: detail !== '' ? detail : 'ssh -O exit exited with code ' + String(code),
      })
    })
  })
}

/**
 * Probe a host with a trivial command and report reachability plus latency.
 * @param {object} host
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @param {AbortSignal | undefined} signal
 */
export async function testHost(host, config, signal) {
  const probeTimeoutMs = config.connectTimeoutSec * 1000 + 5000
  const result = await runOnHost(
    host,
    {
      command: "printf 'ok\\n'; uname -srm 2>/dev/null || true",
      timeoutMs: probeTimeoutMs,
    },
    {
      ...config,
      defaultTimeoutMs: probeTimeoutMs,
      maxTimeoutMs: Math.max(probeTimeoutMs, config.maxTimeoutMs ?? probeTimeoutMs),
    },
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
    sessionReused: result.sessionReused,
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}
