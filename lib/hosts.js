/**
 * Persistent registry of SSH hosts managed by the user.
 *
 * Storage is one JSON document in `$DSH_HOME/ssh-hosts.json` (mode 0600),
 * written atomically (temp file + rename) and serialized in-process so a UI
 * save cannot interleave with an agent tool save.
 *
 * The plugin stores no credentials: authentication is delegated to the user's
 * SSH client (`ssh-agent`, `~/.ssh/config`, or an explicit identity file).
 *
 * @module dsh-plugin-remote-ssh/hosts
 */

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** `$DSH_HOME`, falling back to `~/.dsh` when the plugin is mounted outside a profile process. */
export function dshHomeDir() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Default hosts document location. */
export function defaultHostsFile() {
  return join(dshHomeDir(), 'ssh-hosts.json')
}

const MAX_TEXT = {
  name: 64,
  host: 255,
  user: 64,
  identityFile: 1024,
  proxyJump: 512,
  description: 500,
}

/** @param {string} field */
function fail(field, message) {
  throw new Error('invalid host.' + field + ': ' + message)
}

/**
 * Read one trimmed string field.
 * @param {unknown} value - raw value.
 * @param {string} field - field name for the error message.
 * @param {{ required?: boolean, max?: number, allowSpace?: boolean }} options
 * @returns {string} trimmed value (empty string when optional and absent).
 */
function readText(value, field, options = {}) {
  const { required = false, max = MAX_TEXT[field] ?? 255, allowSpace = true } = options
  if (value === undefined || value === null) {
    if (required) fail(field, 'is required')
    return ''
  }
  if (typeof value !== 'string') fail(field, 'must be a string')
  const text = value.trim()
  if (text === '') {
    if (required) fail(field, 'is required')
    return ''
  }
  if (text.length > max) fail(field, 'must be at most ' + max + ' characters')
  if (/[\u0000-\u001f\u007f]/.test(text)) fail(field, 'must not contain control characters')
  if (!allowSpace && /\s/.test(text)) fail(field, 'must not contain whitespace')
  return text
}

/** Reject values that an SSH argument parser could read as an option. */
function rejectOptionLike(value, field) {
  if (value.startsWith('-')) fail(field, 'must not start with "-"')
}

/** Expand a leading `~` without touching the rest of the path. */
export function expandHome(file) {
  if (file === '~') return homedir()
  if (file.startsWith('~/')) return join(homedir(), file.slice(2))
  return file
}

/**
 * Validate and canonicalize one host draft.
 * @param {unknown} input - draft supplied by the UI or the agent tool.
 * @param {{ createdAt?: number, id?: string }} [base] - owning record facts kept on update.
 * @returns {object} the canonical stored host record.
 */
export function normalizeHost(input, base = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('host must be an object')
  }

  const name = readText(input.name, 'name', { required: true })
  if (/[\u0000-\u001f\u007f]/.test(name)) fail('name', 'must not contain control characters')

  const host = readText(input.host, 'host', { required: true, allowSpace: false })
  rejectOptionLike(host, 'host')

  const user = readText(input.user, 'user', { allowSpace: false })
  rejectOptionLike(user, 'user')

  let port = 22
  if (input.port !== undefined && input.port !== null && input.port !== '') {
    const raw = typeof input.port === 'string' ? Number(input.port.trim()) : input.port
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
      fail('port', 'must be an integer within [1, 65535]')
    }
    port = raw
  }

  const identityFile = readText(input.identityFile, 'identityFile')
  rejectOptionLike(identityFile, 'identityFile')

  const proxyJump = readText(input.proxyJump, 'proxyJump', { allowSpace: false })
  rejectOptionLike(proxyJump, 'proxyJump')

  const description = readText(input.description, 'description')

  const now = Date.now()
  return {
    id: base.id ?? randomUUID(),
    name,
    user,
    host,
    port,
    identityFile: identityFile === '' ? '' : expandHome(identityFile),
    proxyJump,
    description,
    createdAt: typeof base.createdAt === 'number' ? base.createdAt : now,
    updatedAt: now,
  }
}

/** Project a stored record onto the JSON returned to remote callers. */
export function publicHost(record) {
  return {
    id: record.id,
    name: record.name,
    user: record.user,
    host: record.host,
    port: record.port,
    identityFile: record.identityFile,
    proxyJump: record.proxyJump,
    description: record.description,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** One-line destination for the tool/UI result text. */
export function hostDestination(record) {
  const target = record.user ? record.user + '@' + record.host : record.host
  return record.port === 22 ? target : target + ':' + record.port
}

/**
 * Validate one record read back from disk. Storage is user-editable, so a bad
 * row must name its index instead of disappearing silently.
 * @param {unknown} row
 * @param {number} index
 */
function normalizeStoredRow(row, index) {
  try {
    return normalizeHost(row, {
      id: typeof row?.id === 'string' && row.id !== '' ? row.id : undefined,
      createdAt: typeof row?.createdAt === 'number' ? row.createdAt : undefined,
    })
  } catch (error) {
    throw new Error('hosts file row ' + index + ' is invalid: ' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * Create the registry facade bound to one hosts document.
 * @param {{ file?: string }} [options]
 */
export function createHostStore(options = {}) {
  const file = options.file ?? defaultHostsFile()
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve()

  /** Serialize one read-modify-write turn; a failed turn never blocks later ones. */
  function serialized(task) {
    const run = tail.then(task, task)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** @returns {Promise<{ version: number, hosts: object[] }>} */
  async function readDocument() {
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return { version: 1, hosts: [] }
      throw new Error('cannot read ' + file + ': ' + (error instanceof Error ? error.message : String(error)))
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(file + ' is not valid JSON: ' + (error instanceof Error ? error.message : String(error)))
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(file + ' must contain a JSON object')
    }
    const rows = Array.isArray(parsed.hosts) ? parsed.hosts : []
    return { version: 1, hosts: rows.map(normalizeStoredRow) }
  }

  /** @param {{ version: number, hosts: object[] }} document */
  async function writeDocument(document) {
    await mkdir(dirname(file), { recursive: true })
    const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp'
    const body = JSON.stringify({ version: 1, hosts: document.hosts }, null, 2) + '\n'
    try {
      await writeFile(temporary, body, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, file)
      await chmod(file, 0o600)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw new Error('cannot write ' + file + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /** @param {object[]} hosts */
  function assertUniqueName(hosts, candidate, ignoreId) {
    const clash = hosts.find(
      (entry) => entry.id !== ignoreId && entry.name.toLowerCase() === candidate.name.toLowerCase(),
    )
    if (clash !== undefined) {
      throw new Error('a host named "' + candidate.name + '" already exists (id ' + clash.id + ')')
    }
  }

  /**
   * @param {string} idOrName - host id, or its display name as a fallback.
   * @returns {object} the stored record (throws when unknown).
   */
  async function findByIdOrName(idOrName) {
    if (typeof idOrName !== 'string' || idOrName.trim() === '') {
      throw new Error('host id or name is required')
    }
    const needle = idOrName.trim()
    const document = await readDocument()
    const byId = document.hosts.find((entry) => entry.id === needle)
    if (byId !== undefined) return byId
    const matches = document.hosts.filter((entry) => entry.name.toLowerCase() === needle.toLowerCase())
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      throw new Error('host name "' + needle + '" is ambiguous; use the id instead')
    }
    throw new Error(
      'unknown SSH host "' + needle + '"; configured hosts: ' +
        (document.hosts.length === 0
          ? '(none)'
          : document.hosts.map((entry) => entry.name + ' (id ' + entry.id + ')').join(', ')),
    )
  }

  return {
    file,

    /** @returns {Promise<{ hosts: object[], file: string }>} */
    async list() {
      const document = await readDocument()
      return { hosts: document.hosts.map(publicHost), file }
    },

    /** @param {string} idOrName */
    async get(idOrName) {
      return publicHost(await findByIdOrName(idOrName))
    },

    /**
     * Create a host, or update the record named by `input.id`.
     * @param {unknown} input
     * @returns {Promise<object>} the saved public host.
     */
    async upsert(input) {
      return serialized(async () => {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new Error('host must be an object')
        }
        const id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : undefined
        const document = await readDocument()
        const existing = id === undefined ? undefined : document.hosts.find((entry) => entry.id === id)
        if (id !== undefined && existing === undefined) {
          throw new Error('unknown host id "' + id + '"')
        }
        const normalized = normalizeHost(input, existing === undefined ? {} : { id: existing.id, createdAt: existing.createdAt })
        assertUniqueName(document.hosts, normalized, existing?.id)
        const hosts =
          existing === undefined
            ? [...document.hosts, normalized]
            : document.hosts.map((entry) => (entry.id === existing.id ? normalized : entry))
        await writeDocument({ version: 1, hosts })
        return publicHost(normalized)
      })
    },

    /**
     * Remove one host by id, or by an unambiguous name.
     * @param {string} idOrName
     * @returns {Promise<{ id: string, name: string, removed: true }>}
     */
    async remove(idOrName) {
      return serialized(async () => {
        const target = await findByIdOrName(idOrName)
        const document = await readDocument()
        const hosts = document.hosts.filter((entry) => entry.id !== target.id)
        if (hosts.length === document.hosts.length) throw new Error('unknown host id "' + target.id + '"')
        await writeDocument({ version: 1, hosts })
        return { id: target.id, name: target.name, removed: true }
      })
    },
  }
}
