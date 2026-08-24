#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import {
  sinon,
  test,
}  from 'tstest'
import getPort from 'get-port'

import { PuppetMock } from '@juzi/wechaty-puppet-mock'

import { PuppetService } from './puppet-service.js'
import { PuppetServer } from '../mod.js'

let batchRoomFallbackTestId = 0

function createBatchRoomFallbackPuppet (
  roomRawPayload: (roomId: string) => Promise<{ id: string }>,
): PuppetService {
  const puppet = new PuppetService({
    token: `batch-room-fallback-test-${batchRoomFallbackTestId++}`,
  })

  ;(puppet as any)._payloadStore.room = {
    get: async () => undefined,
    set: async () => undefined,
  }
  ;(puppet as any)._grpcManager = {
    client: {
      batchRoomPayload: (_request: unknown, callback: (error: Error) => void) => {
        callback(new Error('batch room payload unavailable'))
      },
    },
  }
  sinon.stub(puppet, 'roomRawPayload').callsFake(roomRawPayload as any)

  return puppet
}

test('batchRoomRawPayload isolates one invalid room during per-room fallback', async t => {
  const puppet = createBatchRoomFallbackPuppet(async roomId => {
    if (roomId === '10006') {
      throw new Error('invalid roomId: 10006')
    }
    return { id: roomId }
  })

  const result = await puppet.batchRoomRawPayload([
    'room-valid-before',
    '10006',
    'room-valid-after',
  ])

  t.same(
    Array.from(result.keys()),
    [ 'room-valid-before', 'room-valid-after' ],
    'returns every valid room and omits only the invalid room',
  )
  t.equal(
    (puppet.roomRawPayload as any).callCount,
    3,
    'continues the fallback loop after one room fails',
  )
})

test('batchRoomRawPayload still rejects when every per-room fallback fails', async t => {
  const puppet = createBatchRoomFallbackPuppet(async roomId => {
    throw new Error(`invalid roomId: ${roomId}`)
  })

  await t.rejects(
    puppet.batchRoomRawPayload([ '10006', '10007' ]),
    /batch room payload unavailable/,
    'does not turn a total upstream failure into an empty successful result',
  )
})

test('version()', async t => {
  const puppet = new PuppetService({
    token: 'test',
  })
  t.ok(puppet.version())
})

/**
 * Huan(202003):
 *  need to setup a test server to provide test token for Puppet Service
 */
test('PuppetService restart without problem', async t => {
  const TOKEN       = 'insecure_token'
  const PORT        = await getPort()
  const ENDPOINT    = '0.0.0.0:' + PORT

  const puppet = new PuppetMock() as any
  const serverOptions = {
    endpoint: ENDPOINT,
    puppet,
    token: TOKEN,
  } as const

  const puppetServer = new PuppetServer(serverOptions)
  await puppetServer.start()

  /**
   * Puppet Service Client
   */
  const puppetOptions = {
    endpoint: ENDPOINT,
    token: TOKEN,
  } as const

  const puppetService = new PuppetService(puppetOptions)

  try {
    for (let i = 0; i < 3; i++) {
      await puppetService.start()
      await puppetService.stop()
      t.pass('start/stop-ed at #' + i)
    }
    t.pass('PuppetService() start/restart successed.')
  } catch (e) {
    t.fail(e as any)
  }

  await puppetServer.stop()
})
