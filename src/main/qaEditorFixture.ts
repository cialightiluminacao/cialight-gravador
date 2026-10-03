import { mkdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import type { Project } from '@shared/editor/project'
import { createEmptyProject } from '@shared/editor/factory'
import { addAsset, addMediaFromAsset, updateItem } from '@shared/editor/ops'
import type { ProjectStore } from './project/projectStore'
import { runFfmpeg } from './export/ffmpegRunner'
import { probe } from './media/probe'
import { assetFromInfo } from './media/ingest'
import { log } from './log'

// QA visual do editor (CIALIGHT_QA=editor-fixture, só fora do pacote): gera mídia sintética e um
// projeto de teste com vídeo + áudio vinculado, imagem em PiP e música. Os vídeos/áudios entram como
// 'processing' para o editor exercitar a ingestão ao abrir. Usar com CIALIGHT_RAW_DIR apontando para
// test-out/ (o projeto fica em <brutos>\..\Projetos, longe da pasta real).

export const QA_PROJECT_ID = 'p-qa-editor-fixture'

// áudio com cara de fala (tom modulado em sílabas e frases) e de trilha (ruído em rajadas), para a
// forma de onda da linha do tempo ter variação visível
const VOICE = 'aevalsrc=0.8*sin(2*PI*180*t)*abs(sin(2*PI*0.45*t))*(0.25+0.75*abs(sin(2*PI*2.7*t))):s=48000'
const BURSTS = 'aevalsrc=0.6*(random(0)*2-1)*(0.5+0.5*sin(2*PI*1.2*t))^4:s=48000'

export async function createQaEditorFixture(projects: ProjectStore, outDir: string): Promise<string> {
  // nunca na pasta real do usuário: sem CIALIGHT_RAW_DIR o projeto iria para <Vídeos>\CiaLight Gravador\Projetos
  if (!process.env.CIALIGHT_RAW_DIR) throw new Error('CIALIGHT_QA=editor-fixture exige CIALIGHT_RAW_DIR (pasta de teste)')
  const dir = join(outDir, 'qa-editor')
  mkdirSync(dir, { recursive: true })
  const video = join(dir, 'testsrc2-voz.mp4')
  const logo = join(dir, 'logo.png')
  const music = join(dir, 'trilha.m4a')
  const gen = (args: string[], label: string): Promise<unknown> => runFfmpeg(['-hide_banner', '-nostdin', '-y', ...args, '-progress', 'pipe:1', '-nostats'], { label })
  // medição de desempenho (scripts/qa/bench-export.mjs): duração e tamanho do vídeo ajustáveis; o padrão dos QAs fica igual
  const seconds = String(Number(process.env.CIALIGHT_QA_FIXTURE_SECONDS) || 12)
  const size = /^\d+x\d+$/.test(process.env.CIALIGHT_QA_FIXTURE_SIZE ?? '') ? process.env.CIALIGHT_QA_FIXTURE_SIZE : '1280x720'
  await gen(['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`, '-f', 'lavfi', '-i', VOICE, '-t', seconds, '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video], 'qa: vídeo')
  await gen(['-f', 'lavfi', '-i', 'color=c=0xff4d4f:s=480x480,drawbox=x=60:y=60:w=360:h=360:color=white@0.9:t=24', '-frames:v', '1', '-update', '1', logo], 'qa: logo')
  await gen(['-f', 'lavfi', '-i', BURSTS, '-t', '9', '-c:a', 'aac', music], 'qa: trilha')

  const asset = async (id: string, path: string): Promise<ReturnType<typeof assetFromInfo>> => assetFromInfo(id, path, statSync(path), await probe(path))
  const aVideo = await asset('a_qa_video', video)
  const aLogo = await asset('a_qa_logo', logo)
  const aMusic = await asset('a_qa_music', music)

  let p: Project = { ...createEmptyProject('Projeto de teste do editor'), id: QA_PROJECT_ID }
  for (const a of [aVideo, aLogo, aMusic]) p = addAsset(p, a)
  p = addMediaFromAsset(p, aVideo.id, 0).project
  const logoAdd = addMediaFromAsset(p, aLogo.id, 1_000_000)
  p = updateItem(logoAdd.project, logoAdd.itemIds[0], (d) => {
    if (d.type !== 'media' || !d.visual) return
    d.durationUs = 6_000_000
    d.visual.transform.x = { value: 0.84 }
    d.visual.transform.y = { value: 0.22 }
    d.visual.transform.scale = { value: 0.28 }
    d.visual.shape = 'rounded'
    d.visual.border = { width: 6, color: '#ffffff' }
  })
  p = addMediaFromAsset(p, aMusic.id, 2_000_000).project
  p = { ...p, markers: [{ id: 'm_qa', tUs: 4_000_000, label: 'Marcador', color: '#f59e0b' }] }

  rmSync(projects.dirOf(QA_PROJECT_ID), { recursive: true, force: true })
  projects.create(p)
  log.info(`QA: projeto de teste ${QA_PROJECT_ID} criado em ${projects.dirOf(QA_PROJECT_ID)}`)
  return QA_PROJECT_ID
}
