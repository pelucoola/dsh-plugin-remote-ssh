import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
/** Path of the browser bundle that dsh loads through `__ModuleLoader__`. */
const CLIENT_PATH = new URL('../client.js', import.meta.url)

/**
 * Minimal React surface the browser bundle touches at load time. Components are
 * never rendered here; only the module factory and plugin exports are exercised.
 */
const ReactStub = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
}

/**
 * Evaluate client.js in a fresh VM so its `window.__ModuleLoader__` registration
 * can be captured without a browser.
 * @returns {Promise<{ id: string, factory: (require: (id: string) => unknown) => any }>}
 */
async function loadRegistration() {
  const source = await readFile(CLIENT_PATH, 'utf8')
  /** @type {{ id: string, factory: (require: (id: string) => unknown) => any } | null} */
  let registration = null
  const window = {
    __ModuleLoader__: {
      load(definition) {
        registration = definition
      },
    },
  }
  const context = vm.createContext({ window, console, setTimeout, clearTimeout })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.ok(registration, 'client.js must register through window.__ModuleLoader__')
  return registration
}

test('client half registers the expected module id and required services', async () => {
  const registration = await loadRegistration()
  assert.equal(registration.id, 'dsh-plugin-remote-ssh')

  const plugin = registration.factory((id) => {
    if (id === 'react') return ReactStub
    throw new Error('unexpected require: ' + id)
  })

  // `connection` is the authenticated transport. Without it the settings page
  // can never reach its Host half — the bug this test exists to prevent.
  assert.deepEqual([...plugin.inject].sort(), ['connection', 'slots'])
  assert.equal(typeof plugin.apply, 'function')
})

test('client half registers one settings.section entry and disposes it', async () => {
  const registration = await loadRegistration()
  const plugin = registration.factory((id) => {
    if (id === 'react') return ReactStub
    throw new Error('unexpected require: ' + id)
  })

  const effects = []
  const injections = []
  const registrations = []
  const ctx = {
    connection: { rpc: { call: async () => ({ ok: true, value: { hosts: [], file: '/tmp/ssh-hosts.json' } }) } },
    get() {
      return undefined
    },
    effect(callback, label) {
      const dispose = callback()
      effects.push({ label, dispose })
      return dispose
    },
    slots: {
      inject(key, callback) {
        injections.push(key)
        const dispose = callback()
        return dispose
      },
      register(options) {
        registrations.push(options)
        return () => {}
      },
    },
  }

  plugin.apply(ctx)

  assert.deepEqual(injections, ['settings.section'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'settings.section')
  assert.equal(registrations[0].id, 'ssh-hosts')
  assert.equal(registrations[0].order, 24)
  // No locale service in this context: the label falls back to its Chinese source.
  assert.equal(registrations[0].label(), 'SSH 主机')
  assert.ok(effects.every((effect) => typeof effect.dispose === 'function'))
})
