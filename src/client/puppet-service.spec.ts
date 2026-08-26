#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import {
  sinon,
  test,
}  from 'tstest'
import getPort from 'get-port'

import { FileBox } from 'file-box'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

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

let callInviteWithMediaTestId = 0

function createCallInviteWithMediaPuppet (
  callId: string,
): { puppet: PuppetService, requestList: grpcPuppet.CallInviteWithMediaRequest[] } {
  const puppet = new PuppetService({
    token: `call-invite-with-media-test-${callInviteWithMediaTestId++}`,
  })

  const requestList: grpcPuppet.CallInviteWithMediaRequest[] = []

  ;(puppet as any)._grpcManager = {
    client: {
      callInviteWithMedia: (
        request  : grpcPuppet.CallInviteWithMediaRequest,
        callback : (error: null | Error, response: grpcPuppet.CallInviteWithMediaResponse) => void,
      ) => {
        requestList.push(request)

        const response = new grpcPuppet.CallInviteWithMediaResponse()
        response.setCallId(callId)
        callback(null, response)
      },
    },
  }

  return { puppet, requestList }
}

test('callInviteWithMedia maps the file and the orchestration options onto the request', async t => {
  const { puppet, requestList } = createCallInviteWithMediaPuppet('call-id-with-file')

  const file = FileBox.fromUrl('https://example.com/notice.mp3', { name: 'notice.mp3' })

  const callId = await puppet.callInviteWithMedia(
    [ 'contact-1', 'contact-2' ],
    file,
    { hangupDelayMs: 800, hangupOnFinish: true },
  )

  t.equal(callId, 'call-id-with-file', 'returns the call_id from the server response')
  t.equal(requestList.length, 1, 'sends exactly one request')

  const request = requestList[0]!
  t.same(request.getContactIdsList(), [ 'contact-1', 'contact-2' ], 'maps contactIds onto contact_ids')
  t.equal(request.getHangupOnFinish(), true, 'maps hangupOnFinish onto hangup_on_finish')
  t.equal(request.getHangupDelayMs(), 800, 'maps hangupDelayMs onto hangup_delay_ms')
  t.equal(
    JSON.parse(request.getFileBox()).name,
    'notice.mp3',
    'serializes the FileBox onto file_box',
  )
})

test('callInviteWithMedia leaves file_box empty and defaults the options when they are omitted', async t => {
  const { puppet, requestList } = createCallInviteWithMediaPuppet('call-id-no-file')

  const callId = await puppet.callInviteWithMedia([ 'contact-1' ])

  t.equal(callId, 'call-id-no-file', 'returns the call_id from the server response')

  const request = requestList[0]!
  t.equal(request.getFileBox(), '', 'leaves file_box empty when no file is given')
  t.equal(request.getHangupOnFinish(), false, 'defaults hangup_on_finish to false')
  t.equal(request.getHangupDelayMs(), 0, 'defaults hangup_delay_ms to 0')
})

test('callInviteWithMedia rejects when the server returns an empty call_id', async t => {
  const { puppet } = createCallInviteWithMediaPuppet('')

  await t.rejects(
    puppet.callInviteWithMedia([ 'contact-1' ], undefined, { hangupOnFinish: true }),
    /empty call_id/,
    'does not hand back an unusable empty call_id',
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
