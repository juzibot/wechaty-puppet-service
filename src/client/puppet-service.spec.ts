#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import {
  test,
  sinon,
}  from 'tstest'
import getPort from 'get-port'

import * as PUPPET from '@juzi/wechaty-puppet'
import { PuppetMock } from '@juzi/wechaty-puppet-mock'

import { PuppetService } from './puppet-service.js'
import { PuppetServer } from '../mod.js'

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

test('createMessageBroadcastWithBatch() forwards sendBatchId', async t => {
  const TOKEN = 'insecure_token'
  const PORT = await getPort()
  const ENDPOINT = '0.0.0.0:' + PORT
  const EXPECTED_POST_ID = 'post-id-1'
  const EXPECTED_BATCH_ID = 'batch-id-1'

  const sandbox = sinon.createSandbox()
  const puppet = new PuppetMock() as any
  puppet.createMessageBroadcastWithBatch = async () => undefined

  const createStub = sandbox.stub(puppet, 'createMessageBroadcastWithBatch').resolves(EXPECTED_POST_ID)

  const puppetServer = new PuppetServer({
    endpoint: ENDPOINT,
    puppet,
    token: TOKEN,
  })
  await puppetServer.start()

  const puppetService = new PuppetService({
    endpoint: ENDPOINT,
    token: TOKEN,
  })

  const postPayload = {
    type: PUPPET.types.Post.Broadcast,
    sayableList: [
      PUPPET.payloads.sayable.text('hello stable broadcast'),
    ],
  } as PUPPET.payloads.Post

  const result = await puppetService.createMessageBroadcastWithBatch(
    ['contact-id-1', 'room-id-1'],
    postPayload,
    EXPECTED_BATCH_ID,
  )

  t.equal(result, EXPECTED_POST_ID, 'should return the puppet post id')
  t.equal(createStub.callCount, 1, 'should call puppet batch-aware broadcast once')
  t.same(createStub.firstCall?.args, [
    ['contact-id-1', 'room-id-1'],
    postPayload,
    EXPECTED_BATCH_ID,
  ], 'should pass targets, post payload, and send batch id through grpc')

  await puppetService.stop()
  await puppetServer.stop()
  sandbox.restore()
})
