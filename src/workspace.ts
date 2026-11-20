import { copyFileSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
/** The path as the file system spells it: long names, real case. */
const real = (p: string) => {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}
import { childEnv } from './env'
import type { Ran, Workspace } from './ports'

// windowsHide: the daemon has no console, so without it every child would open a visible one.
async function sh(cmd: string[], cwd: string, env?: Record<string, string>): Promise<Ran & { code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { ok: code === 0, log: (out + err).trim(), code, out }
}

const git = (cwd: string, ...args: string[]) => sh(['git', ...args], cwd)

const GATE_TIMEOUT = 15 * 60_000

export class LocalWorkspace implements Workspace {
  async root(dir: string) {
    if (!existsSync(dir)) return null
    const r = await git(dir, 'rev-parse', '--show-toplevel')
    return r.ok ? resolve(r.log) : null
  }

  async where(dir: string) {
    if (!existsSync(dir)) return null
    const r = await git(dir, 'rev-parse', '--show-toplevel', '--git-common-dir')
    const [top, common] = r.log.split(/\r?\n/)
    // Through realpath: Windows can hand out one folder as C:\Users\RUNNER~1\... and C:\Users\runneradmin\..., and git
    // answers the main worktree's common dir relative to `dir` but another worktree's absolute.
    return r.ok && top && common ? { top: real(top), common: real(resolve(dir, common)) } : null
  }

  async changed(top: string) {
    // Not through sh(): its trim would eat the leading space of the first entry's status.
    const p = Bun.spawn(['git', 'status', '--porcelain', '-z', '--untracked-files=all'], { cwd: top, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', windowsHide: true })
    const text = await new Response(p.stdout).text()
    if ((await p.exited) !== 0) return []
    const out: { path: string; mtime: number }[] = []
    const parts = text.split('\u0000')
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]
      if (e.length < 4) continue
      // A rename or copy carries its old path as the next entry.
      if (e[0] === 'R' || e[0] === 'C') i++
      const path = join(top, e.slice(3))
      try {
        out.push({ path, mtime: statSync(path).mtimeMs })
      } catch {} // deleted
    }
    return out
  }

  async snapshot(top: string) {
    // A copy of the real index keeps its stat cache, so `add -A` rehashes only what changed; the real one is untouched.
    const index = resolve(top, (await git(top, 'rev-parse', '--git-path', 'index')).log)
    const tmp = join(tmpdir(), `yap-index-${randomUUID()}`)
    try {
      if (existsSync(index)) copyFileSync(index, tmp)
      const env = { GIT_INDEX_FILE: tmp }
      if (!(await sh(['git', 'add', '-A'], top, env)).ok) return null
      const tree = await sh(['git', 'write-tree'], top, env)
      if (!tree.ok) return null
      // ponytail: each snapshot leaves an unreachable commit for git gc to collect.
      const c = await git(top, '-c', 'user.name=yap', '-c', 'user.email=yap@localhost', 'commit-tree', tree.log, '-p', 'HEAD', '-m', 'yap snapshot')
      return c.ok ? c.log : null
    } finally {
      rmSync(tmp, { force: true })
    }
  }

  async conflicts(dir: string, a: string, b: string) {
    const r = await git(dir, 'merge-tree', '--write-tree', '--name-only', '--no-messages', a, b)
    // 0 merges cleanly, 1 conflicts with the file names after the tree id; anything else (git before 2.38) is unknown.
    if (r.code === 0) return []
    return r.code === 1 ? [...new Set(r.out.split(/\r?\n/).slice(1).filter(Boolean))] : null
  }

  async init(dir: string) {
    for (const args of [['init', '-b', 'main'], ['add', '-A'], ['commit', '--allow-empty', '-m', 'yap: first commit']]) {
      const r = await git(dir, ...args)
      if (!r.ok) throw new Error(`git ${args[0]}: ${r.log}`)
    }
  }

  async slug(repo: string) {
    const r = await git(repo, 'remote', 'get-url', 'origin')
    return (r.ok && r.log.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]) || null
  }

  gateHint(repo: string) {
    const has = (f: string) => existsSync(join(repo, f))
    if (has('pyproject.toml') || has('pytest.ini')) return 'python -m pytest'
    try {
      if (!JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts?.test) return ''
    } catch {
      return ''
    }
    if (has('bun.lock') || has('bun.lockb')) return 'bun install --frozen-lockfile && bun run test'
    if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile && pnpm test'
    return 'npm install && npm test'
  }

  async branch(repo: string) {
    if (!existsSync(repo)) return null
    const r = await git(repo, 'symbolic-ref', '--short', 'HEAD')
    return r.ok ? r.log : null
  }

  async worktree(repo: string, dir: string, branch: string, base: string) {
    if (existsSync(dir)) return
    await git(repo, 'worktree', 'prune')
    const exists = (await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).ok
    const r = exists
      ? await git(repo, 'worktree', 'add', dir, branch)
      : await git(repo, 'worktree', 'add', '-b', branch, dir, base)
    if (!r.ok) throw new Error(`worktree: ${r.log}`)
  }

  async mergeBase(dir: string, base: string) {
    return (await git(dir, 'merge', '--no-edit', base)).ok
  }

  async commitAll(dir: string, message: string) {
    await git(dir, 'add', '-A')
    const r = await git(dir, 'commit', '-m', message)
    // "nothing to commit" exits non-zero; a clean tree is what counts.
    const dirty = (await git(dir, 'status', '--porcelain')).log
    return { ok: !dirty, log: r.log }
  }

  async diff(repo: string, base: string, branch: string) {
    return (await git(repo, 'diff', `${base}...${branch}`)).log
  }

  async head(dir: string) {
    return (await git(dir, 'rev-parse', 'HEAD')).log
  }

  async landed(repo: string, base: string, id: number) {
    const r = await git(repo, 'log', base, '-n', '1', '--format=%H', `--grep=^Ticket: ${id}$`)
    return (r.ok && r.log) || null
  }

  async discard(dir: string, to?: string) {
    await git(dir, 'reset', '--hard', ...(to ? [to] : []))
    await git(dir, 'clean', '-fd')
  }

  async squash(repo: string, scratch: string, base: string, branch: string, message: string) {
    if (!existsSync(scratch)) {
      await git(repo, 'worktree', 'prune')
      const r = await git(repo, 'worktree', 'add', '--detach', scratch, base)
      if (!r.ok) return r
    } else {
      // clean -fd keeps ignored files, so node_modules survives between gates.
      await this.discard(scratch)
      const r = await git(scratch, 'checkout', '--detach', base)
      if (!r.ok) return r
    }
    const merge = await git(scratch, 'merge', '--squash', branch)
    if (!merge.ok) {
      await this.discard(scratch)
      return { ok: false, log: `merge conflict against ${base}:\n${merge.log}` }
    }
    const commit = await git(scratch, 'commit', '-m', message)
    if (!commit.ok) return commit
    return { ok: true, log: '', sha: (await git(scratch, 'rev-parse', 'HEAD')).log }
  }

  /**
   * The gate. On timeout the whole process tree goes, not just the shell. A process the gate leaves running
   * (a dev server) can hold the output open forever, so the output is read for two seconds past exit at most.
   */
  async exec(dir: string, command: string) {
    const win = process.platform === 'win32'
    // cmd parses its own command line: hand it over verbatim, wrapped in the quotes /s strips, or Bun's escaping
    // of inner quotes (\") mangles the command and a failing gate can exit 0.
    const p = Bun.spawn(win ? ['cmd', '/d', '/s', '/c', `"${command}"`] : ['sh', '-c', command], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
      // It runs code an agent wrote.
      env: { ...childEnv(), YAP_AGENT: '1' },
    })
    let buf = ''
    const dec = new TextDecoder()
    const pump = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) buf += dec.decode(c, { stream: true })
    }
    const out = Promise.all([pump(p.stdout), pump(p.stderr)]).then(() => true)
    const timer = setTimeout(() => {
      // ponytail: POSIX kills the shell only; a process group needs a detached spawn if gates leak there too.
      if (win) Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(p.pid)], { windowsHide: true })
      else p.kill('SIGKILL')
    }, GATE_TIMEOUT)
    const code = await p.exited
    clearTimeout(timer)
    const whole = await Promise.race([out, Bun.sleep(2000).then(() => false)])
    return { ok: code === 0, log: buf.trim() + (whole ? '' : '\n(a process the gate started is still running)') }
  }

  async advance(repo: string, base: string, sha: string) {
    // Wherever base is checked out (the main checkout or another worktree), move it there, so that tree follows.
    const list = (await git(repo, 'worktree', 'list', '--porcelain')).log.split(/\r?\n\r?\n/)
    const at = list.find(w => w.includes(`\nbranch refs/heads/${base}`))?.match(/^worktree (.+)$/m)?.[1]
    if (at) return git(at, 'merge', '--ff-only', sha)
    // base isn't checked out: compare-and-swap the ref against the commit the gate built on.
    const parent = (await git(repo, 'rev-parse', `${sha}^`)).log
    return git(repo, 'update-ref', `refs/heads/${base}`, sha, parent)
  }

  async cleanup(repo: string, dir: string, branch?: string) {
    await git(repo, 'worktree', 'remove', '--force', dir)
    if (branch) await git(repo, 'branch', '-D', branch)
  }
}
