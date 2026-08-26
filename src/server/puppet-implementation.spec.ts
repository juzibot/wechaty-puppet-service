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
