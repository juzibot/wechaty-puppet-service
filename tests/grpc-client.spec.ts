#!/usr/bin/env ts-node

import { test }  from 'tstest'
import { PuppetOptions } from 'wechaty-puppet'
import PuppetMock from 'wechaty-puppet-mock'

import { log } from '../src/config'

import { GrpcClient }   from '../src/client/grpc-client'
import {
  PuppetServer,
  PuppetServerOptions,
}                       from '../src/mod'

test('GrpcClient with SSL and valid token', async t => {
  const TOKEN         = '__test_token__'
  const ENDPOINT      = '0.0.0.0:8788'

  /**
   * Puppet Server
   */
  const serverOptions = {
    endpoint : ENDPOINT,
    puppet   : new PuppetMock(),
    token    : TOKEN,
  } as PuppetServerOptions

  const puppetServer = new PuppetServer(serverOptions)
  await puppetServer.start()

  /**
   * Puppet Service Client
   */
  const puppetOptions = {
    endpoint : ENDPOINT,
    token    : TOKEN,
  } as PuppetOptions

  const invalidTokenPuppet = new GrpcClient(puppetOptions)

  try {
    await invalidTokenPuppet.start()
    t.pass('should work with SSL and valid token')
  } catch (e) {
    t.fail('should not reject for a valid token & ssl')
  } finally {
    try { await invalidTokenPuppet.stop() } catch (_) {}
  }

  await puppetServer.stop()
})

test('GrpcClient with invalid SSL options', async t => {
  const TOKEN    = '__test_token__'
  const ENDPOINT = '0.0.0.0:8788'

  /**
   * Puppet Server
   */
  const serverOptions = {
    endpoint : ENDPOINT,
    puppet   : new PuppetMock(),
    token    : TOKEN,
  } as PuppetServerOptions

  const puppetServer = new PuppetServer(serverOptions)
  await puppetServer.start()

  /**
   * Grpc Client
   */
  const puppetOptions = {
    endpoint    : ENDPOINT,
    noSslUnsafe : true,
    token       : TOKEN,
  } as PuppetOptions

  const grpcClient = new GrpcClient(puppetOptions)
  grpcClient.on('error', e => console.info('###noSslPuppet.on(error):', e))

  // Disable error log
  const level = log.level()
  log.level('silent')

  try {
    await grpcClient.start()
    t.fail('should throw for no-ssl client to ssl-server instead of not running to here')
  } catch (e) {
    t.pass('should throw for non-ssl client to ssl-server with noSslUnsafe: true')
  } finally {
    log.level(level)
    try { await grpcClient.stop() } catch (_) {}
  }

  await puppetServer.stop()
})

test('GrpcClient with invalid token', async t => {
  const endpoint = '0.0.0.0:8788'
  /**
   * Puppet Server
   */
  const serverOptions = {
    endpoint,
    puppet: new PuppetMock(),
    token: '__token__',
  } as PuppetServerOptions

  const puppetServer = new PuppetServer(serverOptions)
  await puppetServer.start()

  /**
   * Puppet Service Client
   */
  const puppetOptions = {
    endpoint,
    /**
     * Put a random token for invalid the client token
     *  https://stackoverflow.com/a/8084248/1123955
     */
    token: Math.random().toString(36),
  } as PuppetOptions

  const invalidTokenPuppet = new GrpcClient(puppetOptions)

  try {
    await invalidTokenPuppet.start()
    t.fail('should throw for invalid token instead of not running to here')
  } catch (e) {
    t.pass('should throw for invalid random token')
  } finally {
    try { await invalidTokenPuppet.stop() } catch (_) {}
  }

  await puppetServer.stop()
})
