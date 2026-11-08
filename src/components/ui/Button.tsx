import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { Loader2 } from 'lucide-react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm'

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover [box-shadow:inset_0_1px_0_rgb(255_255_255/0.18),0_1px_2px_rgb(0_0_0/0.16),0_6px_14px_-8px_rgb(0_0_0/0.28)] disabled:bg-sunken disabled:text-faint disabled:[box-shadow:none]',
  secondary: 'bg-surface text-ink border border-line hover:border-line-strong hover:bg-sunken/60 shadow-card disabled:opacity-50',
  outline: 'bg-transparent text-ink border border-line-strong hover:bg-sunken/60 disabled:opacity-50',
  ghost: 'bg-transparent text-muted hover:bg-sunken/80 hover:text-ink disabled:opacity-50',
  danger: 'bg-danger text-danger-fg hover:brightness-110 shadow-[0_1px_0_rgb(0_0_0/0.1)] disabled:bg-sunken disabled:text-faint disabled:shadow-none',
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-control-sm px-3 text-sm rounded-lg gap-1.5',
  md: 'h-control px-4 text-sm rounded-xl gap-2',
  lg: 'h-control-lg px-5 text-base rounded-xl gap-2',
  icon: 'h-control w-9 rounded-xl',
  'icon-sm': 'h-control-sm w-8 rounded-lg',
}

export const buttonClasses = (variant: ButtonVariant = 'primary', size: ButtonSize = 'md', className?: string) =>
  cn(
    'pressable inline-flex items-center justify-center font-medium whitespace-nowrap select-none',
    // A disabled filled button becomes a quiet grey slab; outlined ones just fade. Both read as 'not now' in either theme.
    'disabled:cursor-not-allowed disabled:pointer-events-none',
    variants[variant],
    sizes[size],
    className,
  )

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClasses(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  )
})

export function LinkButton({ variant = 'primary', size = 'md', className, icon, children, ...rest }: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <Link className={buttonClasses(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('kbd', className)}>{children}</kbd>
}
