// Reading git, read-only: which repository a file belongs to, what is
// uncommitted, what was committed since the map started, and what is pushed.
// Pure parsers are exported for the tests; the callers take `$` at top level.

import type { EngineInterface } from 'claude-code'

import type { Commit, Repo, RepoFile } from '../types'

const roots: Record<string, string | null> = {}

/** The last git failure, for the dev probe. */
export const gitTrouble = { last: '' }

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 8000 })
    if (r.exitCode !== 0) gitTrouble.last = `git ${args[0]} in ${cwd}: exit ${r.exitCode} ${r.stderr.slice(0, 200)}`
    return r.exitCode === 0 ? r.stdout : null
  } catch (err) {
    gitTrouble.last = `git ${args[0]} in ${cwd}: ${String(err).slice(0, 300)}`
    return null
  }
}

/** The repository root that holds `dir`, or null; remembered per folder. */
export async function rootOf($: EngineInterface, dir: string): Promise<string | null> {
  if (dir in roots) return roots[dir] ?? null
  const out = await git($, dir, ['rev-parse', '--show-toplevel'])
  const root = out ? out.trim() : null
  roots[dir] = root
  return root
}

/** Looks at one repository; the first look sets its baseline and starting commit. */
export async function scan($: EngineInterface, root: string, was: Repo | null, now: number): Promise<Repo | null> {
  const status = await git($, root, ['status', '--porcelain=v1', '-b', '--untracked-files=all'])
  if (status === null) return was
  const numstat = (await git($, root, ['diff', '--numstat', 'HEAD'])) ?? ''
  const head = ((await git($, root, ['rev-parse', 'HEAD'])) ?? '').trim()
  const headAtStart = was?.headAtStart ?? head
  const parsed = parseStatus(status, numstat)
  // Line counts since the session started: what was committed since counts too.
  const sinceStat = headAtStart && head && head !== headAtStart ? ((await git($, root, ['diff', '--numstat', headAtStart])) ?? '') : numstat
  const changed = parseNumstat(sinceStat)
  let commits: Commit[] = []
  if (headAtStart && head && head !== headAtStart) {
    const log = await git($, root, ['log', '--format=%h%x09%ct%x09%s', '-n', '30', `${headAtStart}..HEAD`])
    commits = parseLog(log ?? '')
  }
  return {
    root,
    name: root.slice(root.lastIndexOf('/') + 1),
    branch: parsed.branch,
    hasUpstream: parsed.hasUpstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    headAtStart,
    baseline: was ? was.baseline : parsed.files.map(f => f.rel),
    files: parsed.files,
    changed,
    commits,
    scannedAt: now,
  }
}

/**
 * A repository as it stood when the chat began, for a map that starts late: the commit HEAD was
 * on then, and the changed files nobody has touched since (older than the chat, so not its work).
 */
export async function rebase($: EngineInterface, repo: Repo, since: number): Promise<Repo> {
  const before = await git($, repo.root, ['rev-list', '-1', `--before=${Math.floor(since / 1000)}`, 'HEAD'])
  const baseline: string[] = []
  for (const f of repo.files) {
    const stat = await $.fs.stat(`${repo.root}/${f.rel}`).catch(() => null)
    // A file gone since cannot say when; deleting it is more likely the chat's work.
    if (stat && stat.mtimeMs < since) baseline.push(f.rel)
  }
  return { ...repo, headAtStart: before?.trim() || repo.headAtStart, baseline }
}

/** The file's change against HEAD as a unified diff, cut to a readable length. */
export async function diffOf($: EngineInterface, root: string, rel: string, isNew: boolean, base = 'HEAD'): Promise<string> {
  const out = isNew
    ? await gitAny($, root, ['diff', '--no-index', '--', '/dev/null', rel])
    : await git($, root, ['diff', base || 'HEAD', '--', rel])
  return cutDiff(out ?? '')
}

async function gitAny($: EngineInterface, cwd: string, args: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 8000 })
    return r.stdout
  } catch {
    return null
  }
}

export function cutDiff(diff: string): string {
  const lines = diff.split('\n')
  const start = lines.findIndex(l => l.startsWith('--- '))
  const body = start >= 0 ? lines.slice(start) : lines
  if (body.length <= 2000) return body.join('\n').trimEnd()
  // Keep whole hunks only, so the result still parses as a diff.
  const kept: string[] = []
  for (const line of body) {
    if (line.startsWith('@@') && kept.length > 1900) break
    kept.push(line)
  }
  return kept.join('\n').trimEnd()
}

export function parseStatus(status: string, numstat: string) {
  const lines = status.split('\n').filter(Boolean)
  const head = lines[0]?.startsWith('## ') ? (lines.shift() ?? '') : ''
  let branch = 'HEAD'
  let hasUpstream = false
  let ahead = 0
  let behind = 0
  const m = /^## (?:No commits yet on )?([^\s.]+(?:\.[^\s.]+)*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head)
  if (m) {
    branch = m[1] ?? 'HEAD'
    hasUpstream = Boolean(m[2])
    ahead = Number(/ahead (\d+)/.exec(m[3] ?? '')?.[1] ?? 0)
    behind = Number(/behind (\d+)/.exec(m[3] ?? '')?.[1] ?? 0)
  }
  const counts: Record<string, { added: number; removed: number }> = {}
  for (const line of numstat.split('\n')) {
    const [a, r, ...rest] = line.split('\t')
    const rel = rest.join('\t')
    if (rel) counts[rel] = { added: Number(a) || 0, removed: Number(r) || 0 }
  }
  const files: RepoFile[] = lines.map(line => {
    const code = line.slice(0, 2)
    let rel = line.slice(3)
    if (rel.includes(' -> ')) rel = rel.slice(rel.indexOf(' -> ') + 4)
    rel = rel.replace(/^"(.*)"$/, '$1')
    return { rel, code, added: counts[rel]?.added ?? 0, removed: counts[rel]?.removed ?? 0 }
  })
  return { branch, hasUpstream, ahead, behind, files: files.slice(0, 400) }
}

/** `git diff --numstat` lines as files with their counts (binary files count 0). */
export function parseNumstat(numstat: string): RepoFile[] {
  return numstat
    .split('\n')
    .map(line => line.split('\t'))
    .filter(p => p.length >= 3 && p[2])
    .map(([a, r, ...rest]) => ({ rel: rest.join('\t'), code: 'M', added: Number(a) || 0, removed: Number(r) || 0 }))
    .slice(0, 400)
}

export function parseLog(log: string): Commit[] {
  return log
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha, ct, ...subject] = line.split('\t')
      return { sha: sha ?? '', at: Number(ct) || 0, subject: subject.join('\t') }
    })
}
