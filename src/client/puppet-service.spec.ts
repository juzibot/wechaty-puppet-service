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

let orgBroadcastTestId = 0

function createOrgBroadcastPuppet (
  payloadResponse?: grpcPuppet.OrgBroadcastPayloadResponse,
): { puppet: PuppetService, executeRequestList: grpcPuppet.OrgBroadcastExecuteRequest[] } {
  const puppet = new PuppetService({
    token: `org-broadcast-test-${orgBroadcastTestId++}`,
  })

  const executeRequestList: grpcPuppet.OrgBroadcastExecuteRequest[] = []

  ;(puppet as any)._grpcManager = {
    client: {
      orgBroadcastExecute: (
        request  : grpcPuppet.OrgBroadcastExecuteRequest,
        callback : (error: null | Error, response: grpcPuppet.OrgBroadcastExecuteResponse) => void,
      ) => {
        executeRequestList.push(request)
        callback(null, new grpcPuppet.OrgBroadcastExecuteResponse())
      },
      orgBroadcastPayload: (
        request  : grpcPuppet.OrgBroadcastPayloadRequest,
        callback : (error: null | Error, response?: grpcPuppet.OrgBroadcastPayloadResponse) => void,
      ) => {
        void request
        callback(null, payloadResponse)
      },
    },
  }

  return { puppet, executeRequestList }
}

test('orgBroadcastPayload maps every response field onto OrgBroadcastPayload', async t => {
  const roomTarget = new grpcPuppet.OrgBroadcastTarget()
  roomTarget.setRoomId('R:room-1')
  roomTarget.setStatus(grpcPuppet.OrgBroadcastTargetStatus.ORG_BROADCAST_TARGET_STATUS_UNCONFIRMED)

  const sentRoomTarget = new grpcPuppet.OrgBroadcastTarget()
  sentRoomTarget.setRoomId('R:room-2')
  sentRoomTarget.setStatus(grpcPuppet.OrgBroadcastTargetStatus.ORG_BROADCAST_TARGET_STATUS_SENT)

  const response = new grpcPuppet.OrgBroadcastPayloadResponse()
  response.setId('4728994241730369413')
  response.setSendType(2)
  response.setConversationType(1)
  response.setCreatorId('creator-1')
  response.setExecTime(1758600000000)
  response.setStatus(3)
  response.setCanCancel(true)
  response.setAllowSelect(true)
  response.setSent(false)
  response.setTotalCount(7)
  response.setSentCount(5)
  response.setContentListJson('[{"contentType":2}]')
  response.setTargetsList([ roomTarget, sentRoomTarget ])

  const { puppet } = createOrgBroadcastPuppet(response)
  const payload = await puppet.orgBroadcastPayload('4728994241730369413')

  t.same(payload, {
    id               : '4728994241730369413',
    sendType         : 2,
    conversationType : 1,
    creatorId        : 'creator-1',
    execTime         : 1758600000000,
    status           : 3,
    canCancel        : true,
    allowSelect      : true,
    sent             : false,
    totalCount       : 7,
    sentCount        : 5,
    contentListJson  : '[{"contentType":2}]',
    targets          : [
      { contactId: undefined, roomId: 'R:room-1', status: 4 },
      { contactId: undefined, roomId: 'R:room-2', status: 1 },
    ],
  }, 'maps every field and drops the empty contact_id of room targets')
})

test('orgBroadcastPayload maps empty creator_id and contact targets', async t => {
  const contactTarget = new grpcPuppet.OrgBroadcastTarget()
  contactTarget.setContactId('contact-1')

  const response = new grpcPuppet.OrgBroadcastPayloadResponse()
  response.setId('org-broadcast-2')
  response.setTargetsList([ contactTarget ])

  const { puppet } = createOrgBroadcastPuppet(response)
  const payload = await puppet.orgBroadcastPayload('org-broadcast-2')

  t.equal(payload.creatorId, undefined, 'maps an empty creator_id to undefined')
  t.same(payload.targets, [ { contactId: 'contact-1', roomId: undefined, status: 0 } ], 'drops the empty room_id of contact targets')
})

test('orgBroadcastExecute sends all targets as an empty target_ids when targetIds is omitted', async t => {
  const { puppet, executeRequestList } = createOrgBroadcastPuppet()

  await puppet.orgBroadcastExecute('org-broadcast-1')

  t.equal(executeRequestList.length, 1, 'sends exactly one request')
  t.equal(executeRequestList[0]!.getId(), 'org-broadcast-1', 'maps orgBroadcastId onto id')
  t.same(executeRequestList[0]!.getTargetIdsList(), [], 'leaves target_ids empty')
})

test('orgBroadcastExecute forwards the selected targets', async t => {
  const { puppet, executeRequestList } = createOrgBroadcastPuppet()

  await puppet.orgBroadcastExecute('org-broadcast-1', [ 'contact-1', 'contact-2' ])

  t.same(executeRequestList[0]!.getTargetIdsList(), [ 'contact-1', 'contact-2' ], 'maps targetIds onto target_ids')
})

test('orgBroadcastExecute rejects an explicit empty targetIds instead of sending to all targets', async t => {
  const { puppet, executeRequestList } = createOrgBroadcastPuppet()

  await t.rejects(
    puppet.orgBroadcastExecute('org-broadcast-1', []),
    /targetIds is empty/,
    'does not turn an empty selection into sending to all targets',
  )
  t.equal(executeRequestList.length, 0, 'never reaches the server')
})

test('org broadcast grpc events are emitted as puppet events', async t => {
  const { puppet } = createOrgBroadcastPuppet()

  const createdSpy = sinon.spy()
  const sentSpy    = sinon.spy()
  puppet.on('org-broadcast-created', createdSpy)
  puppet.on('org-broadcast-sent', sentSpy)

  const createdEvent = new grpcPuppet.EventResponse()
  createdEvent.setType(grpcPuppet.EventType.EVENT_TYPE_ORG_BROADCAST_CREATED)
  createdEvent.setPayload(JSON.stringify({ orgBroadcastId: 'org-broadcast-1', messageId: 'message-1' }))

  const sentEvent = new grpcPuppet.EventResponse()
  sentEvent.setType(grpcPuppet.EventType.EVENT_TYPE_ORG_BROADCAST_SENT)
  sentEvent.setPayload(JSON.stringify({ orgBroadcastId: 'org-broadcast-1' }))

  await (puppet as any).onGrpcStreamEvent(createdEvent)
  await (puppet as any).onGrpcStreamEvent(sentEvent)

  t.same(createdSpy.args[0], [ { orgBroadcastId: 'org-broadcast-1', messageId: 'message-1' } ], 'emits org-broadcast-created')
  t.same(sentSpy.args[0], [ { orgBroadcastId: 'org-broadcast-1' } ], 'emits org-broadcast-sent')
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
