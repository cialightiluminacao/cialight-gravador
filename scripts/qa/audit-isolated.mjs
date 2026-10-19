import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { resolve, join, relative, isAbsolute } from 'node:path'
import electronPath from 'electron'
const root=resolve(import.meta.dirname,'../..'),appRoot=resolve(process.argv[2]??''),name=process.argv[3]??'editor-render'
const inside=relative(join(root,'test-out'),appRoot)
if(!inside||inside.startsWith('..')||isAbsolute(inside)||!['editor-render','editor-export','editor-formats'].includes(name))throw new Error('Invalid isolated app/test')
const output=join(root,'test-out/product-audit',appRoot.split(/[\\/]/).at(-1)+'-'+Date.now()),profile=join(appRoot,'test-out/profile')
mkdirSync(profile,{recursive:true});mkdirSync(output,{recursive:true})
const env={...process.env,CIALIGHT_TEST:name,CIALIGHT_QA:'isolated',CIALIGHT_QA_USER_DATA:profile,CIALIGHT_RAW_DIR:join(appRoot,'test-out/raw')};delete env.ELECTRON_RUN_AS_NODE
const started=Date.now(),child=spawn(electronPath,[appRoot],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b)
console.log('ISOLATED START '+appRoot+' '+output)
const code=await new Promise((res,rej)=>{child.on('exit',res);child.on('error',rej)})
writeFileSync(join(output,'stdout.log'),stdout);writeFileSync(join(output,'stderr.log'),stderr)
const report=join(appRoot,'test-out',name+'-report.json');if(existsSync(report))copyFileSync(report,join(output,'report.json'))
const result={code,seconds:(Date.now()-started)/1000,appRoot,output,failures:stdout.split(/\r?\n/).filter(l=>/^FAIL/.test(l))}
writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exitCode=code??1
