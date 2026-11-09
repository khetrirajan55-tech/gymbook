import type { Transition } from 'motion/react'

/** Default UI spring (damping 1.0, response ~0.35s) expressed in motion's duration/bounce form. */
export const springDefault: Transition = { type: 'spring', duration: 0.3, bounce: 0 }
/** Sheet / drawer spring: critically damped, no overshoot. */
export const springSheet: Transition = { type: 'spring', duration: 0.4, bounce: 0 }
/** Cross-fade used when the person prefers reduced motion. */
export const fadeReduced: Transition = { duration: 0.15, ease: 'easeOut' }
/** Page-enter transition. */
export const pageEnter: Transition = { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
