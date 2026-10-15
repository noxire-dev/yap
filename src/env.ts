import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const home = process.env.KUMI_HOME ?? join(homedir(), '.kumi')
export const port = Number(process.env.KUMI_PORT ?? 4170)
// 127.0.0.1, not localhost: Windows tries ::1 first and the daemon only binds v4.
export const url = `http://127.0.0.1:${port}`

/** Changes whenever the source does, so a client can tell it is talking to a daemon running older code. */
export const build = Math.max(...readdirSync(import.meta.dir).map(f => statSync(join(import.meta.dir, f)).mtimeMs))

// What a crew agent or a gate gets of the daemon's environment. The daemon is often started from inside a Claude
// Code session or a Herdr pane, so its environment carries their ids, sockets and tokens: enough for an agent to
// speak as that session or drive other panes. Plus whatever secrets the shell exported. KUMI_PASS names more.
const KEEP = /^(path|pathext|systemroot|systemdrive|windir|comspec|os|processor_\w+|number_of_processors|programfiles.*|programdata|programw6432|commonprogram.*|allusersprofile|public|computername|username|userdomain\w*|userprofile|homedrive|homepath|appdata|localappdata|temp|tmp|tmpdir|psmodulepath|home|user|logname|shell|lang|lc_\w+|tz|term|xdg_\w+|nvm_\w+|volta_home|pnpm_home|bun_install|deno_dir|java_home|gopath|goroot|cargo_home|rustup_home|dotnet_root|pyenv\w*|chocolateyinstall|claude_config_dir)$/i

export function childEnv(env: Record<string, string | undefined> = process.env) {
  const pass = new Set((env.KUMI_PASS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (KEEP.test(k) || pass.has(k.toLowerCase()))) out[k] = v
  return out
}
