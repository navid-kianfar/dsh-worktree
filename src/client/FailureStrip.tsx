/**
 * The one place a git failure is drawn, shared by both popovers and every dialog.
 *
 * Two lines, always: this surface's own sentence about what class of failure it was, and git's own
 * message underneath. The first tells someone what to do; the second is what they paste into a
 * search when the first is not enough, and dropping it would throw away the only precise account of
 * what happened.
 * @module @achasoft/dsh-worktree/client/FailureStrip
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitFailure } from '../host/types.ts'
import { describeFailure } from './format.ts'
import css from './surface.module.css'

/**
 * Render one classified failure, or nothing when there is none.
 * @param props.failure - the failure to show; null renders nothing.
 * @param props.t - the `worktree` namespace translate.
 * @returns the strip, or null.
 */
export function FailureStrip({ failure, t }: {
  failure: GitFailure | null
  t: TranslateNS<'worktree'>
}) {
  if (failure === null) return null
  return (
    <div className={css.error} role="alert">
      <span>{t('error.title')}</span>
      {/* Both lines stay English by repository policy: the classification is an operator diagnostic
          and the second line is git's own output, which no dictionary could translate faithfully. */}
      <span className={css.errorDetail}>{describeFailure(failure.code)}</span>
      <span className={css.errorDetail}>{failure.message}</span>
    </div>
  )
}
