#!/usr/bin/env node
/**
 * Generate (or refresh) `market/index.json` — the DSH plugin market index
 * (format 1) that lists this package.
 *
 * The file is committed and served from the repository, so users add its raw
 * URL as a market source. Regenerate after every npm publish so the version and
 * `publishTimestamp` match what the registry has:
 *
 *   node scripts/build-market-index.mjs --published-at <unix-seconds>
 *
 * Without `--published-at` the current time is used, which is right for a
 * local preview but not for a real listing.
 *
 * Format reference: dsh-plugin-market-index `parseMarketIndex` (format 1).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'))

const pkg = await readJson('package.json')
const zh = await readJson('locale/zh.json')
const en = await readJson('locale/en.json')
const iconSvg = await readFile(new URL('icon.svg', root))
const icon = 'data:image/svg+xml;base64,' + iconSvg.toString('base64')

const MAX_INLINE_ICON_BYTES = 32 * 1024
if (iconSvg.length > MAX_INLINE_ICON_BYTES) {
  throw new Error(`icon.svg is ${iconSvg.length} bytes; the market index inlines at most ${MAX_INLINE_ICON_BYTES}`)
}

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/
if (!SEMVER.test(pkg.version)) throw new Error(`package.json version ${JSON.stringify(pkg.version)} is not exact SemVer`)

const publishedAtArg = process.argv.indexOf('--published-at')
const publishedAt = publishedAtArg >= 0 ? Number(process.argv[publishedAtArg + 1]) : Math.floor(Date.now() / 1000)
if (!Number.isInteger(publishedAt) || publishedAt < 0 || publishedAt >= 1e11) {
  throw new Error('--published-at must be an integer number of Unix seconds')
}

const repositoryUrl = String(pkg.repository?.url ?? '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '')
if (!/^https?:\/\/[^/]+\/[^/]+\/[^/]+$/.test(repositoryUrl)) {
  throw new Error(`package.json repository.url does not name a flat GitHub-style repository: ${JSON.stringify(pkg.repository?.url)}`)
}

const index = {
  format: 1,
  title: { en: 'Pelucoola DSH Plugins', zh: 'Pelucoola DSH 插件' },
  description: {
    en: 'Community DSH plugin index by pelucoola.',
    zh: 'pelucoola 维护的 DSH 社区插件索引。',
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: en.meta.title, zh: zh.meta.title },
      description: { en: en.meta.description, zh: zh.meta.description },
      author: String(pkg.author ?? 'pelucoola'),
      homepage: pkg.homepage,
      repository: { url: repositoryUrl },
      icon,
      versions: [
        {
          version: pkg.version,
          publishTimestamp: publishedAt,
          source: { type: 'npm' },
          engines: pkg.engines?.dsh === undefined ? {} : { dsh: pkg.engines.dsh },
        },
      ],
    },
  ],
}

const out = new URL('market/index.json', root)
await mkdir(new URL('market/', root), { recursive: true })
await writeFile(out, JSON.stringify(index, null, 2) + '\n', 'utf8')

const relative = fileURLToPath(out).slice(fileURLToPath(root).length)
process.stdout.write(`wrote ${relative} (${pkg.name}@${pkg.version}, publishTimestamp ${publishedAt})\n`)
