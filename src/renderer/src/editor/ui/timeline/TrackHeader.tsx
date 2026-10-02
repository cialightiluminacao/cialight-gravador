import { memo, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Popover from '@radix-ui/react-popover'
import { ArrowDown, ArrowUp, AudioLines, AudioWaveform, Check, Eye, EyeOff, Film, Lock, LockOpen, Mic, MoreVertical, Music, SlidersHorizontal, Trash2, Volume2, VolumeX } from 'lucide-react'
import { moveTrack, removeTrack, updateTrack } from '@shared/editor/ops'
import type { Track } from '@shared/editor/project'
import { Slider, Tip } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import type { PlaybackController } from '../../engine/PlaybackController'
import { useEditorStore } from '../../state/editorStore'
import { LevelMeter } from '../LevelMeter'
import { HEADER_W } from './layout'

// Cabeçalho da faixa: nome (duplo clique renomeia), ocultar (vídeo), mudo, cadeado, volume
// (popover com slider, uma transação por arrasto) e menu (mover para cima/baixo, excluir). Faixa de áudio: o ícone
// mostra e troca o papel (Voz / Música / Efeitos sonoros; a música abaixa sozinha sob a voz) e a borda direita tem
// o medidor de nível da faixa.

const st = (): ReturnType<typeof useEditorStore.getState> => useEditorStore.getState()
const MENU_ITEM = 'flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-fg outline-none data-[highlighted]:bg-white/8 data-[disabled]:pointer-events-none data-[disabled]:opacity-40'

function IconToggle({ label, active, onClick, children, warn }: { label: string; active: boolean; onClick: () => void; children: React.ReactNode; warn?: boolean }): React.JSX.Element {
  return (
    <Tip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn('flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-white/8', active ? (warn ? 'text-warn' : 'text-accent') : 'text-muted hover:text-fg')}
      >
        {children}
      </button>
    </Tip>
  )
}

function TrackName({ track }: { track: Track }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const cancel = useRef(false)
  if (draft !== null) {
    return (
      <input
        autoFocus
        aria-label="Nome da faixa"
        className="h-5 w-full min-w-0 rounded border border-accent/50 bg-bg-2 px-1 text-[11px] font-semibold text-fg outline-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            cancel.current = true
            e.currentTarget.blur()
          }
        }}
        onBlur={() => {
          const name = draft.trim()
          setDraft(null)
          if (!cancel.current && name && name !== track.name) st().apply((p) => updateTrack(p, track.id, { name }))
          cancel.current = false
        }}
      />
    )
  }
  return (
    <span className="truncate text-[11px] font-semibold text-fg-2" title="Duplo clique para renomear" onDoubleClick={() => setDraft(track.name)}>
      {track.name}
    </span>
  )
}

function VolumePopover({ track }: { track: Track }): React.JSX.Element {
  const sliding = useRef(false)
  const pct = Math.round(track.volume * 100)
  return (
    <Popover.Root>
      <Tip content={`Volume da faixa: ${pct}%`}>
        <Popover.Trigger asChild>
          <button type="button" aria-label="Volume da faixa" className={cn('flex h-6 min-w-6 items-center justify-center rounded-md px-1 font-mono text-[9px] hover:bg-white/8', pct !== 100 ? 'text-info' : 'text-muted hover:text-fg')}>
            {pct !== 100 ? `${pct}%` : <SlidersHorizontal className="h-3.5 w-3.5" />}
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content side="right" sideOffset={8} className="z-50 w-56 rounded-xl border border-border-strong bg-surface-3 p-3 shadow-2xl animate-in fade-in-0 zoom-in-95">
          <div className="mb-2 flex items-center justify-between text-[11px]">
            <span className="font-semibold text-fg-2">Volume — {track.name}</span>
            <span className="font-mono text-fg">{pct}%</span>
          </div>
          <Slider
            aria-label="Volume da faixa"
            min={0}
            max={200}
            step={1}
            value={[pct]}
            onValueChange={([v]) => {
              if (!sliding.current) {
                sliding.current = true
                st().begin()
              }
              st().apply((p) => updateTrack(p, track.id, { volume: v / 100 }), { transient: true })
            }}
            onValueCommit={() => {
              sliding.current = false
              st().commitTx()
            }}
          />
          <div className="mt-1 flex justify-between font-mono text-[9px] text-muted-2">
            <span>0%</span>
            <button type="button" className="hover:text-fg" onClick={() => st().apply((p) => updateTrack(p, track.id, { volume: 1 }))}>
              100%
            </button>
            <span>200%</span>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

type AudioRole = 'voice' | 'music' | 'sfx'
const ROLE_LABEL: Record<AudioRole, string> = { voice: 'Voz', music: 'Música', sfx: 'Efeitos sonoros' }
const ROLE_ICON = { voice: Mic, music: Music, sfx: AudioWaveform } as const
const ROLE_HINT: Record<AudioRole, string> = {
  voice: 'A fala desta faixa abaixa a música.',
  music: 'Abaixa sozinha quando há fala nas faixas de Voz.',
  sfx: 'Não abaixa nem faz a música abaixar.'
}

/** Ícone do papel da faixa de áudio; clicar abre o seletor (Voz / Música / Efeitos sonoros). */
function RoleMenu({ track }: { track: Track }): React.JSX.Element {
  const role = track.role === 'voice' || track.role === 'music' || track.role === 'sfx' ? track.role : null
  const Icon = role ? ROLE_ICON[role] : AudioLines
  return (
    <DropdownMenu.Root>
      <Tip content={role ? `Papel da faixa: ${ROLE_LABEL[role]}` : 'Definir o papel da faixa (Voz, Música…)'}>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label="Papel da faixa" data-track-role={role ?? 'none'} className="-ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-ok hover:bg-white/10">
            <Icon className="h-3 w-3" />
          </button>
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="right" align="start" sideOffset={6} className="z-50 w-[250px] rounded-xl border border-border-strong bg-surface-3 p-1 shadow-2xl animate-in fade-in-0 zoom-in-95">
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Papel da faixa</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={role ?? ''} onValueChange={(v) => st().apply((p) => updateTrack(p, track.id, { role: v as AudioRole }))}>
            {(Object.keys(ROLE_LABEL) as AudioRole[]).map((r) => {
              const RIcon = ROLE_ICON[r]
              return (
                <DropdownMenu.RadioItem key={r} value={r} className={cn(MENU_ITEM, 'items-start')}>
                  <RIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block">{ROLE_LABEL[r]}</span>
                    <span className="block text-[11px] leading-snug text-muted">{ROLE_HINT[r]}</span>
                  </span>
                  <DropdownMenu.ItemIndicator className="mt-0.5">
                    <Check className="h-3.5 w-3.5 text-accent" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              )
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

interface HeaderProps { track: Track; rowH: number; up: number | null; down: number | null; playback: PlaybackController | null }

/** Os itens mudam a cada evento de arraste; o cabeçalho só depende dos campos da própria faixa. */
function sameHeader(a: HeaderProps, b: HeaderProps): boolean {
  const x = a.track, y = b.track
  return a.rowH === b.rowH && a.up === b.up && a.down === b.down && a.playback === b.playback && x.id === y.id && x.name === y.name && x.muted === y.muted && x.hidden === y.hidden && x.locked === y.locked && x.volume === y.volume && x.role === y.role && x.items.length === y.items.length
}

/** up/down: índice de destino no modelo para "mover para cima/baixo" (null = já na ponta). */
export const TrackHeader = memo(function TrackHeader({ track, rowH, up, down, playback }: HeaderProps): React.JSX.Element {
  const set = (patch: Partial<Pick<Track, 'muted' | 'hidden' | 'locked'>>): void => void st().apply((p) => updateTrack(p, track.id, patch))
  const audio = track.kind === 'audio'
  return (
    <div
      data-track-header={track.id}
      className={cn('relative flex shrink-0 flex-col justify-center gap-0.5 border-r border-border bg-surface px-2', audio && 'pr-3', track.locked && 'bg-[repeating-linear-gradient(135deg,rgba(255,255,255,0.025)_0_5px,transparent_5px_10px)]')}
      style={{ width: HEADER_W, height: rowH }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {audio ? <RoleMenu track={track} /> : <Film className="h-3 w-3 shrink-0 text-info" />}
        <TrackName track={track} />
      </div>
      {audio ? (
        <LevelMeter
          bars={1}
          vertical
          label={`Nível da faixa ${track.name}`}
          className="absolute bottom-1.5 right-1 top-1.5 w-[4px]"
          read={() => [playback?.trackLevels[track.id] ?? 0]}
        />
      ) : null}
      <div className="flex items-center gap-0.5">
        {track.kind === 'video' ? (
          <IconToggle label={track.hidden ? 'Mostrar faixa' : 'Ocultar faixa'} active={track.hidden} warn onClick={() => set({ hidden: !track.hidden })}>
            {track.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </IconToggle>
        ) : null}
        <IconToggle label={track.muted ? 'Ativar som da faixa' : 'Silenciar faixa'} active={track.muted} warn onClick={() => set({ muted: !track.muted })}>
          {track.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
        </IconToggle>
        <IconToggle label={track.locked ? 'Desbloquear faixa' : 'Bloquear faixa'} active={track.locked} onClick={() => set({ locked: !track.locked })}>
          {track.locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
        </IconToggle>
        <VolumePopover track={track} />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" aria-label="Opções da faixa" className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-white/8 hover:text-fg">
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content side="right" align="start" sideOffset={6} className="z-50 min-w-[190px] rounded-xl border border-border-strong bg-surface-3 p-1 shadow-2xl animate-in fade-in-0 zoom-in-95">
              <DropdownMenu.Item className={MENU_ITEM} disabled={up === null} onSelect={() => up !== null && st().apply((p) => moveTrack(p, track.id, up))}>
                <ArrowUp className="h-4 w-4 text-muted" /> Mover para cima
              </DropdownMenu.Item>
              <DropdownMenu.Item className={MENU_ITEM} disabled={down === null} onSelect={() => down !== null && st().apply((p) => moveTrack(p, track.id, down))}>
                <ArrowDown className="h-4 w-4 text-muted" /> Mover para baixo
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item className={cn(MENU_ITEM, 'text-danger')} disabled={track.locked} onSelect={() => st().apply((p) => removeTrack(p, track.id))}>
                <Trash2 className="h-4 w-4" /> Excluir faixa{track.items.length ? ` (${track.items.length} ${track.items.length === 1 ? 'item' : 'itens'})` : ''}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  )
}, sameHeader)
