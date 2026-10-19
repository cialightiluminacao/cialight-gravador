import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { useAppStore } from '@/app/store'
import { useSettingsPatch, type SettingsPatch } from './useSettingsPatch'
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
function patcher(): SettingsPatch { let patch!: SettingsPatch; function Capture() { patch = useSettingsPatch().patch; return null }; renderToStaticMarkup(createElement(Capture)); return patch }
beforeEach(()=>useAppStore.getState().setSettings(structuredClone(DEFAULT_SETTINGS)))
afterEach(()=>vi.unstubAllGlobals())
it('an earlier failed save cannot undo a later accepted change to another field',async()=>{
  let rejectFirst!: (e:Error)=>void
  const set=vi.fn().mockImplementationOnce(()=>new Promise((_,reject)=>{rejectFirst=reject})).mockResolvedValue(undefined)
  vi.stubGlobal('window',{api:{settings:{set}}})
  const patch=patcher(),first=patch({quality:'720p'}),latest=patch({fps:60})
  await Promise.resolve();rejectFirst(new Error('disk unavailable'))
  expect(await first).toBe(false);expect(await latest).toBe(true)
  expect(useAppStore.getState().settings.quality).toBe(DEFAULT_SETTINGS.quality)
  expect(useAppStore.getState().settings.fps).toBe(60)
})
it('an earlier failed save cannot undo a later accepted value of the same field',async()=>{
  let rejectFirst!: (e:Error)=>void
  const set=vi.fn().mockImplementationOnce(()=>new Promise((_,reject)=>{rejectFirst=reject})).mockResolvedValue(undefined)
  vi.stubGlobal('window',{api:{settings:{set}}})
  const patch=patcher(),first=patch({quality:'720p'}),latest=patch({quality:'1440p'})
  await Promise.resolve();rejectFirst(new Error('disk unavailable'))
  await Promise.all([first,latest])
  expect(useAppStore.getState().settings.quality).toBe('1440p')
})
it('two failed writes restore the original value and do not poison the next save',async()=>{
  const set=vi.fn().mockRejectedValueOnce(new Error('disk')).mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined)
  vi.stubGlobal('window',{api:{settings:{set}}})
  const patch=patcher()
  await Promise.all([patch({quality:'720p'}),patch({quality:'1440p'})])
  expect(useAppStore.getState().settings.quality).toBe(DEFAULT_SETTINGS.quality)
  expect(await patch({fps:60})).toBe(true)
  expect(useAppStore.getState().settings.fps).toBe(60)
})
it('a failed save preserves unrelated settings received while the request was pending',async()=>{
  let rejectFirst!: (e:Error)=>void
  vi.stubGlobal('window',{api:{settings:{set:vi.fn(()=>new Promise((_,reject)=>{rejectFirst=reject}))}}})
  const pending=patcher()({quality:'720p'})
  await Promise.resolve()
  useAppStore.getState().setSettings({...useAppStore.getState().settings,fps:60})
  rejectFirst(new Error('disk'));await pending
  expect(useAppStore.getState().settings.fps).toBe(60)
  expect(useAppStore.getState().settings.quality).toBe(DEFAULT_SETTINGS.quality)
})
it('a failed save does not replace a newer authoritative value of its field',async()=>{
  let rejectFirst!: (e:Error)=>void
  vi.stubGlobal('window',{api:{settings:{set:vi.fn(()=>new Promise((_,reject)=>{rejectFirst=reject}))}}})
  const pending=patcher()({quality:'720p'})
  await Promise.resolve()
  useAppStore.getState().setSettings({...useAppStore.getState().settings,quality:'1440p'})
  rejectFirst(new Error('disk'));await pending
  expect(useAppStore.getState().settings.quality).toBe('1440p')
})
