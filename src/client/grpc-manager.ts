/**
 *   Wechaty Open Source Software - https://github.com/wechaty
 *
 *   @copyright 2016 Huan LI (李卓桓) <https://github.com/huan>, and
 *                   Wechaty Contributors <https://github.com/wechaty>.
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 *
 */
import EventEmitter from 'events'
import crypto from 'crypto'

import {
  log,
  type LoggerLike,
}                     from '@juzi/wechaty-puppet'
import {
  grpc,
  puppet,
}                     from '@juzi/wechaty-grpc'
import {
  WechatyToken,
  WechatyResolver,
}                     from 'wechaty-token'

import {
  GRPC_OPTIONS,
  envVars,
}                   from '../config.js'

import { callCredToken }  from '../auth/mod.js'
import { GrpcStatus }     from '../auth/grpc-js.js'
import {
  TLS_CA_CERT,
  TLS_INSECURE_SERVER_CERT_COMMON_NAME,
}                                         from '../auth/ca.js'

import type { PuppetServiceOptions } from './puppet-service.js'
import type { RecoveryGate } from './recovery.js'

/**
 * Huan(202108): register `wechaty` schema for gRPC service discovery
 *  so that we can use `wechaty:///SNI_UUIDv4` for gRPC address
 *
 *  See: https://github.com/wechaty/wechaty-puppet-service/issues/155
 */
WechatyResolver.setup()

class GrpcManager extends EventEmitter {

  protected _client?  : puppet.PuppetClient
  get       client () : puppet.PuppetClient {
    if (!this._client) {
      this.emit('error', 'NO CLIENT')
      throw new Error('NO CLIENT')
    }
    return this._client
  }

  eventStream? : grpc.ClientReadableStream<puppet.EventResponse>

  /**
   * gRPC settings
   */
  caCert     : Buffer
  disableTls : boolean
  endpoint   : string
  serverName : string
  token      : WechatyToken

  private readonly _log: LoggerLike
  private readonly lifecycleCalls = new Set<grpc.ClientUnaryCall>()
  private lifecycleStopping = false

  constructor (private options: PuppetServiceOptions, private readonly recovery?: RecoveryGate) {
    super()
    this._log = options.logger ?? log
    this._log.verbose('GrpcManager', 'constructor(%s)', JSON.stringify(options))

    this.caCert = Buffer.from(
      envVars.WECHATY_PUPPET_SERVICE_TLS_CA_CERT(this.options.tls?.caCert) || TLS_CA_CERT,
    )
    this._log.verbose('GrpcManager', 'constructor() tlsRootCert(hash): "%s"',
      crypto.createHash('sha256')
        .update(this.caCert)
        .digest('hex'),
    )

    /**
     * Token will be used in the gRPC resolver (in endpoint)
     */
    this.token = new WechatyToken(
      envVars.WECHATY_PUPPET_SERVICE_TOKEN(this.options.token),
    )
    this._log.verbose('GrpcManager', 'constructor() token: "%s"', this.token)

    this.endpoint = envVars.WECHATY_PUPPET_SERVICE_ENDPOINT(this.options.endpoint)
      /**
       * Wechaty Token Discovery-able URL
       *  See: wechaty-token / https://github.com/wechaty/wechaty-puppet-service/issues/155
       */
      || [
        'wechaty://',
        envVars.WECHATY_PUPPET_SERVICE_AUTHORITY(this.options.authority),
        '/',
        this.token,
      ].join('')
    this._log.verbose('GrpcManager', 'constructor() endpoint: "%s"', this.endpoint)

    /**
     * Disable TLS
     */
    this.disableTls = envVars.WECHATY_PUPPET_SERVICE_NO_TLS_INSECURE_CLIENT(this.options.tls?.disable)
    this._log.verbose('GrpcManager', 'constructor() disableTls: "%s"', this.disableTls)

    /**
     * for Node.js TLS SNI
     *  https://en.wikipedia.org/wiki/Server_Name_Indication
     */
    const serverNameIndication = envVars.WECHATY_PUPPET_SERVICE_TLS_SERVER_NAME(this.options.tls?.serverName)
      /**
       * Huan(202108): we use SNI from token
       *  if there is
       *    neither override from environment variable: `WECHATY_PUPPET_SERVICE_TLS_SERVER_NAME`
       *    nor set from: `options.tls.serverName`
       */
      || this.token.sni

    if (!serverNameIndication) {
      throw new Error([
        'Wechaty Puppet Service requires a SNI as prefix of the token from version 0.30 and later.',
        `You can add the "${TLS_INSECURE_SERVER_CERT_COMMON_NAME}_" prefix to your token`,
        `like: "${TLS_INSECURE_SERVER_CERT_COMMON_NAME}_${this.token}"`,
        'and try again.',
      ].join('\n'))
    }

    this.serverName = serverNameIndication
    this._log.verbose('GrpcManager', 'constructor() serverName(SNI): "%s"', this.serverName)
  }

  async start (lastEventSeq?: string, accountId?: string): Promise<void> {
    this._log.verbose('GrpcManager', 'start()')

    /**
     * 1. Init grpc client
     */
    this._log.verbose('GrpcManager', 'start() initializing client ...')
    await this.initClient()
    this._log.verbose('GrpcManager', 'start() initializing client ... done')

    /**
     * 2. Connect to stream
     */
    this._log.verbose('GrpcManager', 'start() starting stream ...')
    await this.startStream(lastEventSeq, accountId)
    if (this.streamRestartPrevented) { throw new Error('Start interrupted by restart preparation') }
    this._log.verbose('GrpcManager', 'start() starting stream ... done')

    /**
     * 3. Start the puppet
     */
    this._log.verbose('GrpcManager', 'start() calling grpc server: start() ...')
    await this.runLifecycleRpc(callback => this.client.start(new puppet.StartRequest(), new grpc.Metadata(), this.lifecycleCallOptions(), callback))
    this._log.verbose('GrpcManager', 'start() calling grpc server: start() ... done')

    this._log.verbose('GrpcManager', 'start() ... done')
  }

  async stop (): Promise<void> {
    this._log.verbose('GrpcManager', 'stop()')

    /**
     * 1. Disconnect from stream
     */
    this._log.verbose('GrpcManager', 'stop() stop stream ...')
    this.stopStream()
    this._log.verbose('GrpcManager', 'stop() stop stream ... done')

    /**
     * 2. Stop the puppet
     */
    try {
      this._log.verbose('GrpcManager', 'stop() stop client ...')
      await this.runLifecycleRpc(callback => this.client.stop(new puppet.StopRequest(), new grpc.Metadata(), this.lifecycleCallOptions(), callback), true)
      this._log.verbose('GrpcManager', 'stop() stop client ... done')
    } catch (e) {
      this.emit('error', e)
    } finally {
      // Even a throwing error listener must not prevent channel destruction.
      this.destroyClient()
    }

    this._log.verbose('GrpcManager', 'stop() ... done')
  }

  async logout (): Promise<void> {
    await this.runLifecycleRpc(callback => this.client.logout(new puppet.LogoutRequest(), new grpc.Metadata(), this.lifecycleCallOptions(), callback))
  }

  cancelLifecycleCalls (): void {
    this.lifecycleStopping = true
    for (const call of this.lifecycleCalls) { call.cancel() }
  }

  abortStartup (): void {
    this.cancelLifecycleCalls()
    try { this.stopStream({ preventRestart: true }) } finally { this.destroyClient() }
  }

  private lifecycleCallOptions (): grpc.CallOptions {
    return { deadline: Date.now() + (this.options.recovery?.controlTimeoutMilliseconds ?? 10_000) }
  }

  private async runLifecycleRpc (
    operation: (callback: (error: grpc.ServiceError | null) => void) => grpc.ClientUnaryCall,
    allowStopping = false,
  ): Promise<void> {
    if (this.lifecycleStopping && !allowStopping) { throw new Error('Manager lifecycle is stopping') }
    let call: grpc.ClientUnaryCall | undefined
    try {
      await new Promise<void>((resolve, reject): void => {
        call = operation((error): void => { error ? reject(error) : resolve() })
        this.lifecycleCalls.add(call)
      })
    } finally {
      if (call) { this.lifecycleCalls.delete(call) }
    }
  }

  protected async initClient (): Promise<void> {
    this._log.verbose('GrpcManager', 'initClient()')

    /**
     * Huan(202108): for maximum compatible with the non-tls community servers/clients,
     *  we introduced the WECHATY_PUPPET_SERVICE_NO_TLS_INSECURE_{SERVER,CLIENT} environment variables.
     *  if it has been set, then we will run under HTTP instead of HTTPS
     */
    let credential
    if (this.disableTls) {
      this._log.warn('GrpcManager', 'initClient() TLS: disabled (INSECURE)')
      credential = grpc.credentials.createInsecure()
    } else {
      this._log.verbose('GrpcManager', 'initClient() TLS: enabled')
      const callCred    = callCredToken(this.token.token)
      const channelCred = grpc.credentials.createSsl(this.caCert)
      const combCreds   = grpc.credentials.combineChannelCredentials(channelCred, callCred)

      credential = combCreds
    }

    const clientOptions: grpc.ChannelOptions = {
      ...GRPC_OPTIONS,
      'grpc.ssl_target_name_override': this.serverName,
      ...(this.recovery?.enabled ? { interceptors: [ this.recovery.interceptor ], 'grpc.enable_retries': 0 } : {}),
    }

    {
      // Deprecated: this block will be removed after Dec 21, 2022.

      /**
       * Huan(202108): `grpc.default_authority` is a workaround
       *  for compatiblity with the non-tls community servers/clients.
       *
       * See: https://github.com/wechaty/wechaty-puppet-service/pull/78
       */
      const grpcDefaultAuthority = this.token.token
      clientOptions['grpc.default_authority'] = grpcDefaultAuthority
    }

    if (this._client) {
      this._log.warn('GrpcManager', 'initClient() this.#client exists? Old client has been dropped.')
      this._client = undefined
    }

    this._client = new puppet.PuppetClient(
      this.endpoint,
      credential,
      clientOptions,
    )

    this._log.verbose('GrpcManager', 'initClient() ... done')
  }

  protected destroyClient (): void {
    this._log.verbose('GrpcManager', 'destroyClient()')

    if (!this._client) {
      this._log.warn('GrpcManager', 'destroyClient() this.#client not exist')
      return
    }

    const client = this._client
    /**
      * Huan(202108): we should set `this.client` to `undefined` at the current event loop
      *   to prevent the future usage of the old client.
      */
    this._client = undefined

    try {
      client.close()
    } catch (e) {
      this._log.error('GrpcManager', 'destroyClient() client.close() rejection: %s\n%s', e && (e as Error).message, (e as Error).stack)
    }
  }

  private streamRestartPrevented = false

  async startStream (lastEventSeq?: string, accountId?: string): Promise<void> {
    if (this.streamRestartPrevented) { throw new Error('Event stream disabled for restart') }
    if (this.recovery?.enabled) {
      return this.startRecoveryStream(lastEventSeq, accountId)
    }
    this._log.verbose('GrpcManager', 'startStream()')

    if (this.eventStream) {
      this._log.verbose('GrpcManager', 'startStream() this.eventStream exists, dropped.')
      this.eventStream = undefined
    }

    this._log.verbose('GrpcManager', 'startStream() grpc -> event() ...')

    const eventRequest = new puppet.EventRequest()
    if (lastEventSeq) {
      eventRequest.setSeq(Number(lastEventSeq))
    }
    if (accountId) {
      eventRequest.setAccountId(accountId)
    }
    this._log.info('GrpcManager', `startStream() connecting event stream with account ${accountId} and seq ${lastEventSeq}`)

    const eventStream = this.client.event(eventRequest)
    this.eventStream = eventStream
    this._log.verbose('GrpcManager', 'startStream() grpc -> event() ... done')

    /**
     * Store the event data from the stream when we test connection,
     *  and re-emit the event data when we have finished testing the connection
     */
    let peekedData: undefined | puppet.EventResponse

    /**
     * Huan(202108): future must be placed before other listenser registration
     *  because the on('data') will start drain the stream
     */
    const future = new Promise<void>((resolve, reject) => eventStream
      /**
       * Huan(202108): we need a `heartbeat` event to confirm the connection is alive
       *  for our wechaty-puppet-service server code, when the gRPC event stream is opened,
       *  it will emit a `heartbeat` event as early as possible.
       *
       * However, the `heartbeat` event is not guaranteed to be emitted,
       *  if the puppet service provider is coming from the community, like:
       *    - paimon
       *
       * So we also need a timeout for compatible with those providers
       *  in case of they are not following this special protocol.
       */
      .once('data', (resp: puppet.EventResponse) => {
        peekedData = resp
        resolve()
      })
      /**
       * Any of the following events will be emitted means that there's a problem.
       */
      .once('cancel', (): void => { reject(new Error('Event stream cancelled before connection')) })
      .once('close',  (): void => { reject(new Error('Event stream closed before connection')) })
      .once('end',    (): void => { reject(new Error('Event stream ended before connection')) })
      .once('error',  reject)
      /**
       * The `status` event is import when we connect a gRPC stream.
       *
       * Huan(202108): according to the unit tests (tests/grpc-client.spec.ts)
       *  1. If client TLS is not ok (client no-tls but server TLS is required)
       *    then status will be:
       *      { code: 14, details: 'Connection dropped' }
       *  2. If client TLS is ok but the client token is invalid,
       *    then status will be:
       *      { code: 16, details: 'Invalid Wechaty TOKEN "0.XXX"' }
       */
      .once('status',   status => {
        // console.info('once(status)', status)
        reject(new Error(status.code === GrpcStatus.OK ? 'Event stream ended before connection' : `Event stream failed: ${status.details}`))
      }),
      /**
       * Huan(202108): `metadata` event will be fired
       *  when the TLS connection is OK
       *    even if the token is invalid
       *
       * Conclusion: we MUST NOT listen on `metadata` for `resolve`.
       */
      // .once('metadata', (...args) => console.info('once(metadata)', ...args))
    )

    /**
     * Huan(202108): the `heartbeat` event is not guaranteed to be emitted
     *  if a puppet service provider is coming from the community, it might not follow the protocol specification.
     * So we need a timeout for compatible with those providers
     */
    this._log.verbose('GrpcManager', 'startStream() grpc -> event peeking data or timeout ...')
    let peekTimer: NodeJS.Timeout | undefined
    try {
      // Legacy providers may omit the initial heartbeat, but explicit stream failures are never readiness.
      await Promise.race([ future, new Promise<void>(resolve => { peekTimer = setTimeout(resolve, 5000) }) ])
    } catch (error) {
      eventStream.cancel()
      throw error
    } finally {
      clearTimeout(peekTimer)
    }
    if (this.eventStream !== eventStream) { throw new Error('Event stream superseded') }
    this._log.verbose('GrpcManager', 'startStream() grpc -> event peeking data or timeout ... data peeked')

    /**
     * Bridge the events
     * Huan(202108): adding the below event listeners
     *  must be after the `await future` above,
     *  so that if there's any `error` event,
     *  it will be triggered already.
     */
    this._log.verbose('GrpcManager', 'startStream() initializing event stream ...')
    eventStream
      .on('cancel',   (...args) => this.emit('cancel',    ...args))
      .on('data',     (...args) => this.emit('data',      ...args))
      .on('end',      (...args) => this.emit('end',       ...args))
      .on('error',    (...args) => this.emit('error',     ...args))
      .on('metadata', (...args) => this.emit('metadata',  ...args))
      .on('status',   (...args) => this.emit('status',    ...args))

    this.eventStream = eventStream
    this._log.verbose('GrpcManager', 'startStream() initializing event stream ... done')

    /**
     * Re-emit the peeked data if there' s any
     */
    if (peekedData) {
      this._log.verbose('GrpcManager', 'startStream() sending back the peeked data ...')
      this.emit('data', peekedData)
      peekedData = undefined
      this._log.verbose('GrpcManager', 'startStream() sending back the peeked data ... done')
    }

    this._log.verbose('GrpcManager', 'startStream() ... done')
  }

  private async startRecoveryStream (lastEventSeq?: string, accountId?: string): Promise<void> {
    this.stopStream()
    const request = new puppet.EventRequest()
    request.setReplayBarrier(true)
    if (lastEventSeq) { request.setSeq(Number(lastEventSeq)) }
    if (accountId) { request.setAccountId(accountId) }
    const stream = this.client.event(request)
    this.eventStream = stream
    await new Promise<void>((resolve, reject): void => {
      let connected = false
      const timer = setTimeout((): void => {
        if (connected) { return }
        reject(new Error('Event stream connection timed out'))
        if (this.eventStream === stream) { this.stopStream() }
      }, 5000)
      const fail = (error: unknown): void => {
        clearTimeout(timer)
        if (this.eventStream !== stream) { return }
        reject(error instanceof Error ? error : new Error('Event stream ended'))
        this.emit('error', error instanceof Error ? error : new Error('Event stream ended'))
      }
      stream.on('data', (event: puppet.EventResponse): void => {
        if (this.eventStream !== stream) { return }
        connected = true
        clearTimeout(timer)
        resolve()
        this.emit('data', event)
      })
      stream.on('error', fail)
      stream.on('end', (): void => { fail(new Error('Event stream ended')) })
      stream.on('status', (status: grpc.StatusObject): void => {
        if (status.code !== grpc.status.OK) { fail(new Error(status.details)) }
      })
      stream.once('close', (): void => { clearTimeout(timer); if (!connected) { reject(new Error('Event stream closed')) } })
    })
  }

  stopStream (options: { throwOnError?: boolean, preventRestart?: boolean } = {}): void {
    if (options.preventRestart) { this.streamRestartPrevented = true }
    this._log.verbose('GrpcManager', 'stopStream()')

    if (!this.eventStream) {
      this._log.verbose('GrpcManager', 'stopStream() no eventStream when stop, skip destroy.')
      return
    }
    /**
      * Huan(202108): we should set `this.eventStream` to `undefined` at the current event loop
      *   to prevent the future usage of the old eventStream.
      */
    const eventStream = this.eventStream
    this.eventStream = undefined

    /**
     * Huan(202003):
     *  destroy() will be enough to terminate a stream call.
     *  cancel() is not needed.
     */
    // this.eventStream.cancel()

    try {
      this._log.verbose('GrpcManager', 'stopStream() destroying event stream ...')
      if (this.recovery?.enabled) { eventStream.cancel() }
      eventStream.destroy()
      this._log.verbose('GrpcManager', 'stopStream() destroying event stream ... done')
    } catch (e) {
      if (options.throwOnError) { throw e }
      this.emit('error', e)
    }
  }

}

export {
  GrpcManager,
}
