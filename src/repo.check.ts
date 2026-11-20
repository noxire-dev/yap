// The repo's own rules, run: what AGENTS.md's "Hit every surface" asks for that a file can show.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ALL } from './wire'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const spec = read('docs/yap.md')
const sdk = read('sdk/local.ts')
const mcp = read('src/mcp.ts')
const cli = read('src/cli.ts')

// Every verb /yap takes is in the spec and the SDK.
for (const v of ALL) {
  assert.ok(spec.includes(`\`${v}\``), `docs/yap.md never names the verb ${v}`)
  assert.ok(sdk.includes(`'${v}'`), `sdk/local.ts never calls the verb ${v}`)
}

// Every MCP tool is listed in the spec's yap mcp paragraph.
for (const [, tool] of mcp.matchAll(/name: '(yap_\w+)'/g)) assert.ok(spec.includes(tool), `docs/yap.md never names the MCP tool ${tool}`)

// Every yap command the usage text lists has a branch that runs it.
const usage = cli.slice(cli.indexOf('const USAGE'), cli.indexOf('`', cli.indexOf('`', cli.indexOf('const USAGE')) + 1))
for (const [, cmd] of usage.matchAll(/^yap (\w[\w-]*)/gm)) assert.ok(cli.includes(`cmd === '${cmd}'`), `yap ${cmd} is in the usage but nothing runs it`)

// The plugin's hook script is LF: sh on Windows chokes on CRLF.
assert.ok(!read('hooks/yap.sh').includes('\r'), 'hooks/yap.sh has CRLF line endings')

console.log('repo ok')
