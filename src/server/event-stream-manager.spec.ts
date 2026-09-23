#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import {
  sinon,
  test,
}  from 'tstest'

import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'
import { PuppetMock } from '@juzi/wechaty-puppet-mock'

import { EventStreamManager } from './event-stream-manager.js'

test('org broadcast puppet events are forwarded as their own grpc event types', async t => {
  const puppet  = new PuppetMock() as any
  const manager = new EventStreamManager(puppet)

  const write = sinon.spy()
  ;(manager as any).eventStream = { write }
  manager.connectPuppetEventToStreamingCall()

  puppet.emit('org-broadcast-created', { orgBroadcastId: 'org-broadcast-1', messageId: 'message-1' })
  puppet.emit('org-broadcast-sent', { orgBroadcastId: 'org-broadcast-1' })

  const [ created, sent ] = write.args.map(args => args[0] as grpcPuppet.EventResponse)

  t.equal(created?.getType(), grpcPuppet.EventType.EVENT_TYPE_ORG_BROADCAST_CREATED, 'forwards org-broadcast-created as EVENT_TYPE_ORG_BROADCAST_CREATED')
  t.same(JSON.parse(created!.getPayload()), { orgBroadcastId: 'org-broadcast-1', messageId: 'message-1' }, 'keeps the created payload')
  t.equal(sent?.getType(), grpcPuppet.EventType.EVENT_TYPE_ORG_BROADCAST_SENT, 'forwards org-broadcast-sent as EVENT_TYPE_ORG_BROADCAST_SENT')
  t.same(JSON.parse(sent!.getPayload()), { orgBroadcastId: 'org-broadcast-1' }, 'keeps the sent payload')
})
