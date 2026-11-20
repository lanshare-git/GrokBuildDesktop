/**
 * 截图叠层专用 preload：只收冻屏图、回传选区或取消。
 */

import { contextBridge, ipcRenderer } from 'electron'

import { CH } from '../shared/channels'

contextBridge.exposeInMainWorld('grokSnip', {
  onImage: (cb: (dataUrl: string) => void): void => {
    ipcRenderer.on(CH.snipImage, (_event, dataUrl: string) => {
      if (typeof dataUrl === 'string') cb(dataUrl)
    })
  },
  painted: (): void => {
    ipcRenderer.send(CH.snipPainted)
  },
  confirm: (rect: { x: number; y: number; width: number; height: number }): Promise<null> =>
    ipcRenderer.invoke(CH.snipConfirm, rect),
  cancel: (): Promise<null> => ipcRenderer.invoke(CH.snipCancel)
})
