import { Children, isValidElement, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { PathField } from './PathField'
vi.mock('sonner',()=>({toast:{error:vi.fn()}}))
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks()})
function text(node:ReactNode):string { return Children.toArray(node).map(n=>typeof n==='string'?n:isValidElement<{children?:ReactNode}>(n)?text(n.props.children):'').join('').trim() }
function action(node:ReactNode,label:string):()=>void {
  for(const n of Children.toArray(node))if(isValidElement<{children?:ReactNode;onClick?:()=>void}>(n)){
    if(n.props.onClick&&text(n.props.children)===label)return n.props.onClick
    try{return action(n.props.children,label)}catch{}
  }
  throw new Error('Missing action '+label)
}
it('a failed native folder dialog reports an error and preserves the selected directory',async()=>{
  const onChange=vi.fn()
  vi.stubGlobal('window',{api:{settings:{pickFolder:vi.fn().mockRejectedValue(new Error('Dialog parent closed'))}}})
  action(PathField({value:'C:/current',defaultPath:null,onChange}),'Trocar')()
  await vi.waitFor(()=>expect(toast.error).toHaveBeenCalled(),{timeout:200})
  expect(onChange).not.toHaveBeenCalled()
})
it('cancelling the native dialog preserves the current directory',async()=>{
  const onChange=vi.fn()
  vi.stubGlobal('window',{api:{settings:{pickFolder:vi.fn().mockResolvedValue(null)}}})
  action(PathField({value:'C:/current',defaultPath:null,onChange}),'Trocar')()
  await Promise.resolve()
  expect(onChange).not.toHaveBeenCalled();expect(toast.error).not.toHaveBeenCalled()
})
