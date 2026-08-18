import { useCallback, useMemo, useRef } from 'react'
import { AlertTriangle, Globe, Keyboard, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import type { HotkeyAction } from '@shared/types'
import type { HotkeyStatus } from '@shared/ipc'
import { DEFAULT_HOTKEYS, HOTKEY_LABELS } from '@shared/defaults'
import { findDuplicateHotkeys, hotkeyProblems } from '@shared/hotkeys'
import { useAppStore } from '@/app/store'
import { Button } from '@/components/ui/Button'
import { Badge, Kbd, Section, Tip } from '@/components/ui/primitives'
import { HotkeyRecorder } from './HotkeyRecorder'
import { freezeHotkeyStatus, isHotkeyStatusFrozen, unfreezeHotkeyStatus, useDisplayedHotkeyStatus } from './hotkeyStatusView'
import { useSettingsPatch } from './useSettingsPatch'

// Aba Atalhos: tabela ação × combinação, status de registro, avisos e conflitos.

type HotkeyMap = Record<HotkeyAction, string | null>

const ACTIONS = Object.keys(HOTKEY_LABELS) as HotkeyAction[]
const EMPTY_MAP = Object.fromEntries(ACTIONS.map((a) => [a, null])) as HotkeyMap

function sameMap(a: HotkeyMap, b: HotkeyMap): boolean {
  return ACTIONS.every((k) => a[k] === b[k])
}

/** Avisos únicos por ação: do status do main + heurísticas locais. */
function problemsFor(acc: string | null, status: HotkeyStatus | undefined): string[] {
  const list = [...(status?.problems ?? [])]
  if (acc) for (const p of hotkeyProblems(acc)) if (!list.includes(p)) list.push(p)
  return list
}

function StatusBadge({ acc, status, duplicate }: { acc: string | null; status: HotkeyStatus | undefined; duplicate: boolean }): React.JSX.Element {
  if (!acc) return <Badge tone="neutral">sem atalho</Badge>
  if (duplicate) return <Badge tone="warn">em conflito</Badge>
  if (!status) return <Badge tone="neutral">…</Badge>
  return status.registered ? <Badge tone="ok">ativo</Badge> : <Badge tone="warn">não registrado</Badge>
}

function warnUnregistered(status: HotkeyStatus[]): void {
  const failed = status.filter((s) => s.accelerator && !s.registered)
  if (!failed.length) return
  toast.warning(failed.length === 1 ? `Um atalho não pôde ser registrado: ${HOTKEY_LABELS[failed[0].action]}` : `${failed.length} atalhos não puderam ser registrados`)
}

export function HotkeysTab(): React.JSX.Element {
  const { settings, patch } = useSettingsPatch()
  const hotkeyStatus = useDisplayedHotkeyStatus()
  const setHotkeyStatus = useAppStore((s) => s.setHotkeyStatus)
  const hotkeys = settings.hotkeys
  /** Último mapa enviado ao main (evita reaplicar o mesmo mapa duas vezes). */
  const applied = useRef<HotkeyMap | null>(null)
  /** Mapa em vigor quando a captura começou (para avisar só se algo mudou). */
  const beforeCapture = useRef<HotkeyMap | null>(null)

  const statusByAction = useMemo(() => new Map(hotkeyStatus.map((s) => [s.action, s])), [hotkeyStatus])
  const duplicates = useMemo(() => {
    const set = new Set<HotkeyAction>()
    for (const [a, b] of findDuplicateHotkeys(hotkeys)) {
      set.add(a as HotkeyAction)
      set.add(b as HotkeyAction)
    }
    return set
  }, [hotkeys])
  const isDefault = useMemo(() => sameMap(hotkeys, DEFAULT_HOTKEYS), [hotkeys])

  const applyMap = useCallback(
    async (map: HotkeyMap): Promise<HotkeyStatus[] | null> => {
      applied.current = map
      try {
        const status = await window.api.hotkeys.apply(map)
        setHotkeyStatus(status)
        return status
      } catch (err) {
        toast.error('Não foi possível registrar os atalhos', { description: err instanceof Error ? err.message : String(err) })
        return null
      }
    },
    [setHotkeyStatus]
  )

  /** Registra no main o mapa que está no store (se ainda não for o aplicado). */
  const syncApplied = async (warn: boolean): Promise<void> => {
    const current = useAppStore.getState().settings.hotkeys
    if (applied.current && sameMap(applied.current, current)) return
    const status = await applyMap(current)
    if (warn && status) warnUnregistered(status)
  }

  const commit = async (next: HotkeyMap): Promise<boolean> => {
    const ok = await patch({ hotkeys: next })
    // Durante uma captura os atalhos ficam suspensos; o mapa é aplicado ao terminar.
    if (!isHotkeyStatusFrozen()) await syncApplied(ok)
    return ok
  }

  const setOne = (action: HotkeyAction, value: string | null): void => void commit({ ...hotkeys, [action]: value })
  const restore = async (): Promise<void> => {
    if (await commit({ ...DEFAULT_HOTKEYS })) toast.success('Atalhos padrão restaurados')
  }

  // Enquanto o usuário grava uma combinação, os atalhos globais são suspensos
  // para que a própria combinação (ex.: Ctrl+Shift+F9) chegue ao campo em vez de disparar a ação.
  // O status exibido fica congelado nesse período (ver hotkeyStatusView).
  const onCapturingChange = (capturing: boolean): void => {
    if (capturing && !isHotkeyStatusFrozen()) {
      beforeCapture.current = useAppStore.getState().settings.hotkeys
      freezeHotkeyStatus()
      void applyMap(EMPTY_MAP)
    } else if (!capturing && isHotkeyStatusFrozen()) {
      const changed = !beforeCapture.current || !sameMap(beforeCapture.current, useAppStore.getState().settings.hotkeys)
      void syncApplied(changed).finally(unfreezeHotkeyStatus)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Atalhos globais"
        className="rise-in"
        aside={
          <Button size="sm" variant="ghost" onClick={() => void restore()} disabled={isDefault}>
            <RotateCcw className="h-3.5 w-3.5" /> Restaurar padrões
          </Button>
        }
      >
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-white/[0.03] text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-3 py-1.5 font-semibold">Ação</th>
                <th className="px-3 py-1.5 font-semibold">Combinação</th>
                <th className="px-3 py-1.5 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {ACTIONS.map((action) => {
                const acc = hotkeys[action]
                const status = statusByAction.get(action)
                const dup = duplicates.has(action)
                const problems = problemsFor(acc, status).filter((p) => !dup || !p.startsWith('Mesma combinação'))
                return (
                  <tr key={action} className="border-t border-border align-top">
                    <td className="px-3 py-1">
                      <div className="flex min-h-8 items-center font-medium text-fg">{HOTKEY_LABELS[action]}</div>
                    </td>
                    <td className="px-3 py-1">
                      <HotkeyRecorder value={acc} onChange={(v) => setOne(action, v)} onCapturingChange={onCapturingChange} invalid={dup} ariaLabel={HOTKEY_LABELS[action]} />
                      {dup ? (
                        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-danger">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                          Mesma combinação usada em outra ação — só uma delas vai funcionar.
                        </p>
                      ) : null}
                      {problems.map((p) => (
                        <p key={p} className="mt-1.5 flex items-center gap-1.5 text-xs text-warn">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                          {p}
                        </p>
                      ))}
                    </td>
                    <td className="px-3 py-1 text-right">
                      <div className="flex min-h-8 items-center justify-end">
                        <Tip
                          content={
                            status?.registered
                              ? 'Registrado no Windows: funciona com qualquer programa em foco'
                              : acc
                                ? 'O Windows não aceitou o registro (outro programa deve estar usando)'
                                : 'Nenhuma combinação definida'
                          }
                        >
                          <span>
                            <StatusBadge acc={acc} status={status} duplicate={dup} />
                          </span>
                        </Tip>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-col gap-1.5 text-xs leading-relaxed text-muted">
          <p className="flex items-start gap-2">
            <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
            <span>
              Os atalhos são <strong className="font-semibold text-fg-2">globais</strong>: funcionam mesmo com outros programas em foco. Se um deles ficar «não registrado», outro aplicativo já usa a mesma combinação —
              escolha outra.
            </span>
          </p>
          <p className="flex items-start gap-2">
            <Keyboard className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
            <span>
              No teclado ABNT2, <Kbd>Ctrl+Alt</Kbd> equivale a <strong className="font-semibold text-fg-2">AltGr</strong> e pode digitar caracteres em vez de acionar. Prefira <Kbd>Ctrl+Shift</Kbd> ou teclas F.
            </span>
          </p>
        </div>
      </Section>
    </div>
  )
}
