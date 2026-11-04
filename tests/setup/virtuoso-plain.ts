// jsdom has no layout: every element is 0 x 0, so the real react-virtuoso would draw no card at all. In every test the list is therefore the plain one
// (every item, then the footer). The tests of the virtual list itself (tests/catalog-virtualization.test.tsx) take the real library back with
// vi.unmock and give it a size to work with.
import { createElement, Fragment, type ComponentType, type ReactNode } from 'react'
import { vi } from 'vitest'

interface PlainProps {
  data?: readonly unknown[]
  itemContent: (index: number, item: unknown, context: unknown) => ReactNode
  computeItemKey?: (index: number, item: unknown, context: unknown) => string | number
  components?: { Footer?: ComponentType<{ context?: unknown }> }
  context?: unknown
}

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data = [], itemContent, computeItemKey, components, context }: PlainProps) =>
    createElement(
      Fragment,
      null,
      data.map((item, index) => createElement(Fragment, { key: computeItemKey ? computeItemKey(index, item, context) : index }, itemContent(index, item, context))),
      components?.Footer ? createElement(components.Footer, { context }) : null,
    ),
}))

// The screens load the list as a chunk of its own (React.lazy). Loading it here, before the test, keeps a test from waiting for the first load.
await import('../../src/components/services/VirtualCards')
