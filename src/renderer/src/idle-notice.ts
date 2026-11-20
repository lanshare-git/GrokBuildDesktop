/**
 * 空闲自动结束提示（「超过 5 分钟无新输出，已自动结束本轮」）。
 *
 * 它只在「后面真的没有再产出」时成立。Agent 经常在客户端 cancel 之后继续吐
 * 思考和工具；若把这句留在那些内容前面，读起来像回合已经结束，记录却还在长。
 */

import type { ChatItem } from '@shared/types'
import { chat as enChat } from '@shared/i18n/dict/en/chat'
import { chat as jaChat } from '@shared/i18n/dict/ja/chat'
import { chat as zhChat } from '@shared/i18n/dict/zh-cn/chat'

/** 改版前写入、没有 code 的旧提示，靠文案识别 */
const IDLE_CANCEL_TEXT = new Set<string>([
  zhChat.turnIdleCancelled,
  enChat.turnIdleCancelled,
  jaChat.turnIdleCancelled
])

export function isIdleCancelNotice(item: ChatItem): boolean {
  return (
    item.kind === 'notice' &&
    (item.code === 'turn-idle-cancelled' || IDLE_CANCEL_TEXT.has(item.text))
  )
}

/**
 * 去掉「后面还有别的内容」的空闲结束提示。
 * 提示本身仍是最后一条时保留（这轮确实停了）。没有可撤的则返回原数组。
 */
export function withoutSupersededIdleNotices(items: ChatItem[]): ChatItem[] {
  let lastReal = -1
  for (let i = items.length - 1; i >= 0; i--) {
    if (!isIdleCancelNotice(items[i])) {
      lastReal = i
      break
    }
  }
  if (lastReal < 0) return items

  let superseded = false
  for (let i = 0; i < lastReal; i++) {
    if (isIdleCancelNotice(items[i])) {
      superseded = true
      break
    }
  }
  if (!superseded) return items

  return items.filter((it, i) => i > lastReal || !isIdleCancelNotice(it))
}
