/**
 * 截图提问：冻住当前桌面，拖拽框选，双击后把图片直接交回输入框。
 *
 * 不走系统截图工具，也不再要求 Ctrl+V。宿主窗口先藏起来，避免最大化的
 * 客户端挡住要截的内容；选区坐标是叠层窗口里的 CSS 像素（与 display.bounds
 * 的 DIP 一致），裁切时再按缩略图真实像素 / DIP 尺寸换算。
 */

import { join } from 'node:path'
import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  screen,
  type DesktopCapturerSource,
  type Display,
  type NativeImage
} from 'electron'

import { CH } from '../shared/channels'
import { t } from './i18n'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

interface Shot {
  displayId: number
  image: NativeImage
  dipWidth: number
  dipHeight: number
}

interface Selection {
  displayId: number
  x: number
  y: number
  width: number
  height: number
}

let snipBusy = false

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function snipPreloadPath(): string {
  return join(__dirname, '../preload/snip.js')
}

function pairDisplays(
  displays: Display[],
  sources: DesktopCapturerSource[]
): Array<{ display: Display; source: DesktopCapturerSource }> {
  const used = new Set<string>()
  const pairs: Array<{ display: Display; source: DesktopCapturerSource }> = []
  for (const display of displays) {
    const id = String(display.id)
    const source = sources.find((s) => {
      if (used.has(s.id)) return false
      return s.display_id === id || s.id === `screen:${id}:0` || s.id.startsWith(`screen:${id}:`)
    })
    if (!source || source.thumbnail.isEmpty()) continue
    used.add(source.id)
    pairs.push({ display, source })
  }
  if (pairs.length > 0) return pairs
  const n = Math.min(displays.length, sources.length)
  for (let i = 0; i < n; i++) {
    if (sources[i].thumbnail.isEmpty()) continue
    pairs.push({ display: displays[i], source: sources[i] })
  }
  return pairs
}

async function grabDisplays(): Promise<Shot[]> {
  const displays = screen.getAllDisplays()
  if (displays.length === 0) return []
  const maxW = Math.max(...displays.map((d) => Math.max(1, Math.round(d.size.width * d.scaleFactor))))
  const maxH = Math.max(...displays.map((d) => Math.max(1, Math.round(d.size.height * d.scaleFactor))))
  let sources: DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxW, height: maxH },
      fetchWindowIcons: false
    })
  } catch (err) {
    console.error('[snip] full-res capture failed, retrying smaller', err)
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.min(maxW, 1920), height: Math.min(maxH, 1080) },
      fetchWindowIcons: false
    })
  }
  return pairDisplays(displays, sources).map(({ display, source }) => ({
    displayId: display.id,
    image: source.thumbnail,
    dipWidth: display.bounds.width,
    dipHeight: display.bounds.height
  }))
}

function buildHtml(hint: string, doneHint: string): string {
  const hintJson = JSON.stringify(hint)
  const doneJson = JSON.stringify(doneHint)
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #000; cursor: crosshair; user-select: none; }
  #shot { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: fill; pointer-events: none; }
  #dim { position: fixed; inset: 0; background: rgba(0,0,0,.32); pointer-events: none; }
  #hole { display: none; position: fixed; box-sizing: border-box; border: 1.5px solid #fff; box-shadow: 0 0 0 100vmax rgba(0,0,0,.46); pointer-events: none; }
  #label, #hint {
    position: fixed; color: #fff; background: rgba(20,20,20,.78);
    font: 12px/1.4 "Segoe UI", "Microsoft YaHei", sans-serif;
    pointer-events: none; border-radius: 6px;
  }
  #hint { top: 18px; left: 50%; transform: translateX(-50%); padding: 6px 14px; font-size: 13px; }
  #label { display: none; padding: 2px 6px; }
</style>
</head>
<body>
<img id="shot" alt="" />
<div id="dim"></div>
<div id="hole"></div>
<div id="label"></div>
<div id="hint"></div>
<script>
var hint = ${hintJson};
var doneHint = ${doneJson};
document.getElementById('hint').textContent = hint;
var drag = null;
var sel = null;
var dragging = false;
function norm(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}
function inside(r, x, y) {
  return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}
function near(r, x, y) {
  var pad = 28;
  return x >= r.x - pad && y >= r.y - pad && x <= r.x + r.w + pad && y <= r.y + r.h + pad;
}
function paint() {
  var hole = document.getElementById('hole');
  var label = document.getElementById('label');
  var dim = document.getElementById('dim');
  var ok = sel && sel.w >= 4 && sel.h >= 4;
  if (!ok) {
    hole.style.display = 'none';
    label.style.display = 'none';
    dim.style.display = 'block';
    return;
  }
  dim.style.display = 'none';
  hole.style.display = 'block';
  hole.style.left = sel.x + 'px';
  hole.style.top = sel.y + 'px';
  hole.style.width = sel.w + 'px';
  hole.style.height = sel.h + 'px';
  label.style.display = 'block';
  label.textContent = Math.round(sel.w) + ' × ' + Math.round(sel.h) + (dragging ? '' : '  ·  ' + doneHint);
  label.style.left = Math.max(0, sel.x + 4) + 'px';
  label.style.top = Math.max(0, sel.y + 4) + 'px';
}
window.addEventListener('pointerdown', function (e) {
  if (e.button !== 0) return;
  if (sel && sel.w >= 4 && sel.h >= 4 && inside(sel, e.clientX, e.clientY)) return;
  drag = { x: e.clientX, y: e.clientY };
  dragging = true;
  sel = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
  try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
  paint();
});
window.addEventListener('pointermove', function (e) {
  if (!drag) return;
  sel = norm(drag.x, drag.y, e.clientX, e.clientY);
  paint();
});
window.addEventListener('pointerup', function () {
  drag = null;
  dragging = false;
  paint();
});
window.addEventListener('dblclick', function (e) {
  if (e.button !== 0) return;
  if (!sel || sel.w < 4 || sel.h < 4 || !near(sel, e.clientX, e.clientY)) return;
  if (window.grokSnip) window.grokSnip.confirm({ x: sel.x, y: sel.y, width: sel.w, height: sel.h });
});
window.addEventListener('contextmenu', function (e) {
  e.preventDefault();
  if (window.grokSnip) window.grokSnip.cancel();
});
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && window.grokSnip) window.grokSnip.cancel();
});
if (window.grokSnip) {
  var shot = document.getElementById('shot');
  shot.onload = shot.onerror = function () { window.grokSnip.painted(); };
  window.grokSnip.onImage(function (dataUrl) { shot.src = dataUrl; });
}
</script>
</body>
</html>`
}

function clearSnipIpc(): void {
  ipcMain.removeHandler(CH.snipConfirm)
  ipcMain.removeHandler(CH.snipCancel)
  ipcMain.removeAllListeners(CH.snipPainted)
}

async function presentOverlay(shots: Shot[]): Promise<Selection | null> {
  const windows: BrowserWindow[] = []
  const displayByWebContents = new Map<number, number>()
  let settled = false
  let resolveSel: (value: Selection | null) => void = () => {}
  const selection = new Promise<Selection | null>((resolve) => {
    resolveSel = resolve
  })

  const finish = (value: Selection | null): void => {
    if (settled) return
    settled = true
    resolveSel(value)
  }

  clearSnipIpc()
  ipcMain.handle(
    CH.snipConfirm,
    (event, rect: { x?: number; y?: number; width?: number; height?: number }) => {
      const displayId = displayByWebContents.get(event.sender.id)
      if (displayId == null || settled) return null
      const shot = shots.find((s) => s.displayId === displayId)
      if (!shot) return null
      const x = Math.max(0, Math.min(shot.dipWidth - 1, Number(rect?.x) || 0))
      const y = Math.max(0, Math.min(shot.dipHeight - 1, Number(rect?.y) || 0))
      const width = Math.min(Math.max(0, Number(rect?.width) || 0), shot.dipWidth - x)
      const height = Math.min(Math.max(0, Number(rect?.height) || 0), shot.dipHeight - y)
      if (width < 4 || height < 4) return null
      finish({ displayId, x, y, width, height })
      return null
    }
  )
  ipcMain.handle(CH.snipCancel, () => {
    finish(null)
    return null
  })

  let paintedLeft = shots.length
  let paintTimer: ReturnType<typeof setTimeout> | null = null
  const painted = new Promise<void>((resolve) => {
    const done = (): void => {
      if (paintTimer !== null) clearTimeout(paintTimer)
      paintTimer = null
      ipcMain.removeAllListeners(CH.snipPainted)
      resolve()
    }
    paintTimer = setTimeout(done, 3000)
    ipcMain.on(CH.snipPainted, () => {
      paintedLeft -= 1
      if (paintedLeft <= 0) done()
    })
  })

  try {
    const html = buildHtml(t('composer.snipHint'), t('composer.snipDone'))
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    for (const shot of shots) {
      const display = screen.getAllDisplays().find((d) => d.id === shot.displayId)
      if (!display) {
        paintedLeft -= 1
        continue
      }
      const win = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        show: false,
        frame: false,
        thickFrame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        focusable: true,
        hasShadow: false,
        backgroundColor: '#000000',
        webPreferences: {
          preload: snipPreloadPath(),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false
        }
      })
      windows.push(win)
      displayByWebContents.set(win.webContents.id, shot.displayId)
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      win.setMenuBarVisibility(false)
      win.on('closed', () => finish(null))
      win.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
          event.preventDefault()
          finish(null)
        }
      })
      await win.loadURL(url)
      win.setBounds(display.bounds)
      win.webContents.send(CH.snipImage, shot.image.toDataURL())
    }
    if (windows.length === 0) return null
    await painted
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.show()
        win.setBounds(screen.getAllDisplays().find((d) => d.id === displayByWebContents.get(win.webContents.id))?.bounds ?? win.getBounds())
      }
    }
    const cursor = screen.getCursorScreenPoint()
    const cursorDisplay = screen.getDisplayNearestPoint(cursor)
    const focused = windows.find(
      (w) => !w.isDestroyed() && displayByWebContents.get(w.webContents.id) === cursorDisplay.id
    )
    ;(focused ?? windows.find((w) => !w.isDestroyed()))?.focus()
    return await selection
  } finally {
    if (paintTimer !== null) clearTimeout(paintTimer)
    clearSnipIpc()
    for (const win of windows) {
      if (!win.isDestroyed()) win.destroy()
    }
  }
}

function cropShot(shot: Shot, sel: Selection): { data: string; mimeType: string } | null {
  const size = shot.image.getSize()
  if (size.width < 2 || size.height < 2 || shot.dipWidth < 1 || shot.dipHeight < 1) return null
  const scaleX = size.width / shot.dipWidth
  const scaleY = size.height / shot.dipHeight
  const x = Math.max(0, Math.min(size.width - 1, Math.round(sel.x * scaleX)))
  const y = Math.max(0, Math.min(size.height - 1, Math.round(sel.y * scaleY)))
  const width = Math.max(1, Math.min(size.width - x, Math.round(sel.width * scaleX)))
  const height = Math.max(1, Math.min(size.height - y, Math.round(sel.height * scaleY)))
  let image = shot.image.crop({ x, y, width, height })
  let mimeType = 'image/png'
  let buf = image.toPNG()
  if (buf.length >= MAX_IMAGE_BYTES) {
    mimeType = 'image/jpeg'
    buf = image.toJPEG(80)
  }
  // 输入框上限 10MB。超大选区改 JPEG 再逐级缩小，避免截完却被静默丢掉。
  while (buf.length >= MAX_IMAGE_BYTES) {
    const current = image.getSize()
    if (current.width <= 800) break
    image = image.resize({ width: Math.round(current.width * 0.75), quality: 'good' })
    buf = image.toJPEG(75)
    mimeType = 'image/jpeg'
  }
  return { data: buf.toString('base64'), mimeType }
}

/** 取消返回 null。截屏本身失败时抛错，调用方负责把窗口还原。 */
export async function captureScreenshotSnip(
  host: BrowserWindow | null
): Promise<{ data: string; mimeType: string } | null> {
  if (snipBusy) return null
  snipBusy = true
  const wasVisible = !!host && !host.isDestroyed() && host.isVisible()
  try {
    if (wasVisible && host) host.hide()
    // 等合成器把窗口从桌面上拿掉，否则缩略图里还是自己
    await delay(150)
    const shots = await grabDisplays()
    if (shots.length === 0) throw new Error(t('composer.snipFailed'))
    const sel = await presentOverlay(shots)
    if (!sel) return null
    const shot = shots.find((s) => s.displayId === sel.displayId)
    if (!shot) return null
    const cropped = cropShot(shot, sel)
    if (!cropped) throw new Error(t('composer.snipFailed'))
    return cropped
  } finally {
    clearSnipIpc()
    snipBusy = false
    if (wasVisible && host && !host.isDestroyed()) {
      host.show()
      host.focus()
    }
  }
}
