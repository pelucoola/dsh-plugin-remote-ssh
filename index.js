/**
 * Host half of dsh-plugin-ssh.
 *
 * Publishes three things on the live Cordis Context:
 *
 *  1. the `sshHosts` service (host registry + reachability probe) — the one
 *     implementation both the Settings page and the agent tools call;
 *  2. typert RPC descriptors for that service. The browser half reaches them
 *     through the authenticated `/api` gateway as `sshHosts/<method>`, which is
 *     how a plain-JS bundle exposes Host operations without importing any
 *     Harness package;
 *  3. the `ssh` (execute on a saved host) and `ssh_hosts` (manage saved hosts)
 *     agent tools.
 *
 * No credentials are stored or forwarded: the user's own `ssh` client
 * (agent keys, `~/.ssh/config`, or a configured identity file) performs
 * authentication.
 *
 * @module dsh-plugin-ssh
 */

import { Config, resolveConfig } from './lib/config.js'
import { createHostStore, hostDestination, normalizeHost } from './lib/hosts.js'
import { runOnHost, testHost } from './lib/ssh.js'

/** Services this plugin cannot run without. */
export const inject = ['tools', 'typert']

export { Config }

const PACKAGE = 'dsh-plugin-ssh'
const SERVICE = 'sshHosts'

/**
 * One RPC endpoint. Parameters are `source: 'json'` with the permissive
 * `src-json` codec: the gateway forwards the validated JSON value unchanged and
 * treats an omitted wire as absent, so methods can have optional parameters.
 * @param {string} method
 * @param {string[]} wires - wire names in positional order.
 */
function invocationFor(method, wires) {
  return {
    id: PACKAGE + '/' + SERVICE + '/' + method,
    service: SERVICE,
    namespace: SERVICE,
    method,
    invocation: { kind: 'direct' },
    parameters: wires.map((wire) => ({
      name: wire,
      wire,
      source: 'json',
      codec: { mode: 'src-json' },
    })),
    result: { mode: 'src-json' },
  }
}

/** RPC surface shared by the Settings page (all four) and the tools. */
const RPC_METHODS = Object.freeze([
  ['list', []],
  ['save', ['host']],
  ['remove', ['id']],
  ['test', ['id', 'host']],
])

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Project a host for list output (adds the human-readable destination). */
function hostView(host) {
  return { ...host, destination: hostDestination(host) }
}

/** A draft is testable before it is saved; give an unnamed draft a usable label. */
function draftForTest(draft) {
  const record = normalizeHost({
    ...draft,
    name: typeof draft.name === 'string' && draft.name.trim() !== '' ? draft.name : String(draft.host ?? ''),
  })
  return record
}

/**
 * Build the `sshHosts` service object.
 * @param {ReturnType<typeof createHostStore>} store
 * @param {ReturnType<typeof resolveConfig>} config
 */
function createService(store, config) {
  const service = {
    /** @returns {Promise<{ hosts: object[], file: string }>} */
    async list() {
      const document = await store.list()
      return { hosts: document.hosts.map(hostView), file: document.file }
    },
    /** @param {unknown} host */
    async save(host) {
      return hostView(await store.upsert(host))
    },
    /** @param {string} id */
    async remove(id) {
      return store.remove(id)
    },
    /**
     * Probe a saved host (by id/name) or an unsaved draft.
     * @param {string | undefined} id
     * @param {object | undefined} draft
     */
    async test(id, draft) {
      const hasDraft = draft !== null && typeof draft === 'object' && !Array.isArray(draft)
      const target = hasDraft && Object.keys(draft).length > 0 ? draftForTest(draft) : await store.get(id)
      return testHost(target, config)
    },
  }

  // The gateway requires every remotely reachable service to carry this
  // binding; `serviceKey` is the Cordis key and `namespace` the RPC namespace.
  Object.defineProperty(service, 'typertRemote', {
    value: Object.freeze({ service, serviceKey: SERVICE, namespace: SERVICE }),
    enumerable: false,
  })

  return service
}

/**
 * `ssh` tool: execute one command on a saved host, or list saved hosts when
 * `host` is omitted.
 * @param {ReturnType<typeof createHostStore>} store
 * @param {ReturnType<typeof resolveConfig>} config
 */
function sshTool(store, config) {
  const outputSchema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      kind: { type: 'string', enum: ['hosts', 'command'] },
      host: { type: 'string' },
      destination: { type: 'string' },
      command: { type: 'string' },
      exitCode: { type: 'integer' },
      signal: { type: 'string' },
      stdout: { type: 'string' },
      stderr: { type: 'string' },
      truncated: { type: 'boolean' },
      timedOut: { type: 'boolean' },
      durationMs: { type: 'integer' },
      error: { type: 'string' },
      message: { type: 'string' },
      hosts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            destination: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
  }

  return {
    name: 'ssh',
    description:
      'Run a shell command on a remote host over SSH using a host saved in Settings → SSH 主机. ' +
      'Omit `host` to list the configured hosts (the result carries their ids, names and destinations). ' +
      'The command runs in the remote user\'s login shell; `cwd` changes the remote working directory first ' +
      'and `stdin` is piped to the command. Returns exitCode, stdout and stderr — a non-zero exit code is data, ' +
      'not an error. Authentication uses the user\'s own SSH configuration; this tool never accepts passwords ' +
      'or ad-hoc destinations, so an unknown host must be added through `ssh_hosts` or the Settings page first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: {
          type: 'string',
          description: 'Saved host id or name. Omit to list the configured hosts.',
        },
        command: {
          type: 'string',
          description: 'Shell command to run on the remote host.',
        },
        cwd: {
          type: 'string',
          description: 'Remote directory to enter before running the command (cd -- <cwd> && <command>).',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Command timeout in milliseconds (default ' + config.defaultTimeoutMs + ', max 600000).',
        },
        stdin: {
          type: 'string',
          description: 'Text piped to the command\'s standard input.',
        },
      },
    },
    output: {
      schema: outputSchema,
      render(args, value) {
        const lines = []
        if (value.kind === 'hosts') {
          lines.push(value.message ?? 'Configured SSH hosts:')
          for (const entry of value.hosts ?? []) {
            lines.push(
              '- ' + entry.name + ' (id ' + entry.id + ') → ' + entry.destination +
                (entry.description ? ' — ' + entry.description : ''),
            )
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const status = value.ok
          ? 'exit ' + value.exitCode
          : value.timedOut
            ? 'timed out'
            : value.error ?? 'exit ' + value.exitCode
        lines.push(
          'ssh ' + (value.destination ?? value.host ?? '') + ' — ' + status +
            ' (' + value.durationMs + ' ms' + (value.truncated ? ', output truncated' : '') + ')',
        )
        if (value.stdout) lines.push('', value.stdout.replace(/\s+$/, ''))
        if (value.stderr) lines.push('', 'stderr:', value.stderr.replace(/\s+$/, ''))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    presentCall(args) {
      return {
        card: 'terminal',
        title: args.host ? 'ssh ' + args.host : 'List SSH hosts',
        ...(typeof args.command === 'string' && args.command !== '' ? { description: args.command } : {}),
        ...(typeof args.cwd === 'string' && args.cwd !== '' ? { cwd: args.cwd } : {}),
      }
    },
    async execute(args, exec) {
      const request = args !== null && typeof args === 'object' ? args : {}

      if (typeof request.host !== 'string' || request.host.trim() === '') {
        const document = await store.list()
        const hosts = document.hosts.map((entry) => ({
          id: entry.id,
          name: entry.name,
          destination: hostDestination(entry),
          ...(entry.description ? { description: entry.description } : {}),
        }))
        return {
          ok: true,
          kind: 'hosts',
          hosts,
          message:
            hosts.length === 0
              ? 'No SSH hosts are configured yet. Add one in Settings → SSH 主机, or call ssh_hosts with action "add".'
              : 'Configured SSH hosts (call ssh with one of these names or ids and a command):',
        }
      }

      if (typeof request.command !== 'string' || request.command.trim() === '') {
        throw new Error('`command` is required when `host` names a host (omit both to list hosts)')
      }

      const host = await store.get(request.host.trim())
      const result = await runOnHost(
        host,
        { command: request.command, cwd: request.cwd, stdin: request.stdin, timeoutMs: request.timeoutMs },
        config,
        exec.signal,
      )
      return {
        ...result,
        kind: 'command',
        destination: hostDestination(host),
      }
    },
  }
}

/**
 * `ssh_hosts` tool: the agent-facing half of the Settings page operations.
 * Every branch calls the same store/service helpers the UI uses.
 * @param {ReturnType<typeof createHostStore>} store
 * @param {ReturnType<typeof resolveConfig>} config
 */
function sshHostsTool(store, config) {
  const fields = {
    id: { type: 'string', description: 'Host id (or its exact name) for get/update/remove/test.' },
    name: { type: 'string', description: 'Display name shown in Settings (required for add/update).' },
    host: { type: 'string', description: 'Hostname or IP address (required for add/update).' },
    user: { type: 'string', description: 'SSH user name; empty uses the SSH client default.' },
    port: { type: 'number', description: 'SSH port, default 22.' },
    identityFile: {
      type: 'string',
      description: 'Private key path; leave empty to use ssh-agent / ~/.ssh/config.',
    },
    proxyJump: { type: 'string', description: 'ProxyJump (jump host) target, e.g. user@bastion:22.' },
    description: { type: 'string', description: 'Free-form note shown in Settings.' },
  }
  const hostSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      destination: { type: 'string' },
      description: { type: 'string' },
    },
  }

  /** @param {Record<string, unknown>} args */
  function draftOf(args) {
    const draft = {}
    for (const key of ['name', 'user', 'host', 'port', 'identityFile', 'proxyJump', 'description']) {
      if (args[key] !== undefined) draft[key] = args[key]
    }
    return draft
  }

  return {
    name: 'ssh_hosts',
    description:
      'Manage the SSH hosts saved for the `ssh` tool. Actions: list (all saved hosts), get (one host), ' +
      'add (create from name/host/user/port/identityFile/proxyJump/description), update (requires id), ' +
      'remove (id or name), test (probe reachability and report latency plus `uname`). Use this to add a host ' +
      'the user asked you to work with, or to discover which hosts already exist before calling `ssh`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'add', 'update', 'remove', 'test'],
          description: 'Operation to perform.',
        },
        ...fields,
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          message: { type: 'string' },
          host: hostSchema,
          hosts: { type: 'array', items: hostSchema },
          removed: { type: 'boolean' },
          latencyMs: { type: 'integer' },
          output: { type: 'string' },
          stderr: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.action === 'list') {
          const hosts = value.hosts ?? []
          return [{
            type: 'text',
            text:
              hosts.length === 0
                ? 'No SSH hosts configured.'
                : hosts.map((entry) => '- ' + entry.name + ' (id ' + entry.id + ') → ' + entry.destination).join('\n'),
          }]
        }
        if (value.action === 'test') {
          return [{
            type: 'text',
            text: (value.ok ? 'Reachable' : 'Unreachable') + ': ' + value.host?.name +
              ' (' + value.latencyMs + ' ms)' +
              (value.output ? '\n' + value.output : '') +
              (value.stderr ? '\n' + value.stderr : '') +
              (value.error ? '\n' + value.error : ''),
          }]
        }
        return [{ type: 'text', text: value.message ?? 'Done: ' + value.action }]
      },
    },
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : ''
      const key = typeof args?.id === 'string' && args.id.trim() !== '' ? args.id.trim() : args?.name

      switch (action) {
        case 'list': {
          const document = await store.list()
          return {
            ok: true,
            action,
            hosts: document.hosts.map((entry) => ({
              id: entry.id,
              name: entry.name,
              destination: hostDestination(entry),
              ...(entry.description ? { description: entry.description } : {}),
            })),
            message: document.hosts.length === 0 ? 'No SSH hosts configured.' : 'Configured SSH hosts.',
          }
        }
        case 'get': {
          const host = await store.get(key)
          const view = hostView(host)
          return { ok: true, action, host: { id: view.id, name: view.name, destination: view.destination, ...(view.description ? { description: view.description } : {}) } }
        }
        case 'add': {
          const saved = await store.upsert(draftOf(args ?? {}))
          return { ok: true, action, host: { id: saved.id, name: saved.name, destination: hostDestination(saved), ...(saved.description ? { description: saved.description } : {}) }, message: 'Host added: ' + saved.name }
        }
        case 'update': {
          if (typeof args?.id !== 'string' || args.id.trim() === '') throw new Error('update requires `id`')
          const current = await store.get(args.id)
          const merged = { ...current, ...draftOf(args ?? {}), id: current.id }
          const saved = await store.upsert(merged)
          return { ok: true, action, host: { id: saved.id, name: saved.name, destination: hostDestination(saved), ...(saved.description ? { description: saved.description } : {}) }, message: 'Host updated: ' + saved.name }
        }
        case 'remove': {
          const removed = await store.remove(key)
          return { ok: true, action, removed: true, message: 'Host removed: ' + removed.name + ' (id ' + removed.id + ')' }
        }
        case 'test': {
          const host = await store.get(key)
          const result = await testHost(host, config, exec.signal)
          return { ok: result.ok, action, host: { id: host.id, name: host.name, destination: hostDestination(host) }, latencyMs: result.latencyMs, output: result.output, stderr: result.stderr, ...(result.error === undefined ? {} : { error: result.error }) }
        }
        default:
          throw new Error('unknown action "' + action + '"; expected list/get/add/update/remove/test')
      }
    },
  }
}

/**
 * Mount the service, RPC descriptors and agent tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} [config] - the bundle row's config.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const store = createHostStore()
  const service = createService(store, resolved)
  const ssh = sshTool(store, resolved)
  const sshHosts = sshHostsTool(store, resolved)

  ctx.effect(() => ctx.provide(SERVICE, service), 'dsh-plugin-ssh: sshHosts service')

  ctx.effect(
    () =>
      ctx.typert.register({
        package: PACKAGE,
        face: 'host',
        schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: RPC_METHODS.map(([method, wires]) => invocationFor(method, wires)),
      }),
    'dsh-plugin-ssh: rpc descriptors',
  )

  ctx.effect(() => ctx.tools.register(ssh), 'dsh-plugin-ssh: ssh tool')
  ctx.effect(() => ctx.tools.register(sshHosts), 'dsh-plugin-ssh: ssh_hosts tool')

  ctx.logger?.debug?.('dsh-plugin-ssh: mounted (hosts file ' + store.file + ')')
}
