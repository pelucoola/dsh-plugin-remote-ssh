/**
 * Configuration of the dsh-plugin-ssh bundle row.
 *
 * The Loader resolves the row's `config` through the exported `Config` Standard
 * Schema before the plugin mounts, so a mistyped value fails at mount time
 * instead of surfacing later as a confusing runtime error. `resolveConfig()` is
 * exported for direct callers (tests, hand-mounted contexts) and repeats the
 * same resolution.
 *
 * @module dsh-plugin-ssh/config
 */

/** Defaults for every supported key; unknown keys are rejected. */
export const DEFAULT_CONFIG = Object.freeze({
  /** SSH client executable. A bare name is resolved through PATH. */
  sshBinary: 'ssh',
  /** `ssh -o ConnectTimeout=<seconds>`; also bounds the "test connection" probe. */
  connectTimeoutSec: 10,
  /** Default per-call command timeout. */
  defaultTimeoutMs: 60000,
  /** Bytes captured per stream before the result is marked truncated. */
  maxOutputBytes: 200000,
})

/** Inclusive numeric bounds for the integer keys. */
const LIMITS = Object.freeze({
  connectTimeoutSec: [1, 120],
  defaultTimeoutMs: [1000, 600000],
  maxOutputBytes: [4096, 8 * 1024 * 1024],
})

/** @param {string} message */
function fail(message) {
  throw new Error('dsh-plugin-ssh: ' + message)
}

/**
 * Resolve and validate one bundle-row config object.
 * @param {unknown} raw - the row's `config` value (undefined when omitted).
 * @returns {{ sshBinary: string, connectTimeoutSec: number, defaultTimeoutMs: number, maxOutputBytes: number }}
 */
export function resolveConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) fail('config must be an object')

  const unknown = Object.keys(input).filter((key) => !Object.hasOwn(DEFAULT_CONFIG, key))
  if (unknown.length > 0) fail('unknown config key(s): ' + unknown.join(', '))

  const out = { ...DEFAULT_CONFIG }

  if (input.sshBinary !== undefined) {
    if (typeof input.sshBinary !== 'string' || input.sshBinary.trim() === '') {
      fail('sshBinary must be a non-empty string')
    }
    out.sshBinary = input.sshBinary.trim()
  }

  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(key + ' must be a number')
    }
    if (value < min || value > max) {
      fail(key + ' must be within [' + min + ', ' + max + ']')
    }
    out[key] = Math.round(value)
  }

  return out
}

/**
 * Standard Schema consumed by the Cordis Loader for the bundle row.
 * Hand-written (no schemastery dependency) because a plugin bundle must stay
 * resolvable without the Harness's own package tree.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugin-ssh',
    /**
     * @param {unknown} config
     * @returns {{ value: ReturnType<typeof resolveConfig> } | { issues: Array<{ message: string }> }}
     */
    validate(config) {
      try {
        return { value: resolveConfig(config) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
}
