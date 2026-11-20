/**
 * 窗口失焦 / 最小化 / 藏进托盘 / 非当前会话时提醒用户：有待授权或提问。
 *
 * - 授权：屏幕右下角置顶浮窗（可直接点允许/拒绝）
 * - 提问：系统通知 + 任务栏闪烁（点击唤起主窗口）
 *
 * 主窗口前台且正在看该会话时：内联授权 / 提问面板已够用，不弹浮窗。
 * 用户已经在该会话里看过内联面板后，不再为这条请求弹右下角提醒：
 * 切到别的会话、切到其它应用、最小化、藏进托盘都不弹。人已经知道有交互。
 * 还没在主窗口看过的（例如发生在别的会话、或窗口已经在后台才到来），仍会弹。
 */

import { BrowserWindow, Notification } from 'electron'
import { CH } from '../shared/channels'
import type { DesktopPermToastMode } from '../shared/types'
import { readConfig } from './config'
import {
  closeAllDesktopPermToasts,
  closeDesktopPermToast,
  listOpenPermToastRequestIdsForSession,
  showDesktopPermToast,
  type DesktopToastOption
} from './desktop-toast'

export type AttentionKind = 'perm' | 'question'

export interface AwaitingUserNotice {
  kind: AttentionKind
  requestId: number
  sessionId: string
  title: string
  body: string
  /** 仅 kind=perm：浮窗按钮用 */
  toolLabel?: string
  options?: DesktopToastOption[]
}

let win: BrowserWindow | null = null
/** 渲染层当前正在看的会话；用于判断内联面板是否已可见 */
let activeSessionId: string | null = null
/** 桌面授权浮窗模式（设置里改；首次用时从 config 读，避免模块加载早于 app ready） */
let desktopPermToastMode: DesktopPermToastMode | null = null

function toastMode(): DesktopPermToastMode {
  if (!desktopPermToastMode) desktopPermToastMode = readConfig().desktopPermToast ?? 'on'
  return desktopPermToastMode
}
/** 同一 requestId 只弹一次（dismiss 后也算，避免立刻再弹） */
const seen = new Set<string>()
/**
 * 用户已在主窗口对应会话里见过内联交互（授权面板或提问）的请求。
 * 见过即不再弹右下角提醒，包括切会话、切到其它应用、最小化和藏进托盘。
 */
const seenInline = new Set<string>()
/** 暂不展示的提醒：前台正在看该会话，或提问时窗口仍在前台 */
const deferred = new Map<string, AwaitingUserNotice>()
/** 尚未响应的授权原文，关浮窗后还能再放回 deferred */
const permNotices = new Map<number, AwaitingUserNotice>()
let flashing = false

/** 设置里切换桌面授权浮窗模式；关掉时立刻收起已弹出的浮窗 */
export function setDesktopPermToastMode(mode: DesktopPermToastMode): void {
  desktopPermToastMode = mode
  if (mode === 'off') closeAllDesktopPermToasts()
  else flushDeferred()
}

export function getDesktopPermToastMode(): DesktopPermToastMode {
  return toastMode()
}

function noticeKey(kind: AttentionKind, requestId: number): string {
  return `${kind}:${requestId}`
}

export function showMainWindow(sessionId?: string): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  if (sessionId) {
    win.webContents.send(CH.pushFocusSession, { sessionId })
  }
}

function stopFlash(): void {
  if (!flashing || !win || win.isDestroyed()) {
    flashing = false
    return
  }
  win.flashFrame(false)
  flashing = false
}

function startFlash(): void {
  if (!win || win.isDestroyed()) return
  if (win.isFocused() && win.isVisible() && !win.isMinimized()) return
  win.flashFrame(true)
  flashing = true
}

function windowInBackground(): boolean {
  if (!win || win.isDestroyed()) return true
  if (win.isMinimized()) return true
  return !win.isFocused() || !win.isVisible()
}

/**
 * 授权浮窗要不要出（再叠加设置开关）：
 * - off：永不
 * - on：后台，或前台但正在看别的会话（且还没在该会话看过内联）
 */
function shouldShowDesktopPerm(sessionId: string): boolean {
  if (toastMode() === 'off') return false
  if (windowInBackground()) return true
  return !activeSessionId || activeSessionId !== sessionId
}

function showAttention(notice: AwaitingUserNotice): void {
  const key = noticeKey(notice.kind, notice.requestId)
  if (seen.has(key)) return
  seen.add(key)
  deferred.delete(key)

  startFlash()

  if (notice.kind === 'perm' && notice.options) {
    showDesktopPermToast({
      requestId: notice.requestId,
      sessionId: notice.sessionId,
      toolLabel: notice.toolLabel ?? notice.body,
      options: notice.options
    })
    return
  }

  if (!Notification.isSupported()) return

  const n = new Notification({
    title: notice.title,
    body: notice.body,
    silent: false
  })
  n.on('click', () => {
    showMainWindow(notice.sessionId)
  })
  n.show()
}

/** 把该弹却还没弹的提醒发出来 */
function flushDeferred(): void {
  if (deferred.size === 0) return
  for (const notice of [...deferred.values()]) {
    const key = noticeKey(notice.kind, notice.requestId)
    if (seen.has(key)) {
      deferred.delete(key)
      continue
    }
    if (notice.kind === 'perm') {
      // 已在主窗口看过内联面板：切会话、切应用、最小化、藏托盘都不再弹
      if (seenInline.has(key)) continue
      if (!shouldShowDesktopPerm(notice.sessionId)) continue
      showAttention(notice)
      continue
    }
    // 提问同理：主窗口上已经看过的，离开窗口不再发系统通知
    if (seenInline.has(key)) continue
    if (!windowInBackground()) continue
    showAttention(notice)
  }
}

/**
 * 主窗口前台且正在看某会话 → 关掉该会话桌面浮窗，记为「已看过内联」。
 * 之后离开窗口（切会话、切应用、最小化、藏托盘）都不再为它弹提醒。
 */
function parkPermToastsForActiveSession(): void {
  if (!activeSessionId || windowInBackground()) return
  const ids = listOpenPermToastRequestIdsForSession(activeSessionId)
  for (const requestId of ids) {
    const key = noticeKey('perm', requestId)
    seenInline.add(key)
    seen.delete(key)
    closeDesktopPermToast(requestId)
    const notice = permNotices.get(requestId)
    if (notice) deferred.set(key, notice)
  }
}

/** 渲染层切换当前会话时调用 */
export function setActiveSessionId(sessionId: string | null): void {
  activeSessionId = sessionId
  // 切到有待授权 / 待回答的会话：内联面板会出来，记为已看过
  if (sessionId && !windowInBackground()) {
    for (const [key, notice] of deferred) {
      if (notice.sessionId === sessionId) seenInline.add(key)
    }
    for (const [requestId, notice] of permNotices) {
      if (notice.sessionId === sessionId) {
        seenInline.add(noticeKey('perm', requestId))
      }
    }
  }
  parkPermToastsForActiveSession()
  flushDeferred()
}

/** 绑定主窗口 */
export function bindAttention(mainWindow: BrowserWindow): void {
  win = mainWindow
  mainWindow.on('focus', () => {
    stopFlash()
    parkPermToastsForActiveSession()
  })
  mainWindow.on('blur', () => flushDeferred())
  mainWindow.on('minimize', () => flushDeferred())
  mainWindow.on('hide', () => flushDeferred())
  mainWindow.on('closed', () => {
    win = null
    activeSessionId = null
    flashing = false
    seen.clear()
    seenInline.clear()
    deferred.clear()
    permNotices.clear()
    closeAllDesktopPermToasts()
  })
}

export function notifyAwaitingUser(notice: AwaitingUserNotice): void {
  const key = noticeKey(notice.kind, notice.requestId)
  if (seen.has(key)) return

  if (notice.kind === 'perm') {
    permNotices.set(notice.requestId, notice)
    if (!shouldShowDesktopPerm(notice.sessionId)) {
      // 正在看该会话：内联面板已够用。只有这时才算「看过」——
      // 浮窗总开关关掉时不应误记，否则重新打开后切到其它应用也不会再提醒。
      deferred.set(key, notice)
      if (!windowInBackground() && activeSessionId === notice.sessionId) seenInline.add(key)
      return
    }
    showAttention(notice)
    return
  }

  if (!windowInBackground()) {
    deferred.set(key, notice)
    // 正在看这条提问所在的会话：内联面板已出现，切到其它应用不再通知
    if (activeSessionId === notice.sessionId) seenInline.add(key)
    return
  }

  showAttention(notice)
}

/** 用户点浮窗 ×：只关窗，不替用户做授权决定；记入 seen 避免立刻再弹 */
export function dismissPermToast(requestId: number): void {
  const key = noticeKey('perm', requestId)
  seen.add(key)
  deferred.delete(key)
  closeDesktopPermToast(requestId)
}

export function clearAttention(kind: AttentionKind, requestId: number): void {
  const key = noticeKey(kind, requestId)
  seen.delete(key)
  seenInline.delete(key)
  deferred.delete(key)
  if (kind === 'perm') {
    permNotices.delete(requestId)
    closeDesktopPermToast(requestId)
  }
}

export function clearAllAttention(): void {
  seen.clear()
  seenInline.clear()
  deferred.clear()
  permNotices.clear()
  closeAllDesktopPermToasts()
  stopFlash()
}
