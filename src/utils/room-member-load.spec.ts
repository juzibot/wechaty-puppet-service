import { test } from 'tstest'
import * as PUPPET from '@juzi/wechaty-puppet'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

import {
  roomPayloadToPb,
  roomPbToPayload,
  roomMemberLoadStateToPb,
  roomMemberLoadStatePbToPayload,
  validateRoomMemberSnapshot,
} from './pb-payload-helper.js'

test('room payload roundtrip retains lazy fields and timestamp zero', async t => {
  const payload: PUPPET.payloads.Room = {
    id: 'room',
    topic: 'topic',
    adminIdList: [],
    memberIdList: [],
    memberCount: 0,
    memberLoadMode: PUPPET.types.RoomMemberLoadMode.Lazy,
    memberLoadStatus: PUPPET.types.RoomMemberLoadStatus.Loaded,
    memberLoadRevision: '9007199254740993',
    memberLoadedAt: 0,
  }
  const result = roomPbToPayload(roomPayloadToPb(payload))
  t.equal(result.memberCount, 0)
  t.equal(result.memberLoadMode, payload.memberLoadMode)
  t.equal(result.memberLoadStatus, payload.memberLoadStatus)
  t.equal(result.memberLoadRevision, payload.memberLoadRevision)
  t.equal(result.memberLoadedAt, 0)
  const legacy = roomPbToPayload(new grpcPuppet.RoomPayloadResponse())
  t.equal(legacy.memberLoadMode, PUPPET.types.RoomMemberLoadMode.Unspecified)
  t.equal(legacy.memberLoadedAt, undefined)
})

test('load state preserves exact revision and rejects invalid responses', async t => {
  const state: PUPPET.payloads.RoomMemberLoadState = {
    roomId: 'room',
    taskId: 'task',
    status: PUPPET.types.RoomMemberLoadStatus.Pending,
    revision: '9007199254740993',
    loadedAt: 0,
  }
  t.same(roomMemberLoadStatePbToPayload(roomMemberLoadStateToPb(state), 'room'), state)
  t.throws(() => roomMemberLoadStatePbToPayload(roomMemberLoadStateToPb(state), 'other'), /roomId/)
  t.throws(() => roomMemberLoadStateToPb({ ...state, revision: '01' }), /revision/)
  t.throws(() => roomMemberLoadStateToPb({ ...state, status: 99 }), /status/)
  const response = roomMemberLoadStateToPb(state)
  response.setStatus(99 as Parameters<typeof response.setStatus>[0])
  t.throws(() => roomMemberLoadStatePbToPayload(response, 'room'), /status/)
  response.setStatus(state.status)
  response.setRevision('01')
  t.throws(() => roomMemberLoadStatePbToPayload(response, 'room'), /revision/)
  const failed: PUPPET.payloads.RoomMemberLoadState = {
    ...state, status: PUPPET.types.RoomMemberLoadStatus.Failed, error: 'load failed',
  }
  t.same(roomMemberLoadStatePbToPayload(roomMemberLoadStateToPb(failed), 'room'), failed)
})

test('snapshot must match both room and requested revision', async t => {
  const snapshot: PUPPET.payloads.RoomMemberSnapshot = {
    roomId: 'room', revision: '2', members: [], nextPageToken: 'next',
  }
  t.doesNotThrow(() => validateRoomMemberSnapshot(snapshot, 'room', '2'))
  t.throws(() => validateRoomMemberSnapshot(snapshot, 'room', '1'), /revision/)
  t.throws(() => validateRoomMemberSnapshot(snapshot, 'other', '2'), /roomId/)
})
