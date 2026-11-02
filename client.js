/**
 * Browser half of dsh-plugin-ssh: the "SSH 主机" section inside Settings.
 *
 * The section is a normal React component registered into the live
 * `settings.section` slot. It talks to its own Host half through the
 * authenticated `/api` RPC gateway (`sshHosts/list|save|remove|test`), so the
 * UI and the agent tools share one Host implementation.
 *
 * Plain browser JS on purpose: a bundle's Client half runs from the Harness
 * module loader and must not import Harness Client packages.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-ssh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'ssh-hosts'

    /** Chinese source strings are the dictionary keys; English is the translation. */
    const EN = {
      'SSH 主机': 'SSH Hosts',
      '在设置中管理可被 DSH 通过 SSH 控制的主机。智能体通过 `ssh` 工具在这些主机上执行命令；认证使用本机 ssh 客户端（ssh-agent / ~/.ssh/config / 指定私钥）。':
        'Manage the hosts DSH can control over SSH. The agent runs commands on them through the `ssh` tool. Authentication uses your local ssh client (ssh-agent / ~/.ssh/config / an explicit identity file).',
      '添加主机': 'Add host',
      '刷新': 'Refresh',
      '保存': 'Save',
      '取消': 'Cancel',
      '编辑': 'Edit',
      '删除': 'Delete',
      '确认删除': 'Confirm delete',
      '测试连接': 'Test connection',
      '测试中…': 'Testing…',
      '加载中…': 'Loading…',
      '重试': 'Retry',
      '重新加载': 'Reload',
      '还没有配置主机。点击「添加主机」，或让智能体调用 `ssh_hosts` 工具添加。':
        'No hosts yet. Use “Add host”, or ask the agent to call the `ssh_hosts` tool.',
      '名称': 'Name',
      '用户': 'User',
      '主机地址': 'Host',
      '端口': 'Port',
      '私钥文件（可选）': 'Identity file (optional)',
      '跳板机（可选）': 'Jump host (optional)',
      '备注（可选）': 'Description (optional)',
      '名称不能为空': 'Name is required',
      '主机地址不能为空': 'Host is required',
      '端口必须是 1-65535 的整数': 'Port must be an integer between 1 and 65535',
      '加载失败：': 'Failed to load: ',
      '保存失败：': 'Failed to save: ',
      '删除失败：': 'Failed to delete: ',
      '连接成功': 'Connected',
      '连接失败': 'Connection failed',
      '主机文件：': 'Hosts file: ',
      '未填写用户时使用 SSH 客户端的默认用户。': 'When User is empty, the SSH client default is used.',
      '私钥留空则使用 ssh-agent / ~/.ssh/config。': 'Leave empty to use ssh-agent / ~/.ssh/config.',
      '跳板机：': 'Jump host: ',
      '私钥：': 'Identity: ',
      '新建主机': 'New host',
      '编辑主机': 'Edit host',
      '已保存': 'Saved',
      '已删除': 'Deleted',
      '未知错误': 'Unknown error',
    }
    const ZH = {}
    for (const key of Object.keys(EN)) ZH[key] = key

    let translate = null
    let activeLocale = null
    const localeListeners = new Set()

    /** @param {string} source */
    function t(source) {
      if (translate !== null) {
        try {
          const translated = translate(source)
          if (typeof translated === 'string' && translated !== '') return translated
        } catch {
          /* fall through to the static dictionary */
        }
      }
      if (activeLocale !== null && !/^zh/i.test(activeLocale)) return EN[source] ?? source
      return source
    }

    function notifyLocaleListeners() {
      for (const listener of [...localeListeners]) {
        try {
          listener()
        } catch {
          /* one broken listener must not stop the rest */
        }
      }
    }

    /** @param {any} locale */
    function readActiveLocale(locale) {
      try {
        const snapshot = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null
        return snapshot !== null && typeof snapshot.active === 'string' ? snapshot.active : null
      } catch {
        return null
      }
    }

    /** @param {any} ctx */
    function installLocale(ctx) {
      let locale
      try {
        locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      } catch {
        locale = undefined
      }
      if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') {
        return () => {}
      }
      let dispose = null
      try {
        dispose = locale.register(NS, { zh: ZH, en: EN })
      } catch {
        dispose = null
      }
      translate = locale.bind(NS)
      activeLocale = readActiveLocale(locale)
      let unsubscribe = null
      try {
        if (typeof locale.subscribe === 'function') {
          unsubscribe = locale.subscribe(() => {
            activeLocale = readActiveLocale(locale)
            notifyLocaleListeners()
          })
        }
      } catch {
        unsubscribe = null
      }
      return () => {
        try {
          if (typeof unsubscribe === 'function') unsubscribe()
        } catch {
          /* ignore */
        }
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* ignore */
        }
        translate = null
        activeLocale = null
      }
    }

    /** @param {unknown} error */
    function messageOf(error) {
      if (error instanceof Error) return error.message
      if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
      return String(error)
    }

    // ---------------------------------------------------------------- RPC ---

    /**
     * The Context this plugin was mounted on, used to resolve the `connection`
     * service at call time. `connection` is declared in this plugin's `inject`
     * list (see the module exports below), so the property read is legal; the
     * `ctx.get` fallback keeps the UI diagnosable if a future composition
     * provides it lazily.
     * @type {any}
     */
    let pluginContext = null

    /** @param {any} ctx */
    function resolveConnection(ctx) {
      let connection
      try {
        connection = ctx.connection
      } catch {
        connection = undefined
      }
      if ((connection === undefined || connection === null) && typeof ctx.get === 'function') {
        try {
          connection = ctx.get('connection')
        } catch {
          connection = undefined
        }
      }
      return connection
    }

    /**
     * Call one Host RPC endpoint through the authenticated `/api` gateway.
     * The connection is resolved per call rather than captured once, so a
     * transport that mounts after this plugin cannot leave the page stuck in a
     * permanently unavailable state.
     * @param {string} endpoint - `<namespace>/<method>`.
     * @param {object | undefined} args - wire arguments.
     */
    async function callEndpoint(endpoint, args) {
      const connection = resolveConnection(pluginContext)
      if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
        throw new Error(
          'unable to reach the Host: the client `connection` service is not mounted (host RPC unavailable)',
        )
      }
      const response = await connection.rpc.call('/api', endpoint, { args: args ?? {} })
      if (response && response.ok === true) return response.value
      const failure = response && response.error
      throw new Error(failure && typeof failure.message === 'string' ? failure.message : 'RPC failed')
    }

    /** @param {string} method */
    function rpc(method, args) {
      return callEndpoint('sshHosts/' + method, args)
    }

    // ----------------------------------------------------------- component ---

    const EMPTY_DRAFT = {
      id: '',
      name: '',
      user: '',
      host: '',
      port: '22',
      identityFile: '',
      proxyJump: '',
      description: '',
    }

    const CSS = `
.dsh-ssh-root { display: flex; flex-direction: column; gap: 16px; color: var(--dsw-alias-label-primary); }
.dsh-ssh-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dsh-ssh-head-text { min-width: 0; }
.dsh-ssh-title { margin: 0; font-size: 14px; font-weight: 600; }
.dsh-ssh-desc { margin: 4px 0 0; max-width: 620px; font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.dsh-ssh-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsh-ssh-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 12px; font-family: inherit; font-size: 12px; line-height: 1.4; cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease; }
.dsh-ssh-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsh-ssh-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-ssh-btn:disabled { opacity: .55; cursor: default; }
.dsh-ssh-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.dsh-ssh-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); filter: brightness(.94); }
.dsh-ssh-btn-danger { color: var(--dsw-alias-state-error-primary); }
.dsh-ssh-btn-armed { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsh-ssh-banner { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); border-radius: 10px; padding: 8px 12px; font-size: 12px; line-height: 1.55; word-break: break-word; }
.dsh-ssh-banner-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsh-ssh-banner-ok { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.dsh-ssh-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.dsh-ssh-card { display: flex; flex-direction: column; gap: 10px; min-width: 0; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 14px; }
.dsh-ssh-card-head { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsh-ssh-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ssh-addr { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ssh-note { margin: 0; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary); word-break: break-word; }
.dsh-ssh-card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
.dsh-ssh-test { border-radius: 8px; background: var(--dsw-alias-bg-layer-2); padding: 6px 8px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 104px; overflow: auto; }
.dsh-ssh-test-ok { color: var(--dsw-alias-state-success-primary); }
.dsh-ssh-test-bad { color: var(--dsw-alias-state-error-primary); }
.dsh-ssh-test-warn { color: var(--dsw-alias-state-warn-primary); }
.dsh-ssh-empty { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; padding: 28px 16px; text-align: center; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.dsh-ssh-form { display: flex; flex-direction: column; gap: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 16px; }
.dsh-ssh-form-title { font-size: 13px; font-weight: 600; }
.dsh-ssh-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.dsh-ssh-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dsh-ssh-field-wide { grid-column: 1 / -1; }
.dsh-ssh-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-ssh-input { box-sizing: border-box; width: 100%; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 7px 10px; font-family: inherit; font-size: 12px; line-height: 1.5; outline: none; }
.dsh-ssh-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dsh-ssh-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dsh-ssh-error { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; word-break: break-word; }
.dsh-ssh-footer { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); word-break: break-all; }
`

    /** @param {string} id */
    function displayDestination(host) {
      const target = host.user ? host.user + '@' + host.host : host.host
      return host.port === 22 ? target : target + ':' + host.port
    }

    /** @param {unknown} value */
    function validateDraft(value) {
      if (!value || typeof value !== 'object') return t('名称不能为空')
      if (typeof value.name !== 'string' || value.name.trim() === '') return t('名称不能为空')
      if (typeof value.host !== 'string' || value.host.trim() === '') return t('主机地址不能为空')
      const port = Number(value.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return t('端口必须是 1-65535 的整数')
      return null
    }

    /** @param {object} draft */
    function draftPayload(draft) {
      return {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        user: draft.user.trim(),
        host: draft.host.trim(),
        port: Number(draft.port),
        identityFile: draft.identityFile.trim(),
        proxyJump: draft.proxyJump.trim(),
        description: draft.description.trim(),
      }
    }

    function SSHHostsSection() {
      const [snapshot, setSnapshot] = useState({ loading: true, error: null, hosts: [], file: '' })
      const [draft, setDraft] = useState(null)
      const [formError, setFormError] = useState(null)
      const [draftTest, setDraftTest] = useState(null)
      const [busy, setBusy] = useState(null)
      const [testingId, setTestingId] = useState(null)
      const [testResults, setTestResults] = useState({})
      const [confirmingId, setConfirmingId] = useState(null)
      const [note, setNote] = useState(null)
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      const load = useCallback(async () => {
        setSnapshot((previous) => ({ ...previous, loading: true, error: null }))
        try {
          const value = await rpc('list')
          if (!mounted.current) return
          setSnapshot({
            loading: false,
            error: null,
            hosts: Array.isArray(value && value.hosts) ? value.hosts : [],
            file: value && typeof value.file === 'string' ? value.file : '',
          })
        } catch (error) {
          if (!mounted.current) return
          setSnapshot({ loading: false, error: messageOf(error), hosts: [], file: '' })
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      useEffect(() => {
        if (note === null) return undefined
        const timer = setTimeout(() => {
          if (mounted.current) setNote(null)
        }, 6000)
        return () => clearTimeout(timer)
      }, [note])

      function startAdd() {
        setDraft({ ...EMPTY_DRAFT })
        setFormError(null)
        setDraftTest(null)
        setConfirmingId(null)
      }

      /** @param {any} host */
      function startEdit(host) {
        setDraft({
          id: host.id || '',
          name: host.name || '',
          user: host.user || '',
          host: host.host || '',
          port: String(host.port === undefined ? 22 : host.port),
          identityFile: host.identityFile || '',
          proxyJump: host.proxyJump || '',
          description: host.description || '',
        })
        setFormError(null)
        setDraftTest(null)
        setConfirmingId(null)
      }

      /** @param {object} patch */
      function updateDraft(patch) {
        setDraft((previous) => (previous === null ? previous : { ...previous, ...patch }))
        setFormError(null)
      }

      async function saveDraft() {
        if (draft === null) return
        const invalid = validateDraft(draft)
        if (invalid !== null) {
          setFormError(invalid)
          return
        }
        setBusy('save')
        setFormError(null)
        try {
          await rpc('save', { host: draftPayload(draft) })
          if (!mounted.current) return
          setDraft(null)
          setDraftTest(null)
          setNote({ kind: 'ok', text: t('已保存') })
          await load()
        } catch (error) {
          if (mounted.current) setFormError(t('保存失败：') + messageOf(error))
        } finally {
          if (mounted.current) setBusy(null)
        }
      }

      async function testSaved(host) {
        setTestingId(host.id)
        try {
          const result = await rpc('test', { id: host.id })
          if (mounted.current) setTestResults((previous) => ({ ...previous, [host.id]: result }))
        } catch (error) {
          if (mounted.current) {
            setTestResults((previous) => ({ ...previous, [host.id]: { ok: false, error: messageOf(error) } }))
          }
        } finally {
          if (mounted.current) setTestingId(null)
        }
      }

      async function testDraftInForm() {
        if (draft === null) return
        const invalid = validateDraft(draft)
        if (invalid !== null) {
          setFormError(invalid)
          return
        }
        setBusy('test')
        setFormError(null)
        setDraftTest(null)
        try {
          const payload = draftPayload(draft)
          delete payload.id
          const result = await rpc('test', { host: payload })
          if (mounted.current) setDraftTest(result)
        } catch (error) {
          if (mounted.current) setDraftTest({ ok: false, error: messageOf(error) })
        } finally {
          if (mounted.current) setBusy(null)
        }
      }

      /** @param {any} host */
      async function removeHost(host) {
        if (confirmingId !== host.id) {
          setConfirmingId(host.id)
          return
        }
        setConfirmingId(null)
        setBusy(host.id)
        try {
          await rpc('remove', { id: host.id })
          if (!mounted.current) return
          setNote({ kind: 'ok', text: t('已删除') })
          await load()
        } catch (error) {
          if (mounted.current) setNote({ kind: 'error', text: t('删除失败：') + messageOf(error) })
        } finally {
          if (mounted.current) setBusy(null)
        }
      }

      // ---------------------------------------------------------- render ---

      /** @param {string} key @param {string} label @param {string} value @param {(next: string) => void} onChange @param {string[]} extra */
      function field(key, label, value, onChange, extra) {
        return h(
          'label',
          { className: 'dsh-ssh-field', key },
          h('span', { className: 'dsh-ssh-label' }, label),
          h('input', {
            className: 'dsh-ssh-input',
            value,
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => onChange(event.target.value),
            ...(extra && extra.length > 0 ? { placeholder: extra[0] } : {}),
            ...(extra && extra.length > 1 ? { inputMode: extra[1] } : {}),
          }),
        )
      }

      const header = h(
        'div',
        { className: 'dsh-ssh-head' },
        h(
          'div',
          { className: 'dsh-ssh-head-text' },
          h('h2', { className: 'dsh-ssh-title' }, t('SSH 主机')),
          h(
            'p',
            { className: 'dsh-ssh-desc' },
            t('在设置中管理可被 DSH 通过 SSH 控制的主机。智能体通过 `ssh` 工具在这些主机上执行命令；认证使用本机 ssh 客户端（ssh-agent / ~/.ssh/config / 指定私钥）。'),
          ),
        ),
        h(
          'div',
          { className: 'dsh-ssh-actions' },
          h(
            'button',
            { type: 'button', className: 'dsh-ssh-btn', onClick: () => load(), disabled: snapshot.loading },
            t('刷新'),
          ),
          h('button', { type: 'button', className: 'dsh-ssh-btn dsh-ssh-btn-primary', onClick: startAdd }, t('添加主机')),
        ),
      )

      /** @param {any} result */
      function testLine(result) {
        if (!result) return null
        const ok = result.ok === true
        const label = ok ? t('连接成功') : t('连接失败')
        const details = ok
          ? (typeof result.latencyMs === 'number' ? ' · ' + result.latencyMs + ' ms' : '') +
            (result.output ? ' · ' + String(result.output).split('\n')[0] : '')
          : ' · ' + (result.error || result.stderr || (result.timedOut ? 'timeout' : 'exit ' + result.exitCode))
        return h(
          'div',
          { className: 'dsh-ssh-test ' + (ok ? 'dsh-ssh-test-ok' : 'dsh-ssh-test-bad') },
          label + details,
        )
      }

      const cards = snapshot.hosts.map((host) => {
        const busyThis = busy === host.id
        const armed = confirmingId === host.id
        const extras = []
        if (host.identityFile) extras.push(h('p', { className: 'dsh-ssh-note', key: 'identity' }, t('私钥：') + host.identityFile))
        if (host.proxyJump) extras.push(h('p', { className: 'dsh-ssh-note', key: 'jump' }, t('跳板机：') + host.proxyJump))
        return h(
          'div',
          { className: 'dsh-ssh-card', key: host.id },
          h(
            'div',
            { className: 'dsh-ssh-card-head' },
            h('div', { className: 'dsh-ssh-name', title: host.name }, host.name),
            h('div', { className: 'dsh-ssh-addr', title: displayDestination(host) }, displayDestination(host)),
          ),
          host.description ? h('p', { className: 'dsh-ssh-note' }, host.description) : null,
          ...extras,
          testLine(testResults[host.id]),
          h(
            'div',
            { className: 'dsh-ssh-card-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ssh-btn',
                disabled: testingId === host.id || busyThis,
                onClick: () => testSaved(host),
              },
              testingId === host.id ? t('测试中…') : t('测试连接'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ssh-btn',
                disabled: busyThis,
                onClick: () => startEdit(host),
              },
              t('编辑'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ssh-btn dsh-ssh-btn-danger' + (armed ? ' dsh-ssh-btn-armed' : ''),
                disabled: busyThis,
                onClick: () => removeHost(host),
                onBlur: () => {
                  if (confirmingId === host.id) setConfirmingId(null)
                },
              },
              armed ? t('确认删除') : t('删除'),
            ),
          ),
        )
      })

      const list =
        snapshot.loading && snapshot.hosts.length === 0
          ? h('div', { className: 'dsh-ssh-empty' }, t('加载中…'))
          : snapshot.hosts.length === 0
            ? h(
                'div',
                { className: 'dsh-ssh-empty' },
                t('还没有配置主机。点击「添加主机」，或让智能体调用 `ssh_hosts` 工具添加。'),
              )
            : h('div', { className: 'dsh-ssh-list' }, ...cards)

      const form =
        draft === null
          ? null
          : h(
              'div',
              { className: 'dsh-ssh-form' },
              h('div', { className: 'dsh-ssh-form-title' }, draft.id ? t('编辑主机') : t('新建主机')),
              h(
                'div',
                { className: 'dsh-ssh-grid' },
                field('name', t('名称'), draft.name, (value) => updateDraft({ name: value }), ['prod-web-1']),
                field('host', t('主机地址'), draft.host, (value) => updateDraft({ host: value }), ['10.0.0.10 / example.com']),
                field('user', t('用户'), draft.user, (value) => updateDraft({ user: value }), ['root']),
                field('port', t('端口'), draft.port, (value) => updateDraft({ port: value }), ['22', 'numeric']),
                field('identityFile', t('私钥文件（可选）'), draft.identityFile, (value) => updateDraft({ identityFile: value }), ['~/.ssh/id_ed25519']),
                field('proxyJump', t('跳板机（可选）'), draft.proxyJump, (value) => updateDraft({ proxyJump: value }), ['user@bastion:22']),
                h(
                  'label',
                  { className: 'dsh-ssh-field dsh-ssh-field-wide', key: 'description' },
                  h('span', { className: 'dsh-ssh-label' }, t('备注（可选）')),
                  h('input', {
                    className: 'dsh-ssh-input',
                    value: draft.description,
                    spellCheck: false,
                    autoComplete: 'off',
                    placeholder: '生产环境 Web 服务器',
                    onChange: (event) => updateDraft({ description: event.target.value }),
                  }),
                ),
              ),
              h('div', { className: 'dsh-ssh-hint' }, t('未填写用户时使用 SSH 客户端的默认用户。')),
              h('div', { className: 'dsh-ssh-hint' }, t('私钥留空则使用 ssh-agent / ~/.ssh/config。')),
              formError === null ? null : h('div', { className: 'dsh-ssh-error' }, formError),
              testLine(draftTest),
              h(
                'div',
                { className: 'dsh-ssh-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ssh-btn dsh-ssh-btn-primary',
                    disabled: busy !== null,
                    onClick: () => saveDraft(),
                  },
                  t('保存'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ssh-btn',
                    disabled: busy !== null,
                    onClick: () => testDraftInForm(),
                  },
                  busy === 'test' ? t('测试中…') : t('测试连接'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ssh-btn',
                    disabled: busy !== null,
                    onClick: () => {
                      setDraft(null)
                      setFormError(null)
                      setDraftTest(null)
                    },
                  },
                  t('取消'),
                ),
              ),
            )

      const banners = []
      if (note !== null) {
        banners.push(
          h('div', { className: 'dsh-ssh-banner ' + (note.kind === 'error' ? 'dsh-ssh-banner-error' : 'dsh-ssh-banner-ok'), key: 'note' }, note.text),
        )
      }
      if (snapshot.error !== null) {
        banners.push(
          h(
            'div',
            { className: 'dsh-ssh-banner dsh-ssh-banner-error', key: 'error' },
            t('加载失败：') + snapshot.error + ' ',
            h('button', { type: 'button', className: 'dsh-ssh-btn', onClick: () => load() }, t('重试')),
          ),
        )
      }

      return h(
        'section',
        { className: 'dsh-ssh-root' },
        h('style', { key: 'style' }, CSS),
        header,
        ...banners,
        list,
        form,
        snapshot.file
          ? h('div', { className: 'dsh-ssh-footer' }, t('主机文件：') + snapshot.file)
          : null,
      )
    }

    function withLocale(Component) {
      return function LocaleAwareSlot(props) {
        const [, bump] = useState(0)
        useEffect(() => {
          const listener = () => bump((value) => value + 1)
          localeListeners.add(listener)
          return () => {
            localeListeners.delete(listener)
          }
        }, [])
        return h(Component, props)
      }
    }

    const Section = withLocale(SSHHostsSection)

    return {
      // `connection` is the authenticated Host transport service. It MUST be
      // declared here: on a restricted client Context, reading an undeclared
      // service throws instead of returning undefined.
      inject: ['slots', 'connection'],
      apply(ctx) {
        pluginContext = ctx
        ctx.effect(() => installLocale(ctx), 'dsh-plugin-ssh: locale')
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'ssh-hosts',
                  order: 24,
                  label: () => t('SSH 主机'),
                },
                Section,
              ),
            ),
          'dsh-plugin-ssh: settings section',
        )
      },
    }
  },
})
