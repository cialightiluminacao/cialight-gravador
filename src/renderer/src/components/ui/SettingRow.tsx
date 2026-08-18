import * as React from 'react'
import { cn } from '@/lib/cn'

// Linha de configuração: rótulo + descrição à esquerda, controle à direita.
// Usada nas telas de Configurações; empilha o controle abaixo quando `stack`.

export function SettingRow({
  label,
  description,
  children,
  stack = false,
  className,
  htmlFor
}: {
  label: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  /** Controle largo (slider, caminho): fica abaixo do rótulo em vez de ao lado. */
  stack?: boolean
  className?: string
  htmlFor?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex py-2 first:pt-0 last:pb-0', stack ? 'flex-col gap-3' : 'items-center justify-between gap-4', className)}>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm font-semibold text-fg">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p> : null}
      </div>
      {children ? <div className={cn('shrink-0', stack ? 'w-full' : 'flex items-center gap-2')}>{children}</div> : null}
    </div>
  )
}

/** Divide linhas dentro de um cartão com hairlines. */
export function SettingRows({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <div className={cn('divide-y divide-border', className)}>{children}</div>
}

/** Nota curta com ícone (aviso, dica ou informação) dentro de um cartão. */
export function Note({ tone = 'info', icon, children, className }: { tone?: 'info' | 'warn' | 'danger' | 'neutral'; icon?: React.ReactNode; children: React.ReactNode; className?: string }): React.JSX.Element {
  const tones = {
    info: 'border-info/25 bg-info/8 text-fg-2',
    warn: 'border-warn/30 bg-warn/10 text-fg-2',
    danger: 'border-danger/30 bg-danger/10 text-fg-2',
    neutral: 'border-border bg-white/[0.03] text-muted'
  }
  const iconTone = { info: 'text-info', warn: 'text-warn', danger: 'text-danger', neutral: 'text-muted' }
  return (
    <div className={cn('flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-xs leading-relaxed', tones[tone], className)}>
      {icon ? <span className={cn('mt-0.5 shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5', iconTone[tone])}>{icon}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
