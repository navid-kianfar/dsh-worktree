import { describe, expect, it } from 'vitest'
import { MAX_BRANCH_NAME_CHARS, slugify } from '../src/shared/name.ts'
import { checkBranchName, applyBranchPrefix } from '../src/shared/branch-name.ts'

describe('slugify', () => {
  it('folds an ordinary prompt into hyphenated lower-case words', () => {
    expect(slugify('Fix the login redirect loop')).toBe('fix-the-login-redirect-loop')
  })

  it('collapses punctuation runs into a single hyphen', () => {
    expect(slugify('  Add   OAuth2 / refresh-token   support! ')).toBe('add-oauth2-refresh-token-support')
  })

  it('keeps only the first line', () => {
    expect(slugify('rename the parser\n\nAlso: rewrite the tests')).toBe('rename-the-parser')
  })

  it('keeps unicode letters, so a CJK prompt is not empty', () => {
    expect(slugify('修复登录重定向')).toBe('修复登录重定向')
  })

  it('answers empty for text with no letters or digits', () => {
    expect(slugify('   ---   ')).toBe('')
    expect(slugify('')).toBe('')
  })

  it('keeps at most six words', () => {
    expect(slugify('one two three four five six seven eight')).toBe('one-two-three-four-five-six')
  })

  it('never exceeds the character budget', () => {
    const name = slugify('a'.repeat(200))
    expect(name.length).toBeLessThanOrEqual(MAX_BRANCH_NAME_CHARS)
  })

  it('produces names git accepts, with and without a prefix', () => {
    for (const prompt of ['Fix the login redirect loop', '修复登录重定向', 'Add OAuth2 refresh support']) {
      const name = slugify(prompt)
      expect(checkBranchName(name), prompt).toEqual({ ok: true })
      expect(checkBranchName(applyBranchPrefix('feature/', name)), prompt).toEqual({ ok: true })
    }
  })
})
