#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import {
  sinon,
  test,
}  from 'tstest'

import { FileBox } from 'file-box'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

import { PuppetMock } from '@juzi/wechaty-puppet-mock'

import { puppetImplementation } from './puppet-implementation.js'

interface CallInviteWithMediaCase {
  contactIds      : string[]
  fileBox?        : string
  hangupOnFinish? : boolean
  hangupDelayMs?  : number
}

function buildRequest (
  options: CallInviteWithMediaCase,
): grpcPuppet.CallInviteWithMediaRequest {
  const request = new grpcPuppet.CallInviteWithMediaRequest()
  request.setContactIdsList(options.contactIds)
  request.setFileBox(options.fileBox ?? '')
  request.setHangupOnFinish(options.hangupOnFinish ?? false)
  request.setHangupDelayMs(options.hangupDelayMs ?? 0)
  return request
}

async function invokeCallInviteWithMedia (
  puppet  : any,
  request : grpcPuppet.CallInviteWithMediaRequest,
): Promise<{ error: null | Error, response: null | grpcPuppet.CallInviteWithMediaResponse }> {
  const impl = puppetImplementation(puppet, FileBox)

  return new Promise(resolve => {
    void impl.callInviteWithMedia(
      { request } as any,
      ((error: any, response: any) => resolve({ error, response })) as any,
    )
  })
}

test('callInviteWithMedia rejects an empty contact_ids list', async t => {
  const puppet = new PuppetMock() as any
  const stub   = sinon.stub().resolves('call-id')
  puppet.callInviteWithMedia = stub

  const { error } = await invokeCallInviteWithMedia(puppet, buildRequest({
    contactIds     : [],
    hangupOnFinish : true,
  }))

  t.match(error?.message, /contact_ids is required/, 'reports the missing contact_ids')
  t.equal(stub.callCount, 0, 'never reaches the puppet')
})

test('callInviteWithMedia rejects an empty file_box combined with hangup_on_finish false', async t => {
  const puppet = new PuppetMock() as any
  const stub   = sinon.stub().resolves('call-id')
  puppet.callInviteWithMedia = stub

  const { error } = await invokeCallInviteWithMedia(puppet, buildRequest({
    contactIds     : [ 'contact-1' ],
    hangupOnFinish : false,
  }))

  t.match(error?.message, /use CallInvite directly/, 'points the caller at the equivalent CallInvite')
  t.equal(stub.callCount, 0, 'never reaches the puppet')
})

test('callInviteWithMedia forwards a file-less invite as an undefined file', async t => {
  const puppet = new PuppetMock() as any
  const stub   = sinon.stub().resolves('call-id-no-file')
  puppet.callInviteWithMedia = stub

  const { error, response } = await invokeCallInviteWithMedia(puppet, buildRequest({
    contactIds     : [ 'contact-1' ],
    hangupDelayMs  : 1500,
    hangupOnFinish : true,
  }))

  t.equal(error, null, 'accepts the file-less invite')
  t.equal(response?.getCallId(), 'call-id-no-file', 'returns the callId from the puppet')
  t.same(
    stub.args[0],
    [ [ 'contact-1' ], undefined, { hangupDelayMs: 1500, hangupOnFinish: true } ],
    'forwards contactIds, an undefined file and the orchestration options',
  )
})

test('callInviteWithMedia deserializes a non-empty file_box into a FileBox', async t => {
  const puppet = new PuppetMock() as any
  const stub   = sinon.stub().resolves('call-id-with-file')
  puppet.callInviteWithMedia = stub

  const file = FileBox.fromUrl('https://example.com/notice.mp3', { name: 'notice.mp3' })

  const { error } = await invokeCallInviteWithMedia(puppet, buildRequest({
    contactIds : [ 'contact-1' ],
    fileBox    : JSON.stringify(file),
  }))

  t.equal(error, null, 'accepts the invite carrying a file')
  t.equal(stub.args[0]?.[1]?.name, 'notice.mp3', 'hands the puppet a FileBox rebuilt from file_box')
})

test('callInviteWithMedia rejects an empty callId returned by the puppet', async t => {
  const puppet = new PuppetMock() as any
  puppet.callInviteWithMedia = sinon.stub().resolves('')

  const { error } = await invokeCallInviteWithMedia(puppet, buildRequest({
    contactIds     : [ 'contact-1' ],
    hangupOnFinish : true,
  }))

  t.match(error?.message, /empty callId/, 'does not pass an unusable empty callId back on the wire')
})

function invokeOrgBroadcast<Req, Res> (
  puppet  : any,
  method  : 'orgBroadcastPayload' | 'orgBroadcastExecute',
  request : Req,
): Promise<{ error: null | Error, response: null | Res }> {
  const impl = puppetImplementation(puppet, FileBox)

  return new Promise(resolve => {
    void (impl[method] as any)(
      { request } as any,
      ((error: any, response: any) => resolve({ error, response })) as any,
    )
  })
}

test('orgBroadcastPayload serializes every payload field onto the response', async t => {
  const puppet = new PuppetMock() as any
  const stub   = sinon.stub().resolves({
    id               : 'org-broadcast-1',
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
    targets          : [ { roomId: 'R:1', status: 4 }, { roomId: 'R:2', status: 1 } ],
  })
  puppet.orgBroadcastPayload = stub

  const request = new grpcPuppet.OrgBroadcastPayloadRequest()
  request.setId('org-broadcast-1')

  const { error, response } = await invokeOrgBroadcast<grpcPuppet.OrgBroadcastPayloadRequest, grpcPuppet.OrgBroadcastPayloadResponse>(puppet, 'orgBroadcastPayload', request)

  t.equal(error, null, 'returns without error')
  t.same(stub.args[0], [ 'org-broadcast-1' ], 'passes the id to the puppet')
  t.same(response?.toObject(), {
    id              : 'org-broadcast-1',
    sendType        : 2,
    conversationType: 1,
    creatorId       : 'creator-1',
    execTime        : 1758600000000,
    status          : 3,
    canCancel       : true,
    allowSelect     : true,
    sent            : false,
    totalCount      : 7,
    sentCount       : 5,
    contentListJson : '[{"contentType":2}]',
    targetsList     : [
      { contactId: '', roomId: 'R:1', status: 4 },
      { contactId: '', roomId: 'R:2', status: 1 },
    ],
  }, 'serializes every field')
})

test('orgBroadcastPayload serializes a missing creatorId and contact targets as empty strings', async t => {
  const puppet = new PuppetMock() as any
  puppet.orgBroadcastPayload = sinon.stub().resolves({
    id               : 'org-broadcast-2',
    sendType         : 0,
    conversationType : 0,
    execTime         : 0,
    status           : 0,
    canCancel        : false,
    allowSelect      : false,
    sent             : false,
    totalCount       : 1,
    sentCount        : 0,
    contentListJson  : '[]',
    targets          : [ { contactId: 'contact-1', status: 0 } ],
  })

  const request = new grpcPuppet.OrgBroadcastPayloadRequest()
  request.setId('org-broadcast-2')

  const { response } = await invokeOrgBroadcast<grpcPuppet.OrgBroadcastPayloadRequest, grpcPuppet.OrgBroadcastPayloadResponse>(puppet, 'orgBroadcastPayload', request)

  t.equal(response?.getCreatorId(), '', 'serializes a missing creatorId as empty')
  t.same(response?.getTargetsList()[0]?.toObject(), { contactId: 'contact-1', roomId: '', status: 0 }, 'leaves room_id empty for a contact target')
})

test('orgBroadcastExecute turns an empty target_ids into sending to all targets', async t => {
  const puppet = new PuppetMock() as any
  const stub   = sinon.stub().resolves()
  puppet.orgBroadcastExecute = stub

  const request = new grpcPuppet.OrgBroadcastExecuteRequest()
  request.setId('org-broadcast-1')

  const { error } = await invokeOrgBroadcast(puppet, 'orgBroadcastExecute', request)

  t.equal(error, null, 'returns without error')
  t.same(stub.args[0], [ 'org-broadcast-1', undefined ], 'omits targetIds')
})

test('orgBroadcastExecute forwards the selected target_ids', async t => {
  const puppet = new PuppetMock() as any
  const stub   = sinon.stub().resolves()
  puppet.orgBroadcastExecute = stub

  const request = new grpcPuppet.OrgBroadcastExecuteRequest()
  request.setId('org-broadcast-1')
  request.setTargetIdsList([ 'contact-1' ])

  await invokeOrgBroadcast(puppet, 'orgBroadcastExecute', request)

  t.same(stub.args[0], [ 'org-broadcast-1', [ 'contact-1' ] ], 'passes targetIds through')
})

test('orgBroadcastExecute reports a puppet failure as a grpc error', async t => {
  const puppet = new PuppetMock() as any
  puppet.orgBroadcastExecute = sinon.stub().rejects(new Error('broadcast not found'))

  const request = new grpcPuppet.OrgBroadcastExecuteRequest()
  request.setId('org-broadcast-missing')

  const { error } = await invokeOrgBroadcast(puppet, 'orgBroadcastExecute', request)

  t.match(error?.message, /broadcast not found/, 'surfaces the puppet error')
})
