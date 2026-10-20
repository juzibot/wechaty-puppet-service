#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { test }  from 'tstest'
import {
  grpc,
  puppet as grpcPuppet,
}                 from '@juzi/wechaty-grpc'
import getPort    from 'get-port'

import { GRPC_STOP_TIMEOUT_MILLISECONDS } from '../config.js'

import { GrpcManager } from './grpc-manager.js'

/**
 * Huan(202108):
 *  the Server Name Identifier (SNI) in the token
 *    is required by the gRPC client.
 */
test('GrpcManager smoke testing', async t => {
  t.throws(() => new GrpcManager({
    token: 'UUIDv4',
  }), 'should throw if there is no SNI prefix in token')

  t.doesNotThrow(() => new GrpcManager({
    token: 'SNI_UUIDv4',
  }), 'should not throw if there is SNI prefix in token')
})

async function startStopServer (onStop: grpc.handleUnaryCall<grpcPuppet.StopRequest, grpcPuppet.StopResponse>) {
  const port   = await getPort()
  const server = new grpc.Server()
  server.addService(grpcPuppet.PuppetService, { stop: onStop } as any)
  await new Promise<void>((resolve, reject) => server.bindAsync(
    `127.0.0.1:${port}`,
    grpc.ServerCredentials.createInsecure(),
    error => error ? reject(error) : resolve(),
  ))
  server.start()
  return { port, server }
}

function createManager (port: number) {
  const manager = new GrpcManager({
    endpoint : `127.0.0.1:${port}`,
    tls      : { disable: true },
    token    : 'insecure_00000000-0000-0000-0000-000000000000',
  })
  const errors: unknown[] = []
  manager.on('error', error => errors.push(error))
  return { errors, manager }
}

test('GrpcManager.stop() is bounded when the server never answers Stop', async t => {
  let stopCalls = 0
  const { port, server } = await startStopServer(() => {
    // Accept the call and never answer, like a server stuck while handling Stop
    stopCalls++
  })
  const { errors, manager } = createManager(port)

  try {
    await (manager as any).initClient()

    const startedAt = Date.now()
    await manager.stop()
    const elapsed = Date.now() - startedAt

    t.equal(stopCalls, 1, 'should reach the server')
    t.ok(elapsed >= GRPC_STOP_TIMEOUT_MILLISECONDS - 100, `should wait for the deadline (${elapsed}ms)`)
    t.ok(elapsed < GRPC_STOP_TIMEOUT_MILLISECONDS + 2000, `should not hang beyond the deadline (${elapsed}ms)`)
    t.equal(errors.length, 1, 'should report the timed out Stop')
    t.equal((errors[0] as grpc.ServiceError).code, grpc.status.DEADLINE_EXCEEDED, 'should fail with DEADLINE_EXCEEDED')
    t.throws(() => manager.client, 'should destroy the client even if Stop timed out')
  } finally {
    server.forceShutdown()
  }
})

test('GrpcManager.stop() resolves without error when the server answers Stop', async t => {
  const { port, server } = await startStopServer((_call, callback) => {
    callback(null, new grpcPuppet.StopResponse())
  })
  const { errors, manager } = createManager(port)

  try {
    await (manager as any).initClient()
    await manager.stop()

    t.same(errors, [], 'should not report any error')
    t.throws(() => manager.client, 'should destroy the client')
  } finally {
    server.forceShutdown()
  }
})
