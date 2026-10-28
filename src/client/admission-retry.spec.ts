import assert from 'node:assert/strict'
import util from 'node:util'

import { grpc, puppet } from '@juzi/wechaty-grpc'
import { test } from 'tstest'

import { RecoveryGate, withRecoveryRequestContext } from './recovery.js'

type SendHandler = grpc.handleUnaryCall<puppet.MessageSendTextRequest, puppet.MessageSendTextResponse>

function rejectedMetadata (state = 'not-submitted', capability = 'admission-reject-v1'): grpc.Metadata {
  const metadata = new grpc.Metadata()
  if (state) { metadata.set('x-juzi-request-state', state) }
  if (capability) { metadata.set('x-juzi-recovery-capability', capability) }
  return metadata
}

function ready (gate: RecoveryGate): void {
  gate.login('account'); gate.ready(); gate.barrier('account')
}

async function fixture (gate: RecoveryGate, handler: SendHandler): Promise<{ client: puppet.PuppetClient, close(): void }> {
  const server = new grpc.Server()
  server.addService(puppet.PuppetService, { messageSendText: handler })
  const port = await new Promise<number>((resolve, reject): void => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value): void => { error ? reject(error) : resolve(value) })
  })
  const client = new puppet.PuppetClient(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), { interceptors: [ gate.interceptor ], 'grpc.enable_retries': 0 })
  gate.begin('account'); ready(gate)
  return { client, close: (): void => { gate.fail('test cleanup'); client.close(); server.forceShutdown() } }
}

test('opt-in unary retries only proven unsubmitted attempts and preserves the payload', async t => {
  const gate = new RecoveryGate({ enabled: true })
  let attempts = 0
  let executions = 0
  const capabilities: unknown[] = []
  const received: string[] = []
  const request = new puppet.MessageSendTextRequest(); request.setText('original')
  const endpoint = await fixture(gate, (call, callback): void => {
    attempts++
    capabilities.push(call.metadata.get('x-juzi-recovery-capability'))
    received.push(call.request.getText())
    if (attempts <= 2) {
      gate.begin('account')
      callback({ code: grpc.status.UNAVAILABLE, details: 'not admitted', metadata: rejectedMetadata() })
      request.setText('mutated after first attempt')
      setTimeout((): void => { ready(gate) }, 20)
      return
    }
    executions++
    const result = new puppet.MessageSendTextResponse(); result.setId('executed')
    callback(null, result)
  })
  try {
    const response = await withRecoveryRequestContext({ deadline: Date.now() + 2000 }, async (): Promise<puppet.MessageSendTextResponse> => util.promisify(endpoint.client.messageSendText.bind(endpoint.client))(request))
    assert.equal(response.getId(), 'executed')
    assert.equal(attempts, 3)
    assert.equal(executions, 1)
    assert.deepEqual(capabilities, Array.from({ length: 3 }, (): string[] => [ 'admission-reject-v1' ]))
    assert.deepEqual(received, [ 'original', 'original', 'original' ])
    t.pass('multiple non-admissions lead to one business execution')
  } finally { endpoint.close() }
})
