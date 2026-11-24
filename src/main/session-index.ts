/**
 * 扫 `~/.grok/sessions`，把别的入口建的 Grok 会话列出来。
 *
 * Desktop 侧栏原来只记「这个窗口自己建过、并写进 localStorage」的会话。
 * WorkHub 里嵌的 Grok、终端里的 `grok` 用的是同一份 `~/.grok`，会话落在
 * `~/.grok/sessions/<编码 cwd>/<sessionId>/summary.json`，但不会自动进侧栏。
 * 这里只读 summary（约 1KB），不读 chat_history。
 *
 * cwd 必须原样带回 summary 里的字符串。`session/load` 用它做百分号编码去对目录名；
 * 先 `path.resolve` 会把 `D://项目//WorkHub` 收成 `D:\项目\WorkHub`，编码对不上，加载就 FS_NOT_FOUND。
 * 展示层的 `normalizeDir` 会把这两种写法收成同一组，不在这里收。
 */
import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import type { DiskSessionRecord } from '../shared/types'

/** 与 acp/service.ts 的 resolveGrokHome 同一条规则。不引 service，避免把 electron 依赖带进来。 */
function resolveGrokHome(): string {
  return process.env.GROK_HOME || join(homedir(), '.grok')
}

/** 与 session-delete 的校验一致：目录名必须是会话 id，拒绝任何带分隔符的名字 */
const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/

const TITLE_MAX = 200
const CWD_MAX = 1024

/**
 * grok 的时间戳带纳秒（`...736624900Z`）。V8 对超过 3 位的小数秒不稳定，先截到毫秒。
 */
function parseTime(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0
  const normalized = value.replace(/(\.\d{3})\d+/, '$1')
  const t = Date.parse(normalized)
  return Number.isNaN(t) ? 0 : t
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text) return text.slice(0, TITLE_MAX)
  }
  return ''
}

/** 探针落在临时目录或 Windows 目录下，不是用户要在侧栏里看到的项目会话 */
function isNoiseCwd(cwd: string): boolean {
  let resolved: string
  try {
    resolved = resolve(cwd)
  } catch {
    return true
  }
  const lower = resolved.toLowerCase()
  const temp = resolve(tmpdir()).toLowerCase()
  if (lower === temp || lower.startsWith(temp + sep)) return true
  return /^[a-z]:\\windows(\\|$)/i.test(resolved)
}

function parseSummary(raw: string, dirName: string): DiskSessionRecord | null {
  let data: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    const rec = asRecord(parsed)
    if (!rec) return null
    data = rec
  } catch {
    return null
  }
  const info = asRecord(data.info)
  const id = typeof info?.id === 'string' ? info.id : ''
  const cwd = typeof info?.cwd === 'string' ? info.cwd.trim() : ''
  if (!id || id !== dirName || !SESSION_ID_RE.test(id)) return null
  if (!cwd || cwd.length > CWD_MAX || /[\0\r\n]/.test(cwd)) return null
  if (!/^[a-zA-Z]:[\\/]/.test(cwd) && !cwd.startsWith('/')) return null
  if (isNoiseCwd(cwd)) return null

  const chats = typeof data.num_chat_messages === 'number' ? data.num_chat_messages : null
  if (chats === 0) return null
  // 没有 grok 自动标题的不进侧栏。主目录里有一批只有两三条消息、
  // generated_title 为空的旧会话，扫进来会变成一排「未命名会话」。
  const title = firstText(data.generated_title, data.session_summary)
  if (!title) return null

  const createdAt = parseTime(data.created_at)
  const updatedAt = parseTime(data.last_active_at) || parseTime(data.updated_at) || createdAt
  return {
    id,
    cwd,
    title,
    createdAt: createdAt || updatedAt,
    updatedAt: updatedAt || createdAt
  }
}

/**
 * 列出磁盘上有对话内容的会话。同一 id 落在多个编码目录时留较新的一条。
 * 读失败的目录跳过，不让一次扫描把侧栏同步整个打断。
 */
export async function listDiskSessions(): Promise<DiskSessionRecord[]> {
  const root = join(resolveGrokHome(), 'sessions')
  let buckets: Dirent<string>[]
  try {
    buckets = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const found = new Map<string, DiskSessionRecord>()
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const bucketPath = join(root, bucket.name)
    let children: Dirent<string>[]
    try {
      children = await readdir(bucketPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory() || !SESSION_ID_RE.test(child.name)) continue
      let raw: string
      try {
        raw = await readFile(join(bucketPath, child.name, 'summary.json'), 'utf8')
      } catch {
        continue
      }
      const rec = parseSummary(raw, child.name)
      if (!rec) continue
      const prev = found.get(rec.id)
      if (!prev || rec.updatedAt >= prev.updatedAt) found.set(rec.id, rec)
    }
  }
  return [...found.values()]
}
