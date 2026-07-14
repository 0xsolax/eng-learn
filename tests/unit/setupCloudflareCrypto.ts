import { timingSafeEqual } from 'node:crypto'

if (typeof crypto.subtle.timingSafeEqual !== 'function') {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: timingSafeEqual,
  })
}
