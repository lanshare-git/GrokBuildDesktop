import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'

import { resumeSession } from '../actions'
import { useT } from '../i18n'
import { useStore } from '../store'
import {
  groupSessionsByWorkspace,
  relativeTime,
  sessionDisplayTitle,
  sessionListOrderAt
} from '../utils'
import type { SessionMeta, SessionSearchHit } from '@shared/types'

/** 弹层贴在搜索框右侧，盖住主区域而不是侧栏里那一窄列 */
interface AnchorBox {
  top: number
  left: number
  width: number
  maxHeight: number
}

function measure(anchor: HTMLElement): AnchorBox {
  const rect = anchor.getBoundingClientRect()
  const margin = 12
  const spaceRight = window.innerWidth - rect.right - margin - 8
  // 右侧够宽就贴在搜索框右边，输入框留在侧栏里还能接着打
  if (spaceRight >= 320) {
    const top = Math.max(margin, Math.min(rect.top, window.innerHeight - 240))
    return {
      top,
      left: rect.right + 8,
      width: Math.min(560, spaceRight),
      maxHeight: Math.max(200, window.innerHeight - top - margin)
    }
  }
  // 窗口太窄时改到搜索框下面，避免弹层把正在输入的框盖住
  const width = Math.min(560, window.innerWidth - margin * 2)
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - margin - width))
  const top = Math.min(rect.bottom + 8, window.innerHeight - 200)
  return { top, left, width, maxHeight: Math.max(160, window.innerHeight - top - margin) }
}

/** 不走正则：关键词里的符号按字面量高亮 */
function highlightText(text: string, query: string): ReactNode {
  const needle = query.trim()
  if (!needle) return text
  const lower = text.toLowerCase()
  const n = needle.toLowerCase()
  const out: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < text.length) {
    const at = lower.indexOf(n, i)
    if (at < 0) {
      out.push(text.slice(i))
      break
    }
    if (at > i) out.push(text.slice(i, at))
    out.push(
      <mark key={k++} className="search-hit-mark">
        {text.slice(at, at + n.length)}
      </mark>
    )
    i = at + n.length
  }
  return out
}

/**
 * 会话搜索结果弹层。
 * 侧栏一行放不下「标题 + 工作目录 + 命中片段」，塞进去之后标题会被挤没、
 * 片段两行截断还看不到关键词。结果改到这里，侧栏列表保持原样。
 */
export default function SessionSearchPanel({
  query,
  anchorRef,
  onClose
}: {
  query: string
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
}): JSX.Element | null {
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)
  const homeDir = useStore((s) => s.homeDir)
  const locale = useStore((s) => s.locale)
  const activeId = useStore((s) => s.activeId)
  const running = useStore((s) => s.running)
  const unreadSessionIds = useStore((s) => s.unreadSessionIds)
  const permissions = useStore((s) => s.permissions)
  const questions = useStore((s) => s.questions)
  const t = useT()

  const [hits, setHits] = useState<SessionSearchHit[] | null>(null)
  /** 这批评分对应的查询词。和当前输入不一致时不展示，避免回车打开上一个词的结果 */
  const [hitsQuery, setHitsQuery] = useState('')
  /** 按项目过滤。null = 全部。换关键词后若该项目已经没有命中，展示时退回全部 */
  const [projectKey, setProjectKey] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [box, setBox] = useState<AnchorBox | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const keyboardMove = useRef(false)

  const q = query.trim()

  useLayoutEffect(() => {
    const place = (): void => {
      const anchor = anchorRef.current
      if (anchor) setBox(measure(anchor))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchorRef])

  useEffect(() => {
    if (!q) {
      setHits(null)
      setHitsQuery('')
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      void window.grok
        .sessionSearch(
          q,
          sessions
            .filter((s) => !s.isDraft)
            .slice(0, 120)
            .map((s) => ({ sessionId: s.id, cwd: s.cwd, title: sessionDisplayTitle(s, locale) }))
        )
        .then((res) => {
          if (!alive) return
          setHits(res)
          setHitsQuery(q)
        })
        .catch(() => {
          if (!alive) return
          setHits([])
          setHitsQuery(q)
        })
    }, 220)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [q, sessions, locale])

  const sessionById = useMemo(() => {
    const map = new Map<string, SessionMeta>()
    for (const session of sessions) map.set(session.id, session)
    return map
  }, [sessions])

  const groups = useMemo(
    () => groupSessionsByWorkspace(sessions, workspaces, homeDir, locale),
    [sessions, workspaces, homeDir, locale]
  )

  const projectBySession = useMemo(() => {
    const map = new Map<string, { key: string; label: string; path: string }>()
    for (const group of groups) {
      for (const session of group.sessions) {
        map.set(session.id, { key: group.key, label: group.label, path: group.path })
      }
    }
    return map
  }, [groups])

  const ready = hits !== null && hitsQuery === q
  const allRows = useMemo(() => {
    if (!ready || !hits) return []
    const list: Array<{ hit: SessionSearchHit; session: SessionMeta }> = []
    for (const hit of hits) {
      const session = sessionById.get(hit.sessionId)
      if (session) list.push({ hit, session })
    }
    return list
  }, [ready, hits, sessionById])

  /** 只列出这次结果里出现过的项目，顺序与侧栏一致 */
  const projects = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of allRows) {
      const project = projectBySession.get(row.session.id)
      if (!project) continue
      counts.set(project.key, (counts.get(project.key) ?? 0) + 1)
    }
    const list: Array<{ key: string; label: string; path: string; count: number }> = []
    for (const group of groups) {
      const count = counts.get(group.key)
      if (!count) continue
      list.push({ key: group.key, label: group.label, path: group.path, count })
    }
    return list
  }, [allRows, groups, projectBySession])

  const activeProject = projectKey && projects.some((p) => p.key === projectKey) ? projectKey : null
  const rows = activeProject
    ? allRows.filter((row) => projectBySession.get(row.session.id)?.key === activeProject)
    : allRows

  useEffect(() => {
    setActive(0)
  }, [hitsQuery, hits, activeProject])

  const safeActive = rows.length === 0 ? 0 : Math.min(active, rows.length - 1)

  useEffect(() => {
    if (!keyboardMove.current) return
    keyboardMove.current = false
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [safeActive, rows.length])

  const openSession = (session: SessionMeta): void => {
    onClose()
    if (session.id === activeId) return
    if (session.isDraft) useStore.getState().selectSession(session.id)
    else void resumeSession(session.id, session.cwd)
  }

  const keyState = useRef({ ready, rows, active, openSession, onClose })
  keyState.current = { ready, rows, active, openSession, onClose }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 输入法选词的回车不是「打开这条」
      if (e.isComposing || e.keyCode === 229) return
      const target = e.target as Node | null
      const inUi =
        !!target &&
        (anchorRef.current?.contains(target) || panelRef.current?.contains(target))
      if (!inUi) return
      const state = keyState.current
      if (e.key === 'Escape') {
        e.preventDefault()
        state.onClose()
        return
      }
      if (!state.ready || state.rows.length === 0) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        keyboardMove.current = true
        const count = state.rows.length
        setActive((i) => {
          const current = Math.min(i, count - 1)
          if (e.key === 'ArrowDown') return (current + 1) % count
          return (current - 1 + count) % count
        })
        return
      }
      if (e.key === 'Enter') {
        // 焦点在结果或项目筛选上时，交给按钮自己的 click，避免打开两次
        if ((e.target as HTMLElement | null)?.closest?.('.search-result, .search-project')) return
        e.preventDefault()
        const row = state.rows[Math.min(state.active, state.rows.length - 1)]
        if (row) state.openSession(row.session)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [anchorRef])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null
      if (!target) return
      if (anchorRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [anchorRef, onClose])

  if (!box) return null

  const statusOf = (id: string): string =>
    permissions.some((p) => p.sessionId === id) || questions.some((item) => item.sessionId === id)
      ? 'pending'
      : running.includes(id)
        ? 'running'
        : unreadSessionIds.includes(id)
          ? 'unread'
          : 'done'

  return (
    <div
      ref={panelRef}
      className="search-panel"
      role="dialog"
      aria-label={t('sidebar.searchPlaceholder')}
      style={{ top: box.top, left: box.left, width: box.width, maxHeight: box.maxHeight }}
    >
      {!ready && <div className="search-empty">{t('sidebar.searching')}</div>}
      {ready && allRows.length === 0 && (
        <div className="search-empty">{t('sidebar.searchHits', { n: 0 })}</div>
      )}
      {ready && allRows.length > 0 && (
        <>
          <div className="search-panel-meta">
            {activeProject
              ? t('sidebar.searchHitsFiltered', { n: rows.length, total: allRows.length })
              : t('sidebar.searchHits', { n: allRows.length })}
          </div>
          {projects.length > 1 && (
            <div className="search-projects" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={!activeProject}
                className={`search-project${!activeProject ? ' is-on' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setProjectKey(null)}
              >
                <span className="search-project-name">{t('sidebar.searchAllProjects')}</span>
                <span className="search-project-count">{allRows.length}</span>
              </button>
              {projects.map((project) => (
                <button
                  key={project.key}
                  type="button"
                  role="tab"
                  aria-selected={activeProject === project.key}
                  className={`search-project${activeProject === project.key ? ' is-on' : ''}`}
                  title={project.path}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    setProjectKey((current) => (current === project.key ? null : project.key))
                  }
                >
                  <span className="search-project-name">{project.label}</span>
                  <span className="search-project-count">{project.count}</span>
                </button>
              ))}
            </div>
          )}
          <div className="search-results" ref={listRef} role="listbox">
            {rows.map(({ hit, session }, index) => {
              const title = sessionDisplayTitle(session, locale)
              const selected = index === safeActive
              return (
                <button
                  key={session.id}
                  type="button"
                  id={`session-search-${session.id}`}
                  role="option"
                  aria-selected={selected}
                  data-active={selected ? 'true' : 'false'}
                  className={`search-result${selected ? ' is-active' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => openSession(session)}
                >
                  <div className="search-result-top">
                    <span className={`session-dot status-${statusOf(session.id)}`} />
                    <span className="search-result-title" title={title}>
                      {highlightText(title, q)}
                    </span>
                  </div>
                  <div className="search-result-meta">
                    <span className="search-result-ws" title={session.cwd}>
                      {projectBySession.get(session.id)?.label ?? session.cwd}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{relativeTime(sessionListOrderAt(session), locale)}</span>
                    {hit.where === 'title' && (
                      <span className="search-where">{t('sidebar.searchWhereTitle')}</span>
                    )}
                  </div>
                  {hit.where === 'content' && hit.snippet && (
                    <div className="search-result-snippet">{highlightText(hit.snippet, q)}</div>
                  )}
                </button>
              )
            })}
          </div>
          <div className="search-panel-keys">{t('sidebar.searchKeys')}</div>
        </>
      )}
    </div>
  )
}
