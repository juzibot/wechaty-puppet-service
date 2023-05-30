#!/usr/bin/env -S node --no-warnings --loader ts-node/esm
/**
 * @hcfw007, https://wechaty.js.org/contributors/wang-nan/
 * related issue: attempt to reconnect gRPC after disconnection
 * Scenario: the watchdog tries to restart the service but failed due to the existence of eventstream
 * Caused by the grpcClient set to undefined (still working on why this happens) while eventstream still working
 * issue: #172, https://github.com/wechaty/puppet-service/issues/172
 *
 * NodeJS: How Is Logging Enabled for the @grpc/grpc.js Package
 *  https://stackoverflow.com/a/60935367/1123955
 *    GRPC_VERBOSITY=DEBUG GRPC_TRACE=all
 */
/// <reference path="./typings.d.ts" />

import {
  test,
  sinon,
}                             from 'tstest'
import type {
  PuppetOptions,
}                             from '@juzi/wechaty-puppet'
import {
  PuppetMock,
}                             from '@juzi/wechaty-puppet-mock'
import getPort                from 'get-port'
// import whyIsNodeRunning       from 'why-is-node-running'

import {
  PuppetService,
  PuppetServer,
  PuppetServerOptions,
}                             from '../src/mod.js'

test('gRPC client breaks', async t => {
  /**
   * Huan(202110):
   * `insecure_` prefix is required for the TLS version of Puppet Service
   *  because the `insecure` will be the SNI name of the Puppet Service
   *  and it will be enforced for the security (required by TLS)
   */
  const TOKEN       = 'insecure_token'
  const PORT        = await getPort()
  const ENDPOINT    = '0.0.0.0:' + PORT

  const puppet = new PuppetMock() as any
  const spyOnStart = sinon.spy(puppet, 'onStart')
  /**
   * Puppet Server
   */
  const serverOptions = {
    endpoint: ENDPOINT,
    puppet,
    token: TOKEN,
  } as PuppetServerOptions

  const puppetServer = new PuppetServer(serverOptions)
  await puppetServer.start()

  /**
   * Puppet Service Client
   */
  const puppetOptions = {
    endpoint: ENDPOINT,
    token: TOKEN,
  } as PuppetOptions

  const puppetService = new PuppetService(puppetOptions)
  await puppetService.start()
  t.ok(spyOnStart.called, 'should called the puppet server onStart() function')

  puppetService.on('error', console.error)

  /**
   * mock grpcClient break
   */
  await puppetService.grpcManager.client.close()

  await puppetService.stop()

  // get eventStream status
  t.throws(() => puppetService.grpcManager, 'should clean grpc after stop()')

  // setTimeout(() => whyIsNodeRunning(), 1000)
  await puppetServer.stop()
})

test('gRPC event quick reconnect', async t => {
  const TOKEN       = 'insecure_token2'
  const PORT        = await getPort()
  const ENDPOINT    = '0.0.0.0:' + PORT

  const puppet = new PuppetMock() as any
  const spyOnStart = sinon.spy(puppet, 'onStart')
  /**
    * Puppet Server
    */
  const serverOptions = {
    endpoint: ENDPOINT,
    puppet,
    token: TOKEN,
  } as PuppetServerOptions

  const puppetServer = new PuppetServer(serverOptions)
  await puppetServer.start()

  /**
    * Puppet Service Client
    */
  const puppetOptions = {
    endpoint: ENDPOINT,
    token: TOKEN,
  } as PuppetOptions

  const puppetService = new PuppetService(puppetOptions)
  await puppetService.start()
  t.ok(spyOnStart.called, 'should called the puppet server onStart() function')

  // wait for login handling
  const future = new Promise<void>(resolve => {
    puppetService.once('login', () => {
      resolve()
    })
  })
  puppet.login('account')

  await future
  puppetService.on('login', () => {
    t.fail('should not emit another login event because this should be a pain free reset')
  })
  puppetService.on('logout', (data) => {
    if (data.data !== 'puppet stop()') { // this is the one called when puppetService.stop()
      t.fail('should not emit another logout event because this should be a pain free reset')
    }
  })
  await puppetService.reset()

  // setTimeout(() => whyIsNodeRunning(), 1000)
  await puppetService.stop()
  await puppetServer.stop()
})
