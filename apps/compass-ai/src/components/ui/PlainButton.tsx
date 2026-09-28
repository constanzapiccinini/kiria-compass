/**
 * An unstyled native `<button>` that accepts Chakra style props.
 *
 * `Box as="button"` does not type native button attributes (`type`, `disabled`), and
 * Chakra's `Button` brings a full visual recipe we do not want for citation chips,
 * thumbnails and card-shaped controls. This gives real button semantics — keyboard
 * activation, focus handling, screen-reader role — with no inherited appearance.
 */

import { chakra } from '@chakra-ui/react'

export const PlainButton = chakra('button', {
  base: {
    // Strip the UA button look; every caller styles it explicitly.
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
