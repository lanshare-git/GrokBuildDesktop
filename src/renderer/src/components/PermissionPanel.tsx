import { useT, type MessageKey } from '../i18n'
import { useStore } from '../store'
import { stringifyPretty } from '../utils'
import {
  isDenyPermissionOption,
  localizePermissionOption
} from '@shared/permission-labels'
import type { PermissionRequestEvent } from '@shared/types'

/** 短标题直接用；更长的脚本改走下方预览，避免标题把卡片撑高 */
const TITLE_LIMIT = 72
/** 这些键不是要给人看的命令正文 */
const META_KEYS = new Set(['variant', 'kind', 'type', 'command', 'cmd'])

function textField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 授权卡只展示将要执行的内容。
 * 命令类参数去掉 `{ variant, command }` 这层 JSON，标题不再把整段脚本再写一遍。
 */
function permissionDetail(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return stringifyPretty(raw, 1200)
  const obj = raw as Record<string, unknown>
  const command = textField(obj, 'command') || textField(obj, 'cmd')
  if (!command) return stringifyPretty(raw, 1200)

  const extras = Object.keys(obj)
    .filter((key) => !META_KEYS.has(key))
    .map((key) => {
      const value = obj[key]
      if (typeof value === 'string' && value.trim()) return `${key}: ${value.trim()}`
      if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${String(value)}`
      return ''
    })
    .filter(Boolean)

  return extras.length > 0 ? `${command}\n${extras.join('\n')}` : command
}

function permissionLabel(
  title: string | undefined,
  toolName: string | undefined,
  raw: unknown,
  fallback: string
): string {
  const trimmed = title?.trim() ?? ''
  if (trimmed && !trimmed.includes('\n') && trimmed.length <= TITLE_LIMIT) return trimmed

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const variant = textField(raw as Record<string, unknown>, 'variant')
    if (variant) return variant
  }
  const name = toolName?.trim()
  if (name) return name
  if (!trimmed) return fallback
  const first = trimmed.split('\n')[0]
  return first.length > TITLE_LIMIT ? `${first.slice(0, TITLE_LIMIT)}…` : first
}

/**
 * 工具执行授权面板。
 *
 * **内联**渲染在「请求归属的那个任务」的输入框上方，而不是全局模态框——
 * 后台任务请求授权时不会再盖住用户当前正在看的任务。调用方（TaskPrompts）
 * 负责只把当前任务的请求传进来。
 */
export default function PermissionPanel({
  request
}: {
  request: PermissionRequestEvent
}): JSX.Element {
  const t = useT()
  const raw = request.toolCall?.rawInput
  const label = permissionLabel(
    request.toolCall?.title,
    request.toolCall?.toolName,
    raw,
    t('prompts.perm.fallbackTool')
  )
  const detail = permissionDetail(raw)
  const toolName = request.toolCall?.toolName?.trim()
  const showToolName = Boolean(toolName && toolName !== label)
  const showDetail = Boolean(detail && detail !== label)

  const decide = (optionId: string | null): void => {
    void window.grok.respondPermission(request.requestId, optionId)
    // 立即从界面撤下：等 agent 回复再撤会让这张卡在屏幕上挂一拍
    useStore.getState().clearPermission(request.requestId)
  }

  return (
    <div className="prompt-card prompt-card-perm">
      <div className="prompt-head">
        <span className="prompt-badge">{t('prompts.perm.badge')}</span>
        <span className="prompt-title">{t('prompts.perm.title')}</span>
      </div>
      <div className="prompt-sub">
        <span className="prompt-sub-lead">{t('prompts.perm.wantPre')}</span>
        <strong>{label}</strong>
        {t('prompts.perm.wantPost')}
        {showToolName && <code className="inline-code">{toolName}</code>}
      </div>

      {showDetail && <pre className="prompt-pre">{detail}</pre>}

      <div className="prompt-actions">
        {request.options.map((opt) => {
          const isDeny = isDenyPermissionOption(opt)
          return (
            <button
              key={opt.optionId}
              className={`btn ${isDeny ? 'btn-ghost' : 'btn-primary'}`}
              title={opt.name ?? opt.optionId}
              onClick={() => decide(opt.optionId)}
            >
              {localizePermissionOption(opt, (k) => t(k as MessageKey))}
            </button>
          )
        })}
        {/* agent 已带拒绝选项时不再叠一个裸「拒绝」（否则会变成三个拒绝） */}
        {!request.options.some((o) => isDenyPermissionOption(o)) && (
          <button className="btn btn-ghost" onClick={() => decide(null)}>
            {t('prompts.perm.reject')}
          </button>
        )}
      </div>
    </div>
  )
}
