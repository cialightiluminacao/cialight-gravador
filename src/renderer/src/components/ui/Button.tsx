import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold transition-all duration-150 select-none disabled:pointer-events-none disabled:opacity-40 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white shadow-[0_6px_20px_rgba(255,77,79,0.35)] hover:bg-accent-2',
        secondary: 'bg-surface-2 text-fg border border-border-strong hover:bg-surface-3',
        ghost: 'text-fg-2 hover:bg-white/5 hover:text-fg',
        outline: 'border border-border-strong text-fg hover:bg-white/5',
        danger: 'bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25',
        success: 'bg-ok/15 text-ok border border-ok/30 hover:bg-ok/25'
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
        xl: 'h-14 px-8 text-lg rounded-2xl'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = 'button', ...props }, ref) => (
  <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
))
Button.displayName = 'Button'

export { buttonVariants }
