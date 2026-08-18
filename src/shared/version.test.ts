import { describe, expect, it } from 'vitest'
import { APP_NAME } from './constants'

describe('constants', () => {
  it('nome do produto', () => {
    expect(APP_NAME).toBe('CiaLight Gravador')
  })
})
