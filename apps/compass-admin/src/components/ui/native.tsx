/**
 * Native form elements that accept Chakra style props.
 *
 * `Box as="select"` and `Box as="input"` do **not** type native attributes — `value`,
 * `onChange`, `disabled` and the rest are rejected, because the underlying type is
 * still a div's. The client app hit the same wall and solved it with
 * `chakra('button')`; this is the same fix for the three elements an admin tool is
 * mostly made of.
 *
 * Using real elements rather than custom widgets is deliberate: a native `<select>`
 * brings keyboard support, type-ahead, mobile pickers and screen-reader semantics
 * that a styled div would have to reimplement and would reimplement worse.
 */

import { chakra } from '@chakra-ui/react'

/** Unstyled native button: real activation semantics, no inherited appearance. */
export const PlainButton = chakra('button', {
  base: {
    appearance: 'none',
    background: 'transparent',
    border: 'none',
    padding: 0,
    font: 'inherit',
    color: 'inherit',
    textAlign: 'inherit',
    cursor: 'pointer',
  },
})

/** Native select with a minimal frame; callers add spacing and width. */
export const PlainSelect = chakra('select', {
  base: {
    appearance: 'auto',
    font: 'inherit',
    color: 'inherit',
    background: 'bg.canvas',
    borderWidth: '1px',
    borderColor: 'border.strong',
    borderRadius: 'md',
    cursor: 'pointer',
    _focusVisible: { outline: '2px solid', outlineColor: 'accent.solid' },
  },
})

/** Native text/number input. */
export const PlainInput = chakra('input', {
  base: {
    font: 'inherit',
    color: 'inherit',
    background: 'bg.canvas',
    borderWidth: '1px',
    borderColor: 'border.strong',
    borderRadius: 'md',
    _focusVisible: { outline: '2px solid', outlineColor: 'accent.solid' },
  },
})

/**
 * Native textarea.
 *
 * A separate primitive rather than `PlainInput as="textarea"` for exactly the reason
 * this file exists: `as` changes the rendered tag but not the props type, so the
 * `onChange` handler is still typed against `HTMLInputElement` and `rows` is not
 * accepted at all.
 */
export const PlainTextarea = chakra('textarea', {
  base: {
    font: 'inherit',
    color: 'inherit',
    background: 'bg.canvas',
    borderWidth: '1px',
    borderColor: 'border.strong',
    borderRadius: 'md',
    // Vertical only: a textarea a user can widen past its container breaks the
    // surrounding layout, and horizontal room is not what a recipient list needs.
    resize: 'vertical',
    _focusVisible: { outline: '2px solid', outlineColor: 'accent.solid' },
  },
})
