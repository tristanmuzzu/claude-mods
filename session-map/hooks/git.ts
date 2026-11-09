// Reading git's output: pure parsers, exported for the tests. The calls that run git take `$`
// and live in register.tsx, where the directory's checks can follow every use of `$`.

import type { Commit, RepoFile } from '../types'

/** The first folder of a path inside the repository; empty for a file at its root. */
export function topOf(rel: string): string {
  const i = rel.indexOf('/')
  return i > 0 ? rel.slice(0, i) : ''
}

/** `grep -cH` output (`path:count` per line) as counts by path inside the repository. */
export function parseCounts(out: string, root: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const line of out.split('\n')) {
    const i = line.lastIndexOf(':')
    if (i <= 0) continue
    const path = line.slice(0, i)
    const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
    counts[rel] = Number(line.slice(i + 1)) || 0
  }
  return counts
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
  return { branch, hasUpstream, ahead, behind, files }
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
