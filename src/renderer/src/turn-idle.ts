/**
 * 手动打断当前回合。
 *
 * 对齐 Codex 桌面端：静默不再自动 `session/cancel`。Agent 停更时界面保持
 * 「正在工作」，直到用户点 ■，或 agent 自己送来 turn_completed。
 * 主进程对单条 prompt 的超时仍是 60 分钟。
 */

import { useStore } from './store'

/**
 * 打断指定会话的当前回合（不要求是 active）。
 * 与 Composer 点 ■ 同语义：发 cancel + 清待响应面板 + 延迟扫卡死工具。
 */
export function cancelSessionTurn(sessionId: string): void {
  const store = useStore.getState()
  const session = store.sessions.find((x) => x.id === sessionId)
  if (!session) return

  const pendingToolCallIds: string[] = []
  for (const it of session.items) {
    if (it.kind === 'tool' && (it.status === 'in_progress' || it.status === 'pending')) {
      pendingToolCallIds.push(it.toolCallId)
    }
  }

  void window.grok.cancel(sessionId)
  // 只清「本会话」相关的待响应；clearAllPrompts 会误伤其它会话的弹窗
  for (const p of store.permissions) {
    if (p.sessionId === sessionId) store.clearPermission(p.requestId)
  }
  for (const q of store.questions) {
    if (q.sessionId === sessionId) store.clearQuestion(q.requestId)
  }

  if (pendingToolCallIds.length === 0) return
  window.setTimeout(() => {
    useStore.getState().markStuckTools(sessionId, undefined, pendingToolCallIds)
  }, 15_000)
}
