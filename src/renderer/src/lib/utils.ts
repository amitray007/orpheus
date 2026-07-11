import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * cn — the standard shadcn/ui class-merge helper.
 * Combines conditional classnames (clsx) with Tailwind-aware de-duplication
 * (tailwind-merge) so later conflicting utility classes win predictably
 * (e.g. cn('px-2', condition && 'px-4') -> 'px-4', not both).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
