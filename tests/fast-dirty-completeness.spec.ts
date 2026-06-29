#!/usr/bin/env -S node --no-warnings --loader ts-node/esm
/**
 * Regression test for fastDirty dirtyMap coverage.
 *
 * The previous `fastDirty` built a `Partial<Record<...>>` map that
 * omitted Call / WxxdProduct / WxxdOrder. Any dirty event for those
 * types fell into the `dirtyMap[payloadType]?.()` no-op branch and
 * was silently dropped. Today the persistent FlashStore does not yet
 * cover those types, so the silent drop is "fine"; but as soon as
 * a future patch persists any of them, the missing handler will
 * leave stale rows on disk after a dirty.
 *
 * Enforce the contract at the structural level: the puppet must
 * expose a complete dirty handler registry keyed by every
 * PUPPET.types.Dirty value.
 */
import { test } from 'tstest'

import * as PUPPET from '@juzi/wechaty-puppet'

import { PuppetService } from '../src/mod.js'

test('PuppetService exposes a complete dirty handler registry', async t => {
  const token = `puppet_service_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const puppet = new PuppetService({ token }) as any

  const handlers = puppet._dirtyHandlerMap
  t.ok(handlers, 'PuppetService should expose `_dirtyHandlerMap` for completeness checks')

  if (!handlers) {
    return
  }

  for (const value of Object.values(PUPPET.types.Dirty)) {
    if (typeof value !== 'number') continue
    t.equal(
      typeof handlers[value],
      'function',
      `dirty handler must exist for DirtyType.${PUPPET.types.Dirty[value]}`,
    )
  }
})
