import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Ran, Workspace } from './ports'

// windowsHide: the daemon has no console, so without it every child would open a visible one.
async function sh(cmd: string[], cwd: string, signal?: AbortSignal): Promise<Ran> {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', signal, windowsHide: true })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { ok: code === 0, log: (out + err).trim() }
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
    return r.ok && top && common ? { top: resolve(top), common: resolve(dir, common) } : null
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

  async init(dir: string) {
    for (const args of [['init', '-b', 'main'], ['add', '-A'], ['commit', '--allow-empty', '-m', 'kumi: first commit']]) {
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

  async discard(dir: string) {
    await git(dir, 'reset', '--hard')
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

  // ponytail: cmd/sh with a flat timeout. On Windows a killed `cmd /c` can orphan
  // its children; switch to a job object if gates start leaking processes.
  exec(dir: string, command: string) {
    const shell = process.platform === 'win32' ? ['cmd', '/d', '/s', '/c', command] : ['sh', '-c', command]
    return sh(shell, dir, AbortSignal.timeout(GATE_TIMEOUT))
  }

  async advance(repo: string, base: string, sha: string) {
    if ((await this.branch(repo)) === base) return git(repo, 'merge', '--ff-only', sha)
    // base isn't checked out: compare-and-swap the ref against the commit the gate built on.
    const parent = (await git(repo, 'rev-parse', `${sha}^`)).log
    return git(repo, 'update-ref', `refs/heads/${base}`, sha, parent)
  }

  async cleanup(repo: string, dir: string, branch: string) {
    await git(repo, 'worktree', 'remove', '--force', dir)
    await git(repo, 'branch', '-D', branch)
  }
}
