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
import util               from 'util'
import * as PUPPET        from '@juzi/wechaty-puppet'

import type {
  FileBoxInterface,
  FileBox,
}                         from 'file-box'
import {
  StringValue,
  puppet as grpcPuppet,
}                         from '@juzi/wechaty-grpc'

// import type { Subscription }  from 'rxjs'

import { millisecondsFromTimestamp }  from '../pure-functions/timestamp.js'

import {
  uuidifyFileBoxGrpc,
  normalizeFileBoxUuid,
}                       from '../file-box-helper/mod.js'
import {
  envVars,
  log,
  NO_LOG_EVENTS,
  VERSION,
}                       from '../config.js'
import {
  EventTypeRev,
}                       from '../event-type-rev.js'
import { packageJson }  from '../package-json.js'

import { GrpcManager }  from './grpc-manager.js'
import { PayloadStore } from './payload-store.js'
import { OptionalBooleanUnwrapper, OptionalBooleanWrapper, callRecordPbToPayload, channelPayloadToPb, channelPbToPayload, chatHistoryPbToPayload, contactPbToPayload, postPayloadToPb, roomMemberPbToPayload, urlLinkPbToPayload } from '../utils/pb-payload-helper.js'
import type { MessageBroadcastTargets } from '@juzi/wechaty-puppet/dist/esm/src/schemas/message.js'
import { timeoutPromise } from 'gerror'
import { BooleanIndicator } from 'state-switch'
import type { Contact } from '@juzi/wechaty-puppet/types'

export type PuppetServiceOptions = PUPPET.PuppetOptions & {
  authority?  : string
  tls?: {
    caCert?     : string
    serverName? : string
    /**
     * Huan(202108): only for compatible with old clients/servers
     *  for disabling TLS
     */
    disable? : boolean
  }
}

const ResetLoginTimeout = 30 * 1000
const ResetReadyTimeout = 20 * 1000 // normally ready comes 15 seconds after login

class PuppetService extends PUPPET.Puppet {

  static override readonly VERSION = VERSION

  protected _payloadStore: PayloadStore

  private timeoutMilliseconds: number

  protected _grpcManager?: GrpcManager
  get grpcManager (): GrpcManager {
    if (!this._grpcManager) {
      this.emit('error', 'no grpc manager')
      throw new Error('no grpc manager')
    }
    return this._grpcManager
  }

  /**
   * UUIDify:
   *  We need to clone a FileBox
   *  to set uuid loader/saver with this grpc client
   */
  protected FileBoxUuid: typeof FileBox

  constructor (
    public override options: PuppetServiceOptions = {},
  ) {
    super(options)
    this._payloadStore = new PayloadStore({
      token: envVars.WECHATY_PUPPET_SERVICE_TOKEN(this.options.token),
    })

    this.hookPayloadStore()

    this.FileBoxUuid = uuidifyFileBoxGrpc(() => this.grpcManager.client)
    this.timeoutMilliseconds = (options.timeoutSeconds || 2) * 1000 * 60 // 2 hours default, 4 hours for xiaoju-bot

    this.reconnectIndicator = new BooleanIndicator()
    this.reconnectIndicator.value(false)
  }

  protected async serializeFileBox (fileBox: FileBoxInterface): Promise<string> {
    /**
     * 1. if the fileBox is one of type `Url`, `QRCode`, `Uuid`, etc,
     *  then it can be serialized by `fileBox.toString()`
     * 2. if the fileBox is one of type `Stream`, `Buffer`, `File`, etc,
     *  then it need to be convert to type `Uuid`
     *  before serialized by `fileBox.toString()`
     */
    const normalizedFileBox = await normalizeFileBoxUuid(this.FileBoxUuid)(fileBox)
    return JSON.stringify(normalizedFileBox)
  }

  override name () {
    return packageJson.name || 'wechaty-puppet-service'
  }

  override version () {
    return packageJson.version || '0.0.0'
  }

  override async onStart (): Promise<void> {
    log.verbose('PuppetService', 'onStart()')

    this.waitingForLogin = false
    this.waitingForReady = false

    if (this._grpcManager) {
      log.warn('PuppetService', 'onStart() found this.grpc is already existed. dropped.')
      this._grpcManager = undefined
    }

    log.info('PuppetService', 'start() instanciating GrpcManager ...')
    const grpcManager = new GrpcManager(this.options)
    log.info('PuppetService', 'start() instanciating GrpcManager ... done')

    /**
     * Huan(202108): when we started the event stream,
     *  the `this.grpc` need to be available for all listeners.
     */
    this._grpcManager = grpcManager

    log.info('PuppetService', 'start() setting up bridge grpc event stream ...')
    this.bridgeGrpcEventStream(grpcManager)
    log.info('PuppetService', 'start() setting up bridge grpc event stream ... done')

    log.info('PuppetService', 'start() starting grpc manager...')
    const { lastEventSeq, accountId } = await this.getMiscellaneousStoreData()
    await grpcManager.start(lastEventSeq, accountId)
    log.info('PuppetService', 'start() starting grpc manager... done')

    log.info('PuppetService', 'start healthCheck')
    this.startHealthCheck()

    log.info('PuppetService', 'onStart() ... done')
  }

  override async onStop (): Promise<void> {
    log.info('PuppetService', 'onStop()')

    if (this._grpcManager) {
      log.info('PuppetService', 'onStop() stopping grpc manager ...')
      const grpcManager = this._grpcManager
      this._grpcManager = undefined
      await grpcManager.stop()
      log.info('PuppetService', 'onStop() stopping grpc manager ... done')
    }

    log.info('PuppetService', 'onStop() ... done')
    log.info('PuppetService', 'stop healthCheck')
    this.stopHealthCheck()
  }

  protected hookPayloadStore (): void {
    log.verbose('PuppetService', 'hookPayloadStore()')

    this.on('login',  async ({ contactId }) => {
      try {
        log.verbose('PuppetService', 'hookPayloadStore() this.on(login) contactId: "%s"', contactId)
        await this._payloadStore.start(contactId)
      } catch (e) {
        log.verbose('PuppetService', 'hookPayloadStore() this.on(login) rejection "%s"', (e as Error).message)
      }
    })

    this.on('logout', async ({ contactId }) => {
      log.verbose('PuppetService', 'hookPayloadStore() this.on(logout) contactId: "%s"', contactId)
      try {
        await this._payloadStore.stop()
      } catch (e) {
        log.verbose('PuppetService', 'hookPayloadStore() this.on(logout) rejection "%s"', (e as Error).message)
      }
    })
  }

  protected bridgeGrpcEventStream (client: GrpcManager): void {
    log.verbose('PuppetService', 'bridgeGrpcEventStream(client)')

    client
      .on('data', this.onGrpcStreamEvent.bind(this) as any)
      .on('end', () => {
        log.verbose('PuppetService', 'bridgeGrpcEventStream() eventStream.on(end)')
      })
      .on('error', (e: unknown) => {
        this.emit('error', e)
        // https://github.com/wechaty/wechaty-puppet-service/issues/16
        // log.verbose('PuppetService', 'bridgeGrpcEventStream() eventStream.on(error) %s', e)
        // const reason = 'bridgeGrpcEventStream() eventStream.on(error) ' + e
        /**
         * Huan(202110): simple reset puppet when grpc client has error? (or not?)
         */
        // this.wrapAsync(this.reset())
        // /**
        //  * The `Puppet` class have a throttleQueue for receiving the `reset` events
        //  *  and it's the `Puppet` class's duty for call the `puppet.reset()` to reset the puppet.
        //  */
        // if (this.state.on()) {
        //   this.emit('reset', { data: reason })
        // }
      })
      .on('cancel', (...args: any[]) => {
        log.verbose('PuppetService', 'bridgeGrpcEventStream() eventStream.on(cancel), %s', JSON.stringify(args))
      })
  }

  private async onGrpcStreamEvent (event: grpcPuppet.EventResponse): Promise<void> {

    const type    = event.getType()
    const payload = event.getPayload()
    const seq     = event.getSeq()
    const timestamp = String(Date.now())

    if (!NO_LOG_EVENTS.includes(type)) {
      log.info('PuppetService', `received grpc event ${EventTypeRev[type]} on ${new Date().toString()}, content: ${JSON.stringify(payload)}, seq: ${seq}, timestamp: ${timestamp}`)
    }

    log.silly('PuppetService',
      'onGrpcStreamEvent({type:%s(%s), payload:"%s"})',
      EventTypeRev[type],
      type,
      payload,
    )

    if (type !== grpcPuppet.EventType.EVENT_TYPE_HEARTBEAT) {
      this.emit('heartbeat', {
        data: `onGrpcStreamEvent(${EventTypeRev[type]})`,
      })
    }

    if (seq && !envVars.WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE()) {
      const { lastEventSeq } = await this.getMiscellaneousStoreData()
      if (!lastEventSeq || (seq > Number(lastEventSeq) || seq === 1)) {
        await this.setMiscellaneousStoreData({
          lastEventSeq: seq.toString(),
          lastEventTimestamp: timestamp,
        })
      }
    }

    switch (type) {
      case grpcPuppet.EventType.EVENT_TYPE_DONG:
        this.emit('dong', JSON.parse(payload) as PUPPET.payloads.EventDong)
        break
      case grpcPuppet.EventType.EVENT_TYPE_ERROR:
        this.emit('error', JSON.parse(payload) as PUPPET.payloads.EventError)
        break
      case grpcPuppet.EventType.EVENT_TYPE_HEARTBEAT:
        this.emit('heartbeat', JSON.parse(payload) as PUPPET.payloads.EventHeartbeat)
        break
      case grpcPuppet.EventType.EVENT_TYPE_FRIENDSHIP:
        this.emit('friendship', JSON.parse(payload) as PUPPET.payloads.EventFriendship)
        break
      case grpcPuppet.EventType.EVENT_TYPE_LOGIN:
        {
          if (this.waitingForLogin && this.isLoggedIn) {
            log.warn('PuppetService', 'this login event is ignored because the it is expected by event stream reconnect and this puppet is already logged in')
            return
          }
          const loginPayload = JSON.parse(payload) as PUPPET.payloads.EventLogin
          if (!envVars.WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE()) {
            const { accountId } = await this.getMiscellaneousStoreData()
            if (accountId !== loginPayload.contactId) {
              await this.resetMiscellaneousStoreData()
              await this.setMiscellaneousStoreData({
                accountId: loginPayload.contactId,
              })
            }
          }
          (
            async () => this.login(loginPayload.contactId)
          )().catch(e =>
            log.error('PuppetService', 'onGrpcStreamEvent() this.login() rejection %s',
              (e as Error).message,
            ),
          )
        }
        break
      case grpcPuppet.EventType.EVENT_TYPE_LOGOUT:
        {
          const logoutPayload = JSON.parse(payload) as PUPPET.payloads.EventLogout
          if (!envVars.WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE()) {
            await this.resetMiscellaneousStoreData()
          }
          ;(
            async () => this.logout(logoutPayload.data)
          )().catch(e =>
            log.error('PuppetService', 'onGrpcStreamEvent() this.logout() rejection %s',
              (e as Error).message,
            ),
          )
        }
        break
      case grpcPuppet.EventType.EVENT_TYPE_DIRTY:
        await this.fastDirty(JSON.parse(payload))
        this.emit('dirty', JSON.parse(payload) as PUPPET.payloads.EventDirty)
        break
      case grpcPuppet.EventType.EVENT_TYPE_MESSAGE:
        this.emit('message', JSON.parse(payload) as PUPPET.payloads.EventMessage)
        break
      case grpcPuppet.EventType.EVENT_TYPE_POST:
        this.emit('post', JSON.parse(payload) as PUPPET.payloads.EventPost)
        break
      case grpcPuppet.EventType.EVENT_TYPE_POST_COMMENT:
        this.emit('post-comment', JSON.parse(payload) as PUPPET.payloads.EventPostComment)
        break
      case grpcPuppet.EventType.EVENT_TYPE_POST_TAP:
        this.emit('post-tap', JSON.parse(payload) as PUPPET.payloads.EventPostTap)
        break
      case grpcPuppet.EventType.EVENT_TYPE_READY:
        if (this.waitingForReady && this.readyIndicator.value()) {
          log.warn('PuppetService', 'this ready event is ignored because the it is expected by event stream reconnect and this puppet is already ready')
          return
        }
        this.emit('ready', JSON.parse(payload) as PUPPET.payloads.EventReady)
        break
      case grpcPuppet.EventType.EVENT_TYPE_ROOM_INVITE:
        this.emit('room-invite', JSON.parse(payload) as PUPPET.payloads.EventRoomInvite)
        break
      case grpcPuppet.EventType.EVENT_TYPE_ROOM_JOIN:
        this.emit('room-join', JSON.parse(payload) as PUPPET.payloads.EventRoomJoin)
        break
      case grpcPuppet.EventType.EVENT_TYPE_ROOM_LEAVE:
        this.emit('room-leave', JSON.parse(payload) as PUPPET.payloads.EventRoomLeave)
        break
      case grpcPuppet.EventType.EVENT_TYPE_ROOM_TOPIC:
        this.emit('room-topic', JSON.parse(payload) as PUPPET.payloads.EventRoomTopic)
        break
      case grpcPuppet.EventType.EVENT_TYPE_ROOM_ANNOUNCE:
        this.emit('room-announce', JSON.parse(payload) as PUPPET.payloads.EventRoomAnnounce)
        break
      case grpcPuppet.EventType.EVENT_TYPE_SCAN:
        this.emit('scan', JSON.parse(payload) as PUPPET.payloads.EventScan)
        break
      case grpcPuppet.EventType.EVENT_TYPE_TAG:
        this.emit('tag', JSON.parse(payload) as PUPPET.payloads.EventTag)
        break
      case grpcPuppet.EventType.EVENT_TYPE_TAG_GROUP:
        this.emit('tag-group', JSON.parse(payload) as PUPPET.payloads.EventTagGroup)
        break
      case grpcPuppet.EventType.EVENT_TYPE_RESET:
        log.warn('PuppetService', 'onGrpcStreamEvent() got an EventType.EVENT_TYPE_RESET ?')
        // the `reset` event should be dealed not send out
        break
      case grpcPuppet.EventType.EVENT_TYPE_VERIFY_CODE:
        this.emit('verify-code', JSON.parse(payload) as PUPPET.payloads.EventVerifyCode)
        break
      case grpcPuppet.EventType.EVENT_TYPE_UNSPECIFIED:
        log.error('PuppetService', 'onGrpcStreamEvent() got an EventType.EVENT_TYPE_UNSPECIFIED ?')
        break

      default:
        // Huan(202003): in default, the `type` type should be `never`, please check.
        log.error(`eventType ${type} unsupported! data: ${payload}`)
    }
  }

  override async logout (reason?: string): Promise<void> {
    log.verbose('PuppetService', 'logout(%s)', reason ? `"${reason}"` : '')

    await super.logout(reason)

    try {
      await util.promisify(
        this.grpcManager.client.logout
          .bind(this.grpcManager.client),
      )(new grpcPuppet.LogoutRequest())

    } catch (e) {
      log.silly('PuppetService', 'logout() no grpc client')
    }
  }

  override ding (data: string): void {
    log.silly('PuppetService', 'ding(%s)', data)

    const request = new grpcPuppet.DingRequest()
    request.setData(data || '')

    this.grpcManager.client.ding(
      request,
      (error, _response) => {
        if (error) {
          log.error('PuppetService', 'ding() rejection: %s', error)
        }
      },
    )
  }

  /**
   *
   * Huan(202111) Issue #158 - Refactoring the 'dirty' event, dirtyPayload(),
   *  and XXXPayloadDirty() methods logic & spec
   *
   *    @see https://github.com/wechaty/puppet/issues/158
   *
   */
  override async dirtyPayload (type: PUPPET.types.Dirty, id: string) {
    log.verbose('PuppetService', 'dirtyPayload(%s, %s)', type, id)

    const request = new grpcPuppet.DirtyPayloadRequest()
    request.setId(id)
    request.setType(type as Parameters<typeof request.setType>[0])
    try {
      await util.promisify(
        this.grpcManager.client.dirtyPayload
          .bind(this.grpcManager.client),
      )(request)

    } catch (e) {
      log.error('PuppetService', 'dirtyPayload() rejection: %s', e && (e as Error).message)
      throw e
    }
  }

  /**
   * `onDirty()` is called when the puppet emit `dirty` event.
   *  the event listener will be registered in `start()` from the `PuppetAbstract` class
   */
  async fastDirty (
    {
      payloadType,
      payloadId,
    }: PUPPET.payloads.EventDirty,
  ): Promise<void> {
    log.verbose('PuppetService', 'fastDirty(%s<%s>, %s)', PUPPET.types.Dirty[payloadType], payloadType, payloadId)

    const dirtyMap = {
      [PUPPET.types.Dirty.Contact]:      async (id: string) => this._payloadStore.contact?.delete(id),
      [PUPPET.types.Dirty.Friendship]:   async (_: string) => {},
      [PUPPET.types.Dirty.Message]:      async (_: string) => {},
      [PUPPET.types.Dirty.Post]:         async (_: string) => {},
      [PUPPET.types.Dirty.Room]:         async (id: string) => this._payloadStore.room?.delete(id),
      [PUPPET.types.Dirty.RoomMember]:   async (id: string) => this._payloadStore.roomMember?.delete(id),
      [PUPPET.types.Dirty.Tag]:          async (id: string) => this._payloadStore.tag?.delete(id),
      [PUPPET.types.Dirty.TagGroup]:     async (id: string) => this._payloadStore.tagGroup?.delete(id),
      [PUPPET.types.Dirty.Unspecified]:  async (id: string) => { throw new Error('Unspecified type with id: ' + id) },
    }

    try {
      await dirtyMap[payloadType](payloadId)
    } catch (error) {
      this.emit('error', error)
    }
  }

  override async enterVerifyCode (id: string, code: string): Promise<void> {
    log.verbose('PuppetService', 'enterVerifyCode(%s, %s)', id, code)

    const request = new grpcPuppet.EnterVerifyCodeRequest()
    request.setId(id)
    request.setCode(code)

    await util.promisify(
      this.grpcManager.client.enterVerifyCode
        .bind(this.grpcManager.client),
    )(request)
  }

  override async cancelVerifyCode (id: string): Promise<void> {
    log.verbose('PuppetService', 'cancelVerifyCode(%s)', id)

    const request = new grpcPuppet.CancelVerifyCodeRequest()
    request.setId(id)

    await util.promisify(
      this.grpcManager.client.cancelVerifyCode
        .bind(this.grpcManager.client),
    )(request)
  }

  override async refreshQRCode (): Promise<void> {
    log.verbose('PuppetService', 'refreshQRCode(%s)')

    const request = new grpcPuppet.RefreshQRCodeRequest()

    await util.promisify(
      this.grpcManager.client.refreshQRCode
        .bind(this.grpcManager.client),
    )(request)
  }

  /**
   *
   * Contact
   *
   */
  override contactAlias (contactId: string)                      : Promise<string>
  override contactAlias (contactId: string, alias: string | null): Promise<void>

  override async contactAlias (contactId: string, alias?: string | null): Promise<void | string> {
    log.verbose('PuppetService', 'contactAlias(%s, %s)', contactId, alias)

    /**
     * Get alias
     */
    if (typeof alias === 'undefined') {
      const request = new grpcPuppet.ContactAliasRequest()
      request.setId(contactId)

      const response = await util.promisify(
        this.grpcManager.client.contactAlias
          .bind(this.grpcManager.client),
      )(request)

      const result = response.getAlias()
      if (result) {
        return result
      }

      {
        // DEPRECATED, will be removed after Dec 31, 2022
        const aliasWrapper = response.getAliasStringValueDeprecated()

        if (!aliasWrapper) {
          throw new Error('can not get aliasWrapper')
        }

        return aliasWrapper.getValue()
      }
    }

    /**
     * Set alias
     */
    const request = new grpcPuppet.ContactAliasRequest()
    request.setId(contactId)
    request.setAlias(alias || '')   // null -> '', in server, we treat '' as null

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const aliasWrapper = new StringValue()
      aliasWrapper.setValue(alias || '')  // null -> '', in server, we treat '' as null
      request.setAliasStringValueDeprecated(aliasWrapper)
    }

    await util.promisify(
      this.grpcManager.client.contactAlias
        .bind(this.grpcManager.client),
    )(request)
  }

  override async contactPhone (contactId: string, phoneList: string[]): Promise<void> {
    log.verbose('PuppetService', 'contactPhone(%s, %s)', contactId, phoneList)

    const request = new grpcPuppet.ContactPhoneRequest()
    request.setContactId(contactId)
    request.setPhonesList(phoneList)

    await util.promisify(
      this.grpcManager.client.contactPhone
        .bind(this.grpcManager.client),
    )(request)
  }

  override async contactCorporationRemark (contactId: string, corporationRemark: string | null) {
    log.verbose('PuppetService', 'contactCorporationRemark(%s, %s)', contactId, corporationRemark)

    const request = new grpcPuppet.ContactCorporationRemarkRequest()
    request.setContactId(contactId)
    if (corporationRemark) {
      request.setCorporationRemark(corporationRemark)
    }

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const corporationRemarkWrapper = new StringValue()
      if (corporationRemark) {
        corporationRemarkWrapper.setValue(corporationRemark)
        request.setCorporationRemarkStringValueDeprecated(corporationRemarkWrapper)
      }
    }

    await util.promisify(
      this.grpcManager.client.contactCorporationRemark
        .bind(this.grpcManager.client),
    )(request)
  }

  override async contactDescription (contactId: string, description: string | null) {
    log.verbose('PuppetService', 'contactDescription(%s, %s)', contactId, description)

    const request = new grpcPuppet.ContactDescriptionRequest()
    request.setContactId(contactId)
    if (description) {
      request.setDescription(description)
    }

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const descriptionWrapper = new StringValue()
      if (description) {
        descriptionWrapper.setValue(description)
        request.setDescriptionStringValueDeprecated(descriptionWrapper)
      }
    }

    await util.promisify(
      this.grpcManager.client.contactDescription
        .bind(this.grpcManager.client),
    )(request)
  }

  override async contactList (): Promise<string[]> {
    log.verbose('PuppetService', 'contactList()')

    const response = await util.promisify(
      this.grpcManager.client.contactList
        .bind(this.grpcManager.client),
    )(new grpcPuppet.ContactListRequest())

    return response.getIdsList()
  }

  override async contactAvatar (contactId: string)                          : Promise<FileBoxInterface>
  override async contactAvatar (contactId: string, file: FileBoxInterface)  : Promise<void>

  override async contactAvatar (contactId: string, fileBox?: FileBoxInterface): Promise<void | FileBoxInterface> {
    log.verbose('PuppetService', 'contactAvatar(%s)', contactId)

    /**
     * 1. set
     */
    if (fileBox) {
      const request = new grpcPuppet.ContactAvatarRequest()
      request.setId(contactId)

      const serializedFileBox = await this.serializeFileBox(fileBox)
      request.setFileBox(serializedFileBox)

      await util.promisify(
        this.grpcManager.client.contactAvatar
          .bind(this.grpcManager.client),
      )(request)

      return
    }

    /**
     * 2. get
     */
    const request = new grpcPuppet.ContactAvatarRequest()
    request.setId(contactId)

    const response = await util.promisify(
      this.grpcManager.client.contactAvatar
        .bind(this.grpcManager.client),
    )(request)

    let jsonText: string
    jsonText = response.getFileBox()

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const deprecated = true
      void deprecated

      if (!jsonText) {
        const textWrapper = response.getFileboxStringValueDeprecated()
        if (!textWrapper) {
          throw new Error('can not get textWrapper')
        }
        jsonText = textWrapper.getValue()
      }
    }

    return this.FileBoxUuid.fromJSON(jsonText)
  }

  override async contactRawPayload (id: string): Promise<PUPPET.payloads.Contact> {
    log.verbose('PuppetService', 'contactRawPayload(%s)', id)

    const cachedPayload = await this._payloadStore.contact?.get(id)
    if (cachedPayload) {
      log.silly('PuppetService', 'contactRawPayload(%s) cache HIT', id)
      return cachedPayload
    }

    const request = new grpcPuppet.ContactPayloadRequest()
    request.setId(id)

    const response = await util.promisify(
      this.grpcManager.client.contactPayload
        .bind(this.grpcManager.client),
    )(request)

    const payload: PUPPET.payloads.Contact = {
      address     : response.getAddress(),
      alias       : response.getAlias(),
      avatar      : response.getAvatar(),
      city        : response.getCity(),
      corporation : response.getCorporation(),
      coworker    : response.getCoworker(),
      description : response.getDescription(),
      friend      : response.getFriend(),
      gender      : response.getGender() as number,
      /**
       * Huan(202203): rename `getWeixin()` to `getHandle()` in v2.0.0
       *  @link https://github.com/wechaty/grpc/issues/174
       */
      handle      : response.getWeixin(),
      id          : response.getId(),
      name        : response.getName(),
      phone       : response.getPhonesList(),
      province    : response.getProvince(),
      signature   : response.getSignature(),
      star        : response.getStar(),
      title       : response.getTitle(),
      type        : response.getType() as number,
      /**
       * `weixin` is deprecated, will be removed after Dec 31, 2022
       * use `handle` instead.
       */
      weixin        : response.getWeixin(),
      additionalInfo: response.getAdditionalInfo(),
      tags          : response.getTagIdsList(),
      realName      : response.getRealName(),
      aka           : response.getAka(),
    }

    await this._payloadStore.contact?.set(id, payload)
    log.silly('PuppetService', 'contactRawPayload(%s) cache SET', id)

    return payload
  }

  override async contactRawPayloadParser (payload: PUPPET.payloads.Contact): Promise<PUPPET.payloads.Contact> {
    // log.silly('PuppetService', 'contactRawPayloadParser({id:%s})', payload.id)
    // passthrough
    return payload
  }

  override async batchContactRawPayload (contactIdList: string[]): Promise<Map<string, PUPPET.payloads.Contact>> {
    log.verbose('PuppetService', 'batchContactRawPayload(%s)', contactIdList)

    const result = new Map<string, PUPPET.payloads.Contact>()
    const contactIdSet = new Set<string>(contactIdList)
    const needGetSet = new Set<string>()
    for (const contactId of contactIdSet) {
      const cachedContactPayload = await this._payloadStore.contact?.get(contactId)
      if (cachedContactPayload) {
        result.set(contactId, cachedContactPayload)
      } else {
        needGetSet.add(contactId)
      }
    }

    if (needGetSet.size > 0) {
      try {
        const request = new grpcPuppet.BatchContactPayloadRequest()
        request.setIdsList(Array.from(needGetSet))

        const response = await util.promisify(
          this.grpcManager.client.batchContactPayload
            .bind(this.grpcManager.client),
        )(request)

        const payloads = response.getContactPayloadsList()
        for (const payload of payloads) {
          const contactId = payload.getId()
          const puppetPayload = contactPbToPayload(payload)
          result.set(contactId, puppetPayload)
          await this._payloadStore.contact?.set(contactId, puppetPayload)
        }
      } catch (e) {
        log.error('PuppetService', 'batchContactRawPayload(%s, %s) error: %s, use one by one method', contactIdList, needGetSet, e)
        for (const contactId of needGetSet) {
          const payload = await this.contactRawPayload(contactId)
          result.set(contactId, payload)
        }
      }
    }
    return result
  }

  override async contactPayloadModify (contactId: string, payload: Partial<PUPPET.payloads.Contact>): Promise<void> {
    log.verbose('PuppetService', 'contactPayloadModify(%s, %s)', contactId, JSON.stringify(payload))

    const request = new grpcPuppet.ContactPayloadModifyRequest()
    request.setId(contactId)
    if (payload.id) {
      throw new Error('cannot modify contactId')
    }
    if (typeof payload.gender !== 'undefined') { request.setGender(payload.gender) }
    if (typeof payload.type !== 'undefined') { request.setType(payload.type) }
    if (typeof payload.name !== 'undefined') { request.setName(payload.name) }
    if (typeof payload.avatar !== 'undefined') { request.setAvatar(payload.avatar) }
    if (typeof payload.address !== 'undefined') { request.setAddress(payload.address) }
    if (typeof payload.alias !== 'undefined') { request.setAlias(payload.alias) }
    if (typeof payload.city !== 'undefined') { request.setCity(payload.city) }
    if (typeof payload.friend !== 'undefined') { request.setFriend(payload.friend) }
    if (typeof payload.province !== 'undefined') { request.setProvince(payload.province) }
    if (typeof payload.star !== 'undefined') { request.setStar(payload.star) }
    if (typeof payload.weixin !== 'undefined') { request.setWeixin(payload.weixin) }
    if (typeof payload.corporation !== 'undefined') { request.setCorporation(payload.corporation) }
    if (typeof payload.title !== 'undefined') { request.setTitle(payload.title) }
    if (typeof payload.description !== 'undefined') { request.setDescription(payload.description) }
    if (typeof payload.coworker !== 'undefined') { request.setCoworker(payload.coworker) }
    if (typeof payload.phone !== 'undefined') {
      request.setPhonesList(payload.phone)
      if (payload.phone.length === 0) {
        request.setClearPhones(true)
      }
    }
    if (typeof payload.additionalInfo !== 'undefined') { request.setAdditionalInfo(payload.additionalInfo) }
    if (typeof payload.tags !== 'undefined') {
      request.setTagIdsList(payload.tags)
      if (payload.tags.length === 0) {
        request.setClearTagIds(true)
      }
    }

    await util.promisify(
      this.grpcManager.client.contactPayloadModify
        .bind(this.grpcManager.client),
    )(request)

  }

  override async contactSelfName (name: string): Promise<void> {
    log.verbose('PuppetService', 'contactSelfName(%s)', name)

    const request = new grpcPuppet.ContactSelfNameRequest()
    request.setName(name)

    await util.promisify(
      this.grpcManager.client.contactSelfName
        .bind(this.grpcManager.client),
    )(request)
  }

  override async contactSelfRealName (realName: string): Promise<void> {
    log.verbose('PuppetService', 'contactSelfRealName(%s)', realName)

    const request = new grpcPuppet.ContactSelfRealNameRequest()
    request.setRealName(realName)

    await util.promisify(
      this.grpcManager.client.contactSelfRealName
        .bind(this.grpcManager.client),
    )(request)
  }

  override async contactSelfAka (aka: string): Promise<void> {
    log.verbose('PuppetService', 'contactSelfAka(%s)', aka)

    const request = new grpcPuppet.ContactSelfAkaRequest()
    request.setAka(aka)

    await util.promisify(
      this.grpcManager.client.contactSelfAka
        .bind(this.grpcManager.client),
    )(request)
  }

  override async contactSelfQRCode (): Promise<string> {
    log.verbose('PuppetService', 'contactSelfQRCode()')

    const response = await util.promisify(
      this.grpcManager.client.contactSelfQRCode
        .bind(this.grpcManager.client),
    )(new grpcPuppet.ContactSelfQRCodeRequest())

    return response.getQrcode()
  }

  override async contactSelfSignature (signature: string): Promise<void> {
    log.verbose('PuppetService', 'contactSelfSignature(%s)', signature)

    const request = new grpcPuppet.ContactSelfSignatureRequest()
    request.setSignature(signature)

    await util.promisify(
      this.grpcManager.client.contactSelfSignature
        .bind(this.grpcManager.client),
    )(request)
  }

  override async contactSelfRoomAlias (roomId: string, alias: string): Promise<void> {
    log.verbose('PuppetService', 'contactSelfRoomAlias(%s, %s)', roomId, alias)

    const request = new grpcPuppet.ContactSelfRoomAliasRequest()
    request.setRoomId(roomId)
    request.setAlias(alias)

    await util.promisify(
      this.grpcManager.client.contactSelfRoomAlias
        .bind(this.grpcManager.client),
    )(request)
  }

  override async contactDelete (contactId: string): Promise<void> {
    log.verbose('PuppetService', 'contactDelete(%s)', contactId)
    const request = new grpcPuppet.ContactDeleteRequest()
    request.setContactId(contactId)

    await util.promisify(
      this.grpcManager.client.contactDelete
        .bind(this.grpcManager.client),
    )(request)
  }

  /**
   *
   * Conversation
   *
   */
  override async conversationReadMark (
    conversationId: string,
    hasRead = true,
  ) : Promise<void> {
    log.verbose('PuppetService', 'conversationMarkRead(%s, %s)', conversationId, hasRead)

    const request = new grpcPuppet.ConversationReadRequest()
    request.setConversationId(conversationId)
    request.setHasRead(hasRead)
    await util.promisify(
      this.grpcManager.client.conversationRead
        .bind(this.grpcManager.client),
    )(request)

  }

  /**
   *
   * Message
   *
   */
  override async messageMiniProgram (
    messageId: string,
  ): Promise<PUPPET.payloads.MiniProgram> {
    log.verbose('PuppetService', 'messageMiniProgram(%s)', messageId)

    const request = new grpcPuppet.MessageMiniProgramRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpcManager.client.messageMiniProgram
        .bind(this.grpcManager.client),
    )(request)

    let miniProgramPayload = response.getMiniProgram()?.toObject()
    if (!miniProgramPayload) {
      /**
       * Deprecated: will be removed after Dec 22, 2022
       */
      const jsonText = response.getMiniProgramDeprecated()
      miniProgramPayload = JSON.parse(jsonText)
    }

    const payload: PUPPET.payloads.MiniProgram = {
      ...miniProgramPayload,
    }

    return payload
  }

  override async messageLocation (
    messageId: string,
  ): Promise<PUPPET.payloads.Location> {
    log.verbose('PuppetService', 'messageLocation(%s)', messageId)

    const request = new grpcPuppet.MessageLocationRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpcManager.client.messageLocation
        .bind(this.grpcManager.client),
    )(request)

    const locationPayload = response.getLocation()
    const payload: PUPPET.payloads.Location = {
      accuracy: locationPayload?.getAccuracy() || 0,
      address: locationPayload?.getAddress() || 'No Address',
      latitude: locationPayload?.getLatitude() || 0,
      longitude: locationPayload?.getLongitude() || 0,
      name: locationPayload?.getName() || 'No Name',
    }

    return payload
  }

  override async messageImage (
    messageId: string,
    imageType: PUPPET.types.Image,
  ): Promise<FileBoxInterface> {
    log.verbose('PuppetService', 'messageImage(%s, %s[%s])',
      messageId,
      imageType,
      PUPPET.types.Image[imageType],
    )
    const request = new grpcPuppet.MessageImageRequest()
    request.setId(messageId)
    request.setType(imageType)

    const response = await util.promisify(
      this.grpcManager.client.messageImage
        .bind(this.grpcManager.client),
    )(request)

    const jsonText = response.getFileBox()

    if (jsonText) {
      return this.FileBoxUuid.fromJSON(jsonText)
    }

    throw new Error(`failed to get image filebox for message ${messageId}`)
  }

  override async messageContact (
    messageId: string,
  ): Promise<string> {
    log.verbose('PuppetService', 'messageContact(%s)', messageId)

    const request = new grpcPuppet.MessageContactRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpcManager.client.messageContact
        .bind(this.grpcManager.client),
    )(request)

    const contactId = response.getId()
    return contactId
  }

  override async messageChannel (
    messageId: string,
  ): Promise<PUPPET.payloads.Channel> {
    log.verbose('PuppetService', 'messageChannel(%s)', messageId)

    const request = new grpcPuppet.MessageChannelRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpcManager.client.messageChannel
        .bind(this.grpcManager.client),
    )(request)

    const payload = channelPbToPayload(response.getChannel()!)

    return payload
  }

  override async messageCallRecord (
    messageId: string,
  ): Promise<PUPPET.payloads.CallRecord> {
    log.verbose('PuppetService', 'messageCallRecord(%s)', messageId)

    const request = new grpcPuppet.MessageCallRecordRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpcManager.client.messageCallRecord
        .bind(this.grpcManager.client),
    )(request)

    const payload = callRecordPbToPayload(response.getCallRecord()!)

    return payload
  }

  override async messageChatHistory (
    messageId: string,
  ): Promise<PUPPET.payloads.ChatHistory[]> {
    log.verbose('PuppetService', 'messageChatHistory(%s)', messageId)

    const request = new grpcPuppet.MessageChatHistoryRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpcManager.client.messageChatHistory
        .bind(this.grpcManager.client),
    )(request)

    const payload = chatHistoryPbToPayload(this.FileBoxUuid, response.getChatHistoryListList()!)

    return payload
  }

  override async messageSendMiniProgram (
    conversationId     : string,
    miniProgramPayload : PUPPET.payloads.MiniProgram,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSendMiniProgram(%s, "%s")', conversationId, JSON.stringify(miniProgramPayload))

    const request = new grpcPuppet.MessageSendMiniProgramRequest()
    request.setConversationId(conversationId)

    const pbMiniProgramPayload = new grpcPuppet.MiniProgramPayload()
    if (miniProgramPayload.appid)       { pbMiniProgramPayload.setAppid(miniProgramPayload.appid) }
    if (miniProgramPayload.description) { pbMiniProgramPayload.setDescription(miniProgramPayload.description) }
    if (miniProgramPayload.iconUrl)     { pbMiniProgramPayload.setIconUrl(miniProgramPayload.iconUrl) }
    if (miniProgramPayload.pagePath)    { pbMiniProgramPayload.setPagePath(miniProgramPayload.pagePath) }
    if (miniProgramPayload.shareId)     { pbMiniProgramPayload.setShareId(miniProgramPayload.shareId) }
    if (miniProgramPayload.thumbKey)    { pbMiniProgramPayload.setThumbKey(miniProgramPayload.thumbKey) }
    if (miniProgramPayload.thumbUrl)    { pbMiniProgramPayload.setThumbUrl(miniProgramPayload.thumbUrl) }
    if (miniProgramPayload.title)       { pbMiniProgramPayload.setTitle(miniProgramPayload.title) }
    if (miniProgramPayload.username)    { pbMiniProgramPayload.setUsername(miniProgramPayload.username) }
    request.setMiniProgram(pbMiniProgramPayload)

    /**
     * Deprecated: will be removed after Dec 31, 2022
     */
    request.setMiniProgramDeprecated(JSON.stringify(miniProgramPayload))

    log.info('PuppetService', `messageSendMiniProgram(${conversationId}, ${miniProgramPayload.description}) about to call grpc`)
    const response = await util.promisify(
      this.grpcManager.client.messageSendMiniProgram
        .bind(this.grpcManager.client),
    )(request)

    const messageId = response.getId()
    log.info('PuppetService', `messageSendMiniProgram(${conversationId}, ${miniProgramPayload.description}) grpc called, messageId: ${messageId}`)

    if (messageId) {
      return messageId
    }

    {
      /**
       * Huan(202110): Deprecated: will be removed after Dec 31, 2022
       */
      const messageIdWrapper = response.getIdStringValueDeprecated()

      if (messageIdWrapper) {
        return messageIdWrapper.getValue()
      }
    }
  }

  override async messageSendLocation (
    conversationId: string,
    locationPayload: PUPPET.payloads.Location,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSendLocation(%s)', conversationId, JSON.stringify(locationPayload))

    const request = new grpcPuppet.MessageSendLocationRequest()
    request.setConversationId(conversationId)

    const pbLocationPayload = new grpcPuppet.LocationPayload()
    pbLocationPayload.setAccuracy(locationPayload.accuracy)
    pbLocationPayload.setAddress(locationPayload.address)
    pbLocationPayload.setLatitude(locationPayload.latitude)
    pbLocationPayload.setLongitude(locationPayload.longitude)
    pbLocationPayload.setName(locationPayload.name)
    request.setLocation(pbLocationPayload)

    log.info('PuppetService', `messageSendLocation(${conversationId}, ${locationPayload.name}) about to call grpc`)
    const response = await util.promisify(
      this.grpcManager.client.messageSendLocation
        .bind(this.grpcManager.client),
    )(request)

    const id = response.getId()
    log.info('PuppetService', `messageSendMiniProgram(${conversationId}, ${locationPayload.name}) grpc called, messageId: ${id}`)

    if (id) {
      return id
    }
  }

  override async messageSendChannel (
    conversationId: string,
    channelPayload: PUPPET.payloads.Channel,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSendChannel(%s, "%s")', conversationId, JSON.stringify(channelPayload))

    const request = new grpcPuppet.MessageSendChannelRequest()
    request.setConversationId(conversationId)

    const pbChannelPayload = channelPayloadToPb(grpcPuppet, channelPayload)

    request.setChannel(pbChannelPayload)

    log.info('PuppetService', `messageSendChannel(${conversationId}, ${channelPayload.desc}) about to call grpc`)
    const response = await util.promisify(
      this.grpcManager.client.messageSendChannel
        .bind(this.grpcManager.client),
    )(request)

    const messageId = response.getId()
    log.info('PuppetService', `messageSendChannel(${conversationId}, ${channelPayload.desc}) grpc called, messageId: ${messageId}`)

    if (messageId) {
      return messageId
    }
  }

  override async messageRecall (
    messageId: string,
  ): Promise<boolean> {
    log.verbose('PuppetService', 'messageRecall(%s)', messageId)

    const request = new grpcPuppet.MessageRecallRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpcManager.client.messageRecall
        .bind(this.grpcManager.client),
    )(request)

    return response.getSuccess()
  }

  override async messageFile (id: string): Promise<FileBoxInterface> {
    log.verbose('PuppetService', 'messageFile(%s)', id)

    const request = new grpcPuppet.MessageFileRequest()
    request.setId(id)
    const response = await util.promisify(
      this.grpcManager.client.messageFile
        .bind(this.grpcManager.client),
    )(request)

    const jsonText = response.getFileBox()
    if (jsonText) {
      return this.FileBoxUuid.fromJSON(jsonText)
    }

    throw new Error(`failed to get filebox for message ${id}`)
  }

  override async messagePreview (id: string): Promise<FileBoxInterface | undefined> {
    log.verbose('PuppetService', 'messagePreview(%s)', id)

    const request = new grpcPuppet.MessagePreviewRequest()
    request.setId(id)
    const response = await util.promisify(
      this.grpcManager.client.messagePreview
        .bind(this.grpcManager.client),
    )(request)

    const jsonText = response.getFileBox()
    if (jsonText) {
      return this.FileBoxUuid.fromJSON(jsonText)
    }
    return undefined
  }

  override async messageForward (
    conversationId: string,
    messageIds: string | string[],
  ): Promise<string | void> {
    log.verbose('PuppetService', 'messageForward(%s, %s)', conversationId, messageIds)

    const request = new grpcPuppet.MessageForwardRequest()
    request.setConversationId(conversationId)
    if (Array.isArray(messageIds)) {
      request.setMessageIdsList(messageIds)
      if (messageIds.length === 1) {
        request.setMessageId(messageIds[0] as string)
      }
    } else {
      request.setMessageId(messageIds)
    }

    log.info('PuppetService', `messageForward(${conversationId}, ${messageIds}) about to call grpc`)
    const response = await util.promisify(
      this.grpcManager.client.messageForward
        .bind(this.grpcManager.client),
    )(request)

    const forwardedMessageId = response.getId()
    log.info('PuppetService', `messageForward(${conversationId}, ${messageIds}) grpc called, messageId: ${forwardedMessageId}`)

    if (forwardedMessageId) {
      return forwardedMessageId
    }

    {
      /**
       * Huan(202110): Deprecated: will be removed after Dec 31, 2022
       */
      const messageIdWrapper = response.getIdStringValueDeprecated()

      if (messageIdWrapper) {
        return messageIdWrapper.getValue()
      }
    }
  }

  override async messageRawPayload (id: string): Promise<PUPPET.payloads.Message> {
    log.verbose('PuppetService', 'messageRawPayload(%s)', id)

    // const cachedPayload = await this.payloadStore.message?.get(id)
    // if (cachedPayload) {
    //   log.silly('PuppetService', 'messageRawPayload(%s) cache HIT', id)
    //   return cachedPayload
    // }

    const request = new grpcPuppet.MessagePayloadRequest()
    request.setId(id)

    const response = await util.promisify(
      this.grpcManager.client.messagePayload
        .bind(this.grpcManager.client),
    )(request)

    let timestamp
    const receiveTime = response.getReceiveTime()
    if (receiveTime) {
      timestamp = millisecondsFromTimestamp(receiveTime)
    } else {
      // Deprecated: will be removed after Dec 31, 2022
      timestamp = response.getTimestampDeprecated()
    }

    const payload: PUPPET.payloads.Message = {
      filename      : response.getFilename(),
      id            : response.getId(),
      listenerId    : response.getListenerId(),
      mentionIdList : response.getMentionIdsList(),
      roomId        : response.getRoomId(),
      talkerId      : response.getTalkerId(),
      text          : response.getText(),
      timestamp,
      type          : response.getType() as number,
      quoteId       : response.getQuoteId(),
      additionalInfo: response.getAdditionalInfo(),
      textContent   : [],
    }

    const textContentListPb = response.getTextContentsList()
    for (const textContentPb of textContentListPb) {
      const type = textContentPb.getType()
      const contentData = {
        type,
        text: textContentPb.getText(),
      } as PUPPET.types.TextContent
      switch (contentData.type) {
        case PUPPET.types.TextContentType.Regular:
          break
        case PUPPET.types.TextContentType.At: {
          const data = textContentPb.getData()
          const contactId = data?.getContactId()
          contentData.data = {
            contactId: contactId || '',
          }
          break
        }
        default:
          log.warn('PuppetService', `unknown text content type ${type}`)
      }
      payload.textContent?.push(contentData)
    }

    // log.silly('PuppetService', 'messageRawPayload(%s) cache SET', id)
    // await this.payloadStore.message?.set(id, payload)

    return payload
  }

  override async messageRawPayloadParser (payload: PUPPET.payloads.Message): Promise<PUPPET.payloads.Message> {
    // log.silly('PuppetService', 'messagePayload({id:%s})', payload.id)
    // passthrough
    return payload
  }

  override async messageSendText (
    conversationId : string,
    text           : string,
    options?       : PUPPET.types.MessageSendTextOptions,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSend(%s, %s)', conversationId, text)
    let mentionIdList
    let quoteId
    if (Array.isArray(options)) {
      mentionIdList = options
    } else {
      mentionIdList = options?.mentionIdList
      quoteId = options?.quoteId
    }
    const request = new grpcPuppet.MessageSendTextRequest()
    request.setConversationId(conversationId)
    request.setText(text)
    if (typeof mentionIdList !== 'undefined') {
      request.setMentionalIdsList(mentionIdList)
    }
    if (typeof quoteId !== 'undefined') {
      request.setQuoteId(quoteId)
    }

    log.info('PuppetService', `messageSend(${conversationId}, ${text}) about to call grpc`)
    const response = await util.promisify(
      this.grpcManager.client.messageSendText
        .bind(this.grpcManager.client),
    )(request)

    const messageId = response.getId()
    log.info('PuppetService', `messageSend(${conversationId}, ${text}) grpc called, messageId: ${messageId}`)

    if (messageId) {
      return messageId
    }

    {
      /**
       * Huan(202110): Deprecated: will be removed after Dec 31, 2022
       */
      const messageIdWrapper = response.getIdStringValueDeprecated()

      if (messageIdWrapper) {
        return messageIdWrapper.getValue()
      }
    }
  }

  override async messageSendFile (
    conversationId : string,
    fileBox        : FileBoxInterface,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSendFile(%s, %s)', conversationId, fileBox)

    const request = new grpcPuppet.MessageSendFileRequest()
    request.setConversationId(conversationId)

    const serializedFileBox = await this.serializeFileBox(fileBox)
    request.setFileBox(serializedFileBox)

    log.info('PuppetService', `messageSendFile(${conversationId}, ${fileBox}) about to call grpc`)
    const response = await util.promisify(
      this.grpcManager.client.messageSendFile
        .bind(this.grpcManager.client),
    )(request)

    const messageId = response.getId()
    log.info('PuppetService', `messageSendFile(${conversationId}, ${fileBox}) grpc called, messageId: ${messageId}`)

    if (messageId) {
      return messageId
    } else {
      /**
       * Huan(202110): Deprecated: will be removed after Dec 31, 2022
       */
      const messageIdWrapper = response.getIdStringValueDeprecated()
      if (messageIdWrapper) {
        return messageIdWrapper.getValue()
      }
    }
  }

  override async messageSendContact (
    conversationId  : string,
    contactId       : string,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSend("%s", %s)', conversationId, contactId)

    const request = new grpcPuppet.MessageSendContactRequest()
    request.setConversationId(conversationId)
    request.setContactId(contactId)

    log.info('PuppetService', `messageSendContact(${conversationId}, ${contactId}) about to call grpc`)
    const response = await util.promisify(
      this.grpcManager.client.messageSendContact
        .bind(this.grpcManager.client),
    )(request)

    const messageId = response.getId()
    log.info('PuppetService', `messageSendContact(${conversationId}, ${contactId}) grpc called, messageId: ${messageId}`)

    if (messageId) {
      return messageId
    }

    {
      /**
       * Huan(202110): Deprecated: will be removed after Dec 31, 2022
       */
      const messageIdWrapper = response.getIdStringValueDeprecated()

      if (messageIdWrapper) {
        return messageIdWrapper.getValue()
      }
    }
  }

  override async messageSendUrl (
    conversationId: string,
    urlLinkPayload: PUPPET.payloads.UrlLink,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSendUrl("%s", %s)', conversationId, JSON.stringify(urlLinkPayload))

    const request = new grpcPuppet.MessageSendUrlRequest()
    request.setConversationId(conversationId)

    const pbUrlLinkPayload = new grpcPuppet.UrlLinkPayload()
    pbUrlLinkPayload.setUrl(urlLinkPayload.url)
    pbUrlLinkPayload.setTitle(urlLinkPayload.title)
    if (urlLinkPayload.description)   { pbUrlLinkPayload.setDescription(urlLinkPayload.description) }
    if (urlLinkPayload.thumbnailUrl)  { pbUrlLinkPayload.setThumbnailUrl(urlLinkPayload.thumbnailUrl) }
    request.setUrlLink(pbUrlLinkPayload)

    // Deprecated: will be removed after Dec 31, 2022
    request.setUrlLinkDeprecated(JSON.stringify(urlLinkPayload))

    log.info('PuppetService', `messageSendUrl(${conversationId}, ${urlLinkPayload}) about to call grpc`)
    const response = await util.promisify(
      this.grpcManager.client.messageSendUrl
        .bind(this.grpcManager.client),
    )(request)

    const messageId = response.getId()
    log.info('PuppetService', `messageSendUrl(${conversationId}, ${urlLinkPayload}) grpc called, messageId: ${messageId}`)

    if (messageId) {
      return messageId
    }

    {
      /**
       * Huan(202110): Deprecated: will be removed after Dec 31, 2022
       */
      const messageIdWrapper = response.getIdStringValueDeprecated()

      if (messageIdWrapper) {
        return messageIdWrapper.getValue()
      }
    }
  }

  override async messageSendPost (
    conversationId: string,
    postPayload: PUPPET.payloads.PostClient,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSendPost("%s", %s)', conversationId, JSON.stringify(postPayload))

    const request = new grpcPuppet.MessageSendPostRequest()
    const post = await postPayloadToPb(grpcPuppet, postPayload, this.serializeFileBox.bind(this))
    request.setContent(post)
    request.setConversationId(conversationId)

    log.info('PuppetService', `messageSendPost(${conversationId}, ${postPayload}) about to call grpc`)
    const response = await util.promisify(
      this.grpcManager.client.messageSendPost
        .bind(this.grpcManager.client),
    )(request)

    const messageId = response.getId()
    log.info('PuppetService', `messageSendPost(${conversationId}, ${postPayload}) grpc called, messageId: ${messageId}`)

    if (messageId) {
      return messageId
    }
  }

  override async messageUrl (messageId: string): Promise<PUPPET.payloads.UrlLink> {
    log.verbose('PuppetService', 'messageUrl(%s)', messageId)

    const request = new grpcPuppet.MessageUrlRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpcManager.client.messageUrl
        .bind(this.grpcManager.client),
    )(request)

    let pbUrlLinkPayload = response.getUrlLink()?.toObject()
    if (!pbUrlLinkPayload) {
      // Deprecated: will be removed after Dec 31, 2022
      const jsonText = response.getUrlLinkDeprecated()
      pbUrlLinkPayload = JSON.parse(jsonText)
    }

    const payload: PUPPET.payloads.UrlLink = {
      title : 'NOTITLE',
      url   : 'NOURL',
      ...pbUrlLinkPayload,
    }
    return payload
  }

  override async getMessageBroadcastTarget (): Promise<MessageBroadcastTargets> {
    log.verbose('PuppetService', 'getMessageBroadcastTarget()')

    const request = new grpcPuppet.GetMessageBroadcastTargetRequest()

    const response = await util.promisify(
      this.grpcManager.client.getMessageBroadcastTarget.bind(this.grpcManager.client),
    )(request)

    return {
      contactIds: response.getContactIdsList(),
      roomIds: response.getRoomIdsList(),
    }
  }

  override async createMessageBroadcast (targets: string[], content: PUPPET.payloads.Post): Promise<string | void> {
    log.verbose('PuppetService', 'createMessageBroadcast()')

    if (!PUPPET.payloads.isPostClient(content)) {
      throw new Error('can only create broadcast with client post')
    }

    const request = new grpcPuppet.CreateMessageBroadcastRequest()
    const post = await postPayloadToPb(grpcPuppet, content, this.serializeFileBox.bind(this))
    request.setContent(post)
    request.setTargetIdsList(targets)

    const response = await util.promisify(
      this.grpcManager.client.createMessageBroadcast.bind(this.grpcManager.client),
    )(request)

    return response.getId()
  }

  override async getMessageBroadcastStatus (id: string): Promise<{ status: PUPPET.types.BroadcastStatus; detail: { contactId?: string | undefined; roomId?: string | undefined; status: PUPPET.types.BroadcastTargetStatus }[] }> {
    log.verbose('PuppetService', 'getMessageBroadcastStatus()')

    const request = new grpcPuppet.GetMessageBroadcastStatusRequest()
    request.setId(id)

    const response = await util.promisify(
      this.grpcManager.client.getMessageBroadcastStatus.bind(this.grpcManager.client),
    )(request)

    const result: {
      status: PUPPET.types.BroadcastStatus;
      detail: {
        contactId?: string | undefined;
        roomId?: string | undefined;
        status: PUPPET.types.BroadcastTargetStatus
      }[]
    } = {
      status: response.getStatus(),
      detail: [],
    }
    const detailList = response.getDetailList()
    for (const detail of detailList) {
      result.detail.push({
        contactId: detail.getContactId(),
        roomId: detail.getRoomId(),
        status: detail.getStatus(),
      })
    }

    return result
  }

  /**
   *
   * Room
   *
   */
  override async roomRawPayload (
    id: string,
  ): Promise<PUPPET.payloads.Room> {
    log.verbose('PuppetService', 'roomRawPayload(%s)', id)

    const cachedPayload = await this._payloadStore.room?.get(id)
    if (cachedPayload) {
      log.silly('PuppetService', 'roomRawPayload(%s) cache HIT', id)
      return cachedPayload
    }

    const request = new grpcPuppet.RoomPayloadRequest()
    request.setId(id)

    const response = await util.promisify(
      this.grpcManager.client.roomPayload
        .bind(this.grpcManager.client),
    )(request)

    const payload: PUPPET.payloads.Room = {
      adminIdList   : response.getAdminIdsList(),
      avatar        : response.getAvatar(),
      handle        : response.getHandle(),
      id            : response.getId(),
      memberIdList  : response.getMemberIdsList(),
      ownerId       : response.getOwnerId(),
      topic         : response.getTopic(),
      additionalInfo: response.getAdditionalInfo(),
      remark        : response.getRoomRemark(),
      external      : response.getExternal(),
    }

    const createTime = response.getCreateTime()
    if (createTime) {
      payload.createTime = millisecondsFromTimestamp(createTime)
    }

    await this._payloadStore.room?.set(id, payload)
    log.silly('PuppetService', 'roomRawPayload(%s) cache SET', id)

    return payload
  }

  override async roomRawPayloadParser (payload: PUPPET.payloads.Room): Promise<PUPPET.payloads.Room> {
    // log.silly('PuppetService', 'roomRawPayloadParser({id:%s})', payload.id)
    // passthrough
    return payload
  }

  override async roomList (): Promise<string[]> {
    log.verbose('PuppetService', 'roomList()')

    const response = await util.promisify(
      this.grpcManager.client.roomList
        .bind(this.grpcManager.client),
    )(new grpcPuppet.RoomListRequest())

    return response.getIdsList()
  }

  override async roomDel (
    roomId    : string,
    contactIds : string | string[],
  ): Promise<void> {
    log.verbose('PuppetService', 'roomDel(%s, %s)', roomId, contactIds)

    const request = new grpcPuppet.RoomDelRequest()
    request.setId(roomId)
    if (Array.isArray(contactIds)) {
      request.setContactIdsList(contactIds)
      if (contactIds.length === 1) {
        request.setContactId(contactIds[0] as string)
      }
    } else {
      request.setContactId(contactIds)
    }

    await util.promisify(
      this.grpcManager.client.roomDel
        .bind(this.grpcManager.client),
    )(request)
  }

  override async roomAvatar (roomId: string): Promise<FileBoxInterface> {
    log.verbose('PuppetService', 'roomAvatar(%s)', roomId)

    const request = new grpcPuppet.RoomAvatarRequest()
    request.setId(roomId)

    const response = await util.promisify(
      this.grpcManager.client.roomAvatar
        .bind(this.grpcManager.client),
    )(request)

    const jsonText = response.getFileBox()
    return this.FileBoxUuid.fromJSON(jsonText)
  }

  override async roomAdd (
    roomId     : string,
    contactId  : string,
    inviteOnly : boolean,
    quoteIds   : string[],
  ): Promise<void> {
    log.verbose('PuppetService', 'roomAdd(%s, %s)', roomId, contactId)

    const request = new grpcPuppet.RoomAddRequest()
    request.setId(roomId)
    request.setContactId(contactId)
    request.setInviteOnly(inviteOnly)
    request.setQuoteIdsList(quoteIds)
    await util.promisify(
      this.grpcManager.client.roomAdd
        .bind(this.grpcManager.client),
    )(request)
  }

  override async roomTopic (roomId: string)                : Promise<string>
  override async roomTopic (roomId: string, topic: string) : Promise<void>

  override async roomTopic (
    roomId: string,
    topic?: string,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'roomTopic(%s, %s)', roomId, topic)

    /**
     * Get
     */
    if (typeof topic === 'undefined') {
      const request = new grpcPuppet.RoomTopicRequest()
      request.setId(roomId)

      const response = await util.promisify(
        this.grpcManager.client.roomTopic
          .bind(this.grpcManager.client),
      )(request)

      const result = response.getTopic()
      if (result) {
        return result
      }

      {
        // DEPRECATED, will be removed after Dec 31, 2022
        const topicWrapper = response.getTopicStringValueDeprecated()
        if (topicWrapper) {
          return topicWrapper.getValue()
        }
      }

      return ''
    }

    /**
     * Set
     */
    const request = new grpcPuppet.RoomTopicRequest()
    request.setId(roomId)
    request.setTopic(topic)

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const topicWrapper = new StringValue()
      topicWrapper.setValue(topic)

      request.setTopicStringValueDeprecated(topicWrapper)
    }

    await util.promisify(
      this.grpcManager.client.roomTopic
        .bind(this.grpcManager.client),
    )(request)
  }

  override async roomRemark (roomId: string, remark: string): Promise<void> {
    log.verbose('PuppetService', 'roomRemark(%s)', roomId)

    const request = new grpcPuppet.RoomRemarkRequest()
    request.setId(roomId)
    request.setRemark(remark)

    await util.promisify(
      this.grpcManager.client.roomRemark
        .bind(this.grpcManager.client),
    )(request)
  }

  override async roomCreate (
    contactIdList : string[],
    topic         : string,
  ): Promise<string> {
    log.verbose('PuppetService', 'roomCreate(%s, %s)', contactIdList, topic)

    const request = new grpcPuppet.RoomCreateRequest()
    request.setContactIdsList(contactIdList)
    request.setTopic(topic)

    const response = await util.promisify(
      this.grpcManager.client.roomCreate
        .bind(this.grpcManager.client),
    )(request)

    return response.getId()
  }

  override async roomQuit (roomId: string): Promise<void> {
    log.verbose('PuppetService', 'roomQuit(%s)', roomId)

    const request = new grpcPuppet.RoomQuitRequest()
    request.setId(roomId)

    await util.promisify(
      this.grpcManager.client.roomQuit
        .bind(this.grpcManager.client),
    )(request)
  }

  override async roomQRCode (roomId: string): Promise<string> {
    log.verbose('PuppetService', 'roomQRCode(%s)', roomId)

    const request = new grpcPuppet.RoomQRCodeRequest()
    request.setId(roomId)

    const response = await util.promisify(
      this.grpcManager.client.roomQRCode
        .bind(this.grpcManager.client),
    )(request)

    return response.getQrcode()
  }

  override async roomParseDynamicQRCode (url: string): Promise<PUPPET.types.RoomParseDynamicQRCode> {
    log.verbose('PuppetService', 'roomParseDynamicQRCode(%s)', url)

    const request = new grpcPuppet.RoomParseDynamicQRCodeRequest()
    request.setUrl(url)

    const response = await util.promisify(
      this.grpcManager.client.roomParseDynamicQRCode
        .bind(this.grpcManager.client),
    )(request)

    return {
      qrcode: response.getQrcode(),
      qrcodeImageUrl: response.getQrcodeImageUrl(),
      roomName: response.getRoomName(),
    }
  }

  override async roomMemberList (roomId: string) : Promise<string[]> {
    log.verbose('PuppetService', 'roomMemberList(%s)', roomId)

    const request = new grpcPuppet.RoomMemberListRequest()
    request.setId(roomId)

    const response = await util.promisify(
      this.grpcManager.client.roomMemberList
        .bind(this.grpcManager.client),
    )(request)

    return response.getMemberIdsList()
  }

  override async roomMemberRawPayload (roomId: string, contactId: string): Promise<PUPPET.payloads.RoomMember>  {
    log.verbose('PuppetService', 'roomMemberRawPayload(%s, %s)', roomId, contactId)

    const cachedPayload           = await this._payloadStore.roomMember?.get(roomId)
    const cachedRoomMemberPayload = cachedPayload && cachedPayload[contactId]

    if (cachedRoomMemberPayload) {
      log.silly('PuppetService', 'roomMemberRawPayload(%s, %s) cache HIT', roomId, contactId)
      return cachedRoomMemberPayload
    }

    const request = new grpcPuppet.RoomMemberPayloadRequest()
    request.setId(roomId)
    request.setMemberId(contactId)

    const response = await util.promisify(
      this.grpcManager.client.roomMemberPayload
        .bind(this.grpcManager.client),
    )(request)

    const payload: PUPPET.payloads.RoomMember = {
      avatar        : response.getAvatar(),
      id            : response.getId(),
      inviterId     : response.getInviterId(),
      name          : response.getName(),
      roomAlias     : response.getRoomAlias(),
      additionalInfo: response.getAdditionalInfo(),
      joinScene     : response.getJoinScene(),
      joinTime      : response.getJoinTime(),
    }

    await this._payloadStore.roomMember?.set(roomId, {
      ...cachedPayload,
      [contactId]: payload,
    })
    log.silly('PuppetService', 'roomMemberRawPayload(%s, %s) cache SET', roomId, contactId)

    return payload
  }

  override async roomMemberRawPayloadParser (payload: PUPPET.payloads.RoomMember): Promise<PUPPET.payloads.RoomMember>  {
    // log.silly('PuppetService', 'roomMemberRawPayloadParser({id:%s})', payload.id)
    // passthrough
    return payload
  }

  override async batchRoomMemberRawPayload (roomId: string, contactIdList: string[]): Promise<Map<string, PUPPET.payloads.RoomMember>> {
    log.verbose('PuppetService', 'batchRoomMemberRawPayload(%s, %s)', roomId, contactIdList)

    const result = new Map<string, PUPPET.payloads.RoomMember>()
    const contactIdSet = new Set<string>(contactIdList)
    let needGetSet = new Set<string>()
    const cachedPayload = await this._payloadStore.roomMember?.get(roomId) || {}
    if (Object.keys(cachedPayload).length > 0) {
      for (const contactId of contactIdSet) {
        const cachedRoomMemberPayload = cachedPayload[contactId]
        if (cachedRoomMemberPayload) {
          result.set(contactId, cachedRoomMemberPayload)
        } else {
          needGetSet.add(contactId)
        }
      }
    } else {
      needGetSet = contactIdSet
    }

    if (needGetSet.size > 0) {
      try {
        const request = new grpcPuppet.BatchRoomMemberPayloadRequest()
        request.setId(roomId)
        request.setMemberIdsList(Array.from(needGetSet))

        const response = await util.promisify(
          this.grpcManager.client.batchRoomMemberPayload
            .bind(this.grpcManager.client),
        )(request)

        const payloads = response.getMemberPayloadsList()
        for (const payload of payloads) {
          const contactId = payload.getId()
          const puppetPayload = roomMemberPbToPayload(payload)
          result.set(contactId, puppetPayload)
          cachedPayload[contactId] = puppetPayload
        }
        await this._payloadStore.roomMember?.set(roomId, cachedPayload)
      } catch (e) {
        log.error('PuppetService', 'batchRoomMemberRawPayload(%s, %s) error: %s, use one by one method', roomId, needGetSet, e)
        for (const contactId of needGetSet) {
          const payload = await this.roomMemberRawPayload(roomId, contactId)
          result.set(contactId, payload)
        }
      }
    }
    return result
  }

  override async roomAnnounce (roomId: string)                : Promise<string>
  override async roomAnnounce (roomId: string, text: string)  : Promise<void>

  override async roomAnnounce (roomId: string, text?: string) : Promise<void | string> {
    log.verbose('PuppetService', 'roomAnnounce(%s%s)',
      roomId,
      typeof text === 'undefined'
        ? ''
        : `, ${text}`,
    )

    /**
     * Set
     */
    if (typeof text === 'string') {
      const request = new grpcPuppet.RoomAnnounceRequest()
      request.setId(roomId)
      request.setText(text)

      {
        // DEPRECATED, will be removed after Dec 31, 2022
        const textWrapper = new StringValue()
        textWrapper.setValue(text)
        request.setTextStringValueDeprecated(textWrapper)
      }

      await util.promisify(
        this.grpcManager.client.roomAnnounce
          .bind(this.grpcManager.client),
      )(request)

      return
    }

    /**
     * Get
     */
    const request = new grpcPuppet.RoomAnnounceRequest()
    request.setId(roomId)

    const response = await util.promisify(
      this.grpcManager.client.roomAnnounce
        .bind(this.grpcManager.client),
    )(request)

    const result = response.getText()
    if (result) {
      return result
    }

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const textWrapper = response.getTextStringValueDeprecated()
      if (textWrapper) {
        return textWrapper.getValue()
      }
    }

    return ''
  }

  override async roomInvitationAccept (
    roomInvitationId: string,
  ): Promise<void> {
    log.verbose('PuppetService', 'roomInvitationAccept(%s)', roomInvitationId)

    const request = new grpcPuppet.RoomInvitationAcceptRequest()
    request.setId(roomInvitationId)

    await util.promisify(
      this.grpcManager.client.roomInvitationAccept
        .bind(this.grpcManager.client),
    )(request)
  }

  override async roomInvitationAcceptByQRCode (
    qrcode: string,
  ): Promise<PUPPET.types.RoomInvitationAcceptByQRCode> {
    log.verbose('PuppetService', 'roomInvitationAcceptByQRCode(%s)', qrcode)

    const request = new grpcPuppet.RoomInvitationAcceptByQRCodeRequest()
    request.setQrcode(qrcode)

    const response = await util.promisify(
      this.grpcManager.client.roomInvitationAcceptByQRCode
        .bind(this.grpcManager.client),
    )(request)

    return {
      roomId: response.getRoomId(),
      chatId: response.getChatId(),
    }
  }

  override async roomInvitationRawPayload (
    id: string,
  ): Promise<PUPPET.payloads.RoomInvitation> {
    log.verbose('PuppetService', 'roomInvitationRawPayload(%s)', id)

    const request = new grpcPuppet.RoomInvitationPayloadRequest()
    request.setId(id)

    const response = await util.promisify(
      this.grpcManager.client.roomInvitationPayload
        .bind(this.grpcManager.client),
    )(request)

    let timestamp
    const receiveTime = response.getReceiveTime()
    if (receiveTime) {
      timestamp = millisecondsFromTimestamp(receiveTime)
    }

    {
      // Deprecated: will be removed after Dec 31, 2022
      const deprecated = true
      void deprecated

      if (!receiveTime) {
        timestamp = response.getTimestampUint64Deprecated()
      }
    }

    // FIXME: how to set it better?
    timestamp ??= 0

    const payload: PUPPET.payloads.RoomInvitation = {
      avatar       : response.getAvatar(),
      id           : response.getId(),
      invitation   : response.getInvitation(),
      inviterId    : response.getInviterId(),
      memberCount  : response.getMemberCount(),
      memberIdList : response.getMemberIdsList(),
      receiverId   : response.getReceiverId(),
      timestamp,
      topic        : response.getTopic(),
    }

    return payload
  }

  override async roomInvitationRawPayloadParser (payload: PUPPET.payloads.RoomInvitation): Promise<PUPPET.payloads.RoomInvitation> {
    // log.silly('PuppetService', 'roomInvitationRawPayloadParser({id:%s})', payload.id)
    // passthrough
    return payload
  }

  override async roomPermission (roomId: string, permission?: Partial<PUPPET.types.RoomPermission>): Promise<void | Partial<PUPPET.types.RoomPermission>> {
    log.verbose('PuppetService', 'roomPermission(%s, %s)', roomId, JSON.stringify(permission))

    const request = new grpcPuppet.RoomPermissionRequest()
    request.setId(roomId)

    let set = false

    if (permission) {
      set = true
      request.setInviteConfirm(OptionalBooleanWrapper(permission.inviteConfirm))
      request.setAdminOnlyManage(OptionalBooleanWrapper(permission.adminOnlyManage))
      request.setAdminOnlyAtAll(OptionalBooleanWrapper(permission.adminOnlyAtAll))
      request.setMuteAll(OptionalBooleanWrapper(permission.muteAll))
      request.setForbidRoomTopicEdit(OptionalBooleanWrapper(permission.forbidRoomTopicEdit))
      request.setDisableMemberMutualAdd(OptionalBooleanWrapper(permission.disableMemberMutualAdd))
    }

    const response = await util.promisify(
      this.grpcManager.client.roomPermission
        .bind(this.grpcManager.client),
    )(request)

    const result: Partial<PUPPET.types.RoomPermission> = {
      inviteConfirm: OptionalBooleanUnwrapper(response.getInviteConfirm()),
      adminOnlyManage: OptionalBooleanUnwrapper(response.getAdminOnlyManage()),
      adminOnlyAtAll: OptionalBooleanUnwrapper(response.getAdminOnlyAtAll()),
      muteAll: OptionalBooleanUnwrapper(response.getMuteAll()),
      forbidRoomTopicEdit: OptionalBooleanUnwrapper(response.getForbidRoomTopicEdit()),
      disableMemberMutualAdd: OptionalBooleanUnwrapper(response.getDisableMemberMutualAdd()),
    }

    return set ? undefined : result
  }

  override async roomOwnerTransfer (roomId: string, contactId: string): Promise<void> {
    log.verbose('PuppetService', 'roomOwnerTransfer(%s, %s)', roomId, contactId)

    const request = new grpcPuppet.RoomOwnerTransferRequest()
    request.setId(roomId)
    request.setContactId(contactId)

    await util.promisify(
      this.grpcManager.client.roomOwnerTransfer
        .bind(this.grpcManager.client),
    )(request)
  }

  override async roomAddAdmins (
    roomId     : string,
    contactIdList  : string[],
  ): Promise<void> {
    log.verbose('PuppetService', 'roomAddAdmins(%s, %s)', roomId, contactIdList)

    const request = new grpcPuppet.RoomAdminsRequest()
    request.setId(roomId)
    request.setContactIdsList(contactIdList)

    await util.promisify(
      this.grpcManager.client.roomAddAdmins
        .bind(this.grpcManager.client),
    )(request)
  }

  override async roomDelAdmins (
    roomId    : string,
    contactIdList : string[],
  ): Promise<void> {
    log.verbose('PuppetService', 'roomDelAdmins(%s, %s)', roomId, contactIdList)

    const request = new grpcPuppet.RoomAdminsRequest()
    request.setId(roomId)
    request.setContactIdsList(contactIdList)

    await util.promisify(
      this.grpcManager.client.roomDelAdmins
        .bind(this.grpcManager.client),
    )(request)
  }

  override async roomDismiss (roomId: string): Promise<void> {
    log.verbose('PuppetService', 'roomDelAdmins(%s)', roomId)

    const request = new grpcPuppet.RoomDismissRequest()
    request.setId(roomId)

    await util.promisify(
      this.grpcManager.client.roomDismiss
        .bind(this.grpcManager.client),
    )(request)
  }

  /**
   *
   * Friendship
   *
   */
  override async friendshipSearchPhone (
    phone: string,
    type?: Contact,
  ): Promise<string | null> {
    log.verbose('PuppetService', 'friendshipSearchPhone(%s)', phone)

    const request = new grpcPuppet.FriendshipSearchPhoneRequest()
    request.setPhone(phone)

    if (typeof (type) === 'undefined') {
      request.setType(grpcPuppet.ContactType.CONTACT_TYPE_PERSONAL)
    } else {
      request.setType(type)
    }

    const response = await util.promisify(
      this.grpcManager.client.friendshipSearchPhone
        .bind(this.grpcManager.client),
    )(request)

    const contactId = response.getContactId()
    if (contactId) {
      return contactId
    }

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const contactIdWrapper = response.getContactIdStringValueDeprecated()
      if (contactIdWrapper) {
        return contactIdWrapper.getValue()
      }
    }

    return null
  }

  override async friendshipSearchHandle (
    handle: string,
    type?: Contact,
  ): Promise<string | null> {
    log.verbose('PuppetService', 'friendshipSearchHandle(%s)', handle)

    const request = new grpcPuppet.FriendshipSearchHandleRequest()
    /**
     * TODO: use `setHandle()` in v2.0.0
     *  @link https://github.com/wechaty/grpc/issues/174
     */
    request.setWeixin(handle)
    if (typeof (type) === 'undefined') {
      request.setType(grpcPuppet.ContactType.CONTACT_TYPE_PERSONAL)
    } else {
      request.setType(type)
    }

    const response = await util.promisify(
      this.grpcManager.client.friendshipSearchHandle
        .bind(this.grpcManager.client),
    )(request)

    const contactId = response.getContactId()
    if (contactId) {
      return contactId
    }

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const contactIdWrapper = response.getContactIdStringValueDeprecated()
      if (contactIdWrapper) {
        return contactIdWrapper.getValue()
      }
    }

    return null
  }

  override async friendshipRawPayload (id: string): Promise<PUPPET.payloads.Friendship> {
    log.verbose('PuppetService', 'friendshipRawPayload(%s)', id)

    const request = new grpcPuppet.FriendshipPayloadRequest()
    request.setId(id)

    const response = await util.promisify(
      this.grpcManager.client.friendshipPayload
        .bind(this.grpcManager.client),
    )(request)

    const payload: PUPPET.payloads.Friendship = {
      contactId : response.getContactId(),
      hello: response.getHello(),
      id,
      scene     : response.getScene() as number,
      stranger  : response.getStranger(),
      ticket    : response.getTicket(),
      type      : response.getType() as number,
    } as any  // FIXME: Huan(202002)

    return payload
  }

  override async friendshipRawPayloadParser (payload: PUPPET.payloads.Friendship) : Promise<PUPPET.payloads.Friendship> {
    // log.silly('PuppetService', 'friendshipRawPayloadParser({id:%s})', payload.id)
    // passthrough
    return payload
  }

  override async friendshipAdd (
    contactId : string,
    options   : PUPPET.types.FriendshipAddOptions,
  ): Promise<void> {
    log.verbose('PuppetService', 'friendshipAdd(%s, %s)', contactId, JSON.stringify(options))

    const request = new grpcPuppet.FriendshipAddRequest()
    request.setContactId(contactId)

    // FIXME: for backward compatibility, need to be removed after all puppet has updated.
    if (typeof options === 'string') {
      request.setHello(options)
    } else {
      request.setHello(options.hello!)

      const referrer = new grpcPuppet.Referrer()
      if (options.contactId)  { referrer.setContactId(options.contactId) }
      if (options.roomId)     { referrer.setRoomId(options.roomId) }
      request.setReferrer(referrer)

      {
        // Deprecated: will be removed after Dec 31, 2022
        const contactIdWrapper = new StringValue()
        contactIdWrapper.setValue(options.contactId || '')
        const roomIdWrapper = new StringValue()
        roomIdWrapper.setValue(options.roomId || '')
        request.setSourceRoomIdStringValueDeprecated(roomIdWrapper)
        request.setSourceContactIdStringValueDeprecated(contactIdWrapper)
      }
    }

    await util.promisify(
      this.grpcManager.client.friendshipAdd
        .bind(this.grpcManager.client),
    )(request)
  }

  override async friendshipAccept (
    friendshipId : string,
  ): Promise<void> {
    log.verbose('PuppetService', 'friendshipAccept(%s)', friendshipId)

    const request = new grpcPuppet.FriendshipAcceptRequest()
    request.setId(friendshipId)

    await util.promisify(
      this.grpcManager.client.friendshipAccept
        .bind(this.grpcManager.client),
    )(request)
  }

  /**
   *
   * Tag
   *
   */

  override async tagContactTagAdd (
    tagIds: string[],
    contactIds: string[],
  ): Promise<void> {
    log.verbose('PuppetService', 'tagContactTagAdd(%s, %s)', tagIds, contactIds)

    const request = new grpcPuppet.TagContactTagAddRequest()

    request.setTagIdsList(tagIds)
    request.setContactIdsList(contactIds)

    await util.promisify(
      this.grpcManager.client.tagContactTagAdd
        .bind(this.grpcManager.client),
    )(request)
  }

  override async tagContactTagRemove (
    tagIds: string[],
    contactIds: string[],
  ): Promise<void> {
    log.verbose('PuppetService', 'tagContactTagRemove(%s, %s)', tagIds, contactIds)

    const request = new grpcPuppet.TagContactTagRemoveRequest()

    request.setTagIdsList(tagIds)
    request.setContactIdsList(contactIds)

    await util.promisify(
      this.grpcManager.client.tagContactTagRemove
        .bind(this.grpcManager.client),
    )(request)
  }

  override async tagGroupAdd (
    tagGroupName: string,
  ): Promise<string | void> {
    log.verbose('PuppetService', 'tagGroupAdd(%s)', tagGroupName)

    const request = new grpcPuppet.TagGroupAddRequest()

    request.setTagGroupName(tagGroupName)

    const result = await util.promisify(
      this.grpcManager.client.tagGroupAdd
        .bind(this.grpcManager.client),
    )(request)

    const id = result.getTagGroupId()

    return id
  }

  override async tagGroupDelete (
    tagGroupId: string,
  ): Promise<void> {
    log.verbose('PuppetService', 'tagGroupDelete(%s)', tagGroupId)

    const request = new grpcPuppet.TagGroupDeleteRequest()

    request.setTagGroupId(tagGroupId)

    await util.promisify(
      this.grpcManager.client.tagGroupDelete
        .bind(this.grpcManager.client),
    )(request)

  }

  override async tagTagAdd (
    tagNameList: string[],
    tagGroupId?: string,
  ): Promise<PUPPET.types.TagInfo[] | void> {
    log.verbose('PuppetService', 'tagTagAdd(%s, %s)', tagNameList, tagGroupId)

    const request = new grpcPuppet.TagTagAddRequest()

    if (typeof tagGroupId !== 'undefined') {
      request.setTagGroupId(tagGroupId)
    }
    request.setTagNameList(tagNameList)

    const result = await util.promisify(
      this.grpcManager.client.tagTagAdd
        .bind(this.grpcManager.client),
    )(request)

    const tagInfoList:PUPPET.types.TagInfo[] = result.getTagInfoList().map(i => ({
      id  : i.getTagId(),
      name: i.getTagName(),
    }))

    return tagInfoList
  }

  override async tagTagDelete (
    tagIdList: string[],
  ): Promise<void> {
    log.verbose('PuppetService', 'tagTagDelete(%s)', tagIdList)

    const request = new grpcPuppet.TagTagDeleteRequest()
    request.setTagIdList(tagIdList)

    await util.promisify(
      this.grpcManager.client.tagTagDelete
        .bind(this.grpcManager.client),
    )(request)

  }

  override async tagTagModify (
    tagNewInfoList: PUPPET.types.TagInfo[],
  ): Promise<PUPPET.types.TagInfo[] | void> {
    log.verbose('PuppetService', 'tagTagModify(%o)', tagNewInfoList)

    const request = new grpcPuppet.TagTagModifyRequest()
    const newInfoList = tagNewInfoList.map(i => {
      const tagInfo = new grpcPuppet.TagTagInfo()
      tagInfo.setTagId(i.id)
      tagInfo.setTagName(i.name)
      return tagInfo
    })
    request.setTagNewInfoList(newInfoList)

    const result = await util.promisify(
      this.grpcManager.client.tagTagModify
        .bind(this.grpcManager.client),
    )(request)

    const tagInfoList:PUPPET.types.TagInfo[] = result.getTagInfoList().map(i => ({
      id  : i.getTagId(),
      name: i.getTagName(),
    }))

    return tagInfoList
  }

  override async tagGroupList (): Promise<string[]> {
    log.verbose('PuppetService', 'tagGroupList()')

    const request = new grpcPuppet.TagGroupListRequest()

    const result = await util.promisify(
      this.grpcManager.client.tagGroupList
        .bind(this.grpcManager.client),
    )(request)

    const groupIds = result.getTagGroupIdsList()
    return groupIds
  }

  override async tagGroupTagList (
    tagGroupId?: string,
  ): Promise<string[]> {
    log.verbose('PuppetService', 'tagGroupTagList(%s)', tagGroupId)

    const request = new grpcPuppet.TagGroupTagListRequest()
    if (typeof tagGroupId !== 'undefined') {
      request.setTagGroupId(tagGroupId)
    }

    const result = await util.promisify(
      this.grpcManager.client.tagGroupTagList
        .bind(this.grpcManager.client),
    )(request)

    const tagIds = result.getTagIdsList()
    return tagIds
  }

  override async tagTagList (
  ): Promise<string[]> {
    log.verbose('PuppetService', 'tagTagList()')

    const request = new grpcPuppet.TagTagListRequest()

    const result = await util.promisify(
      this.grpcManager.client.tagTagList
        .bind(this.grpcManager.client),
    )(request)

    const tagIds = result.getTagIdsList()
    return tagIds
  }

  override async tagContactTagList (
    contactId: string,
  ): Promise<string[]> {
    log.verbose('PuppetService', 'tagContactTagList(%s)', contactId)

    const request = new grpcPuppet.TagContactTagListRequest()
    request.setContactId(contactId)

    const result = await util.promisify(
      this.grpcManager.client.tagContactTagList
        .bind(this.grpcManager.client),
    )(request)

    const tagIds = result.getTagIdsList()
    return tagIds
  }

  override async tagTagContactList (
    tagId: string,
  ): Promise<string[]> {
    log.verbose('PuppetService', 'tagTagContactList(%s)', tagId)

    const request = new grpcPuppet.TagTagContactListRequest()
    request.setTagId(tagId)

    const result = await util.promisify(
      this.grpcManager.client.tagTagContactList
        .bind(this.grpcManager.client),
    )(request)

    const contactIds = result.getContactIdsList()
    return contactIds
  }

  override async tagGroupPayloadPuppet (id: string): Promise<PUPPET.payloads.TagGroup> {
    log.verbose('PuppetService', 'tagGroupPayload(%s)', id)

    const cachedPayload = await this._payloadStore.tagGroup?.get(id)
    if (cachedPayload) {
      log.silly('PuppetService', 'tagGroupPayload(%s) cache HIT', id)
      return cachedPayload
    }

    const request = new grpcPuppet.TagGroupPayloadRequest()
    request.setGroupId(id)

    const response = await util.promisify(
      this.grpcManager.client.tagGroupPayload
        .bind(this.grpcManager.client),
    )(request)
    const grpcPayload = response.getPayload()

    if (!grpcPayload) {
      throw new Error(`tagGroup ${id} got no payload!`)
    }

    const payload: PUPPET.payloads.TagGroup = {
      id: grpcPayload.getId(),
      name: grpcPayload.getName(),
      type: grpcPayload.getType(),
    }

    await this._payloadStore.tagGroup?.set(id, payload)
    log.silly('PuppetService', 'tagGroupPayloadPuppet(%s) cache SET', id)

    return payload
  }

  override async tagPayloadPuppet (tagId: string): Promise<PUPPET.payloads.Tag> {
    log.verbose('PuppetService', 'tagPayloadPuppet(%s)', tagId)

    const cachedPayload = await this._payloadStore.tag?.get(tagId)
    if (cachedPayload) {
      log.silly('PuppetService', 'tagPayloadPuppet(%s) cache HIT', tagId)
      return cachedPayload
    }

    const request = new grpcPuppet.TagPayloadRequest()
    request.setTagId(tagId)

    const response = await util.promisify(
      this.grpcManager.client.tagPayload
        .bind(this.grpcManager.client),
    )(request)
    const grpcPayload = response.getPayload()

    if (!grpcPayload) {
      throw new Error(`tag ${tagId} got no payload!`)
    }

    const payload: PUPPET.payloads.Tag = {
      id: grpcPayload.getId(),
      name: grpcPayload.getName(),
      groupId: grpcPayload.getGroupId(),
      type: grpcPayload.getType(),
    }

    await this._payloadStore.tag?.set(tagId, payload)
    log.silly('PuppetService', 'tagPayloadPuppet(%s) cache SET', tagId)

    return payload
  }

  /**
   *
   * Post & Moment Section
   *
   */

  override async postPublish (payload: PUPPET.payloads.Post): Promise<void | string> {
    log.verbose('PuppetService', 'postPublish(%s)', payload)

    if (!PUPPET.payloads.isPostClient(payload)) {
      throw new Error('can only publish client post now')
    }
    const request = new grpcPuppet.MomentPublishRequest()
    const post = await postPayloadToPb(grpcPuppet, payload, this.serializeFileBox.bind(this))
    request.setPost(post)

    const result = await util.promisify(
      this.grpcManager.client.momentPublish
        .bind(this.grpcManager.client),
    )(request)

    const momentId = result.getMomentId()

    return momentId
  }

  override async postUnpublish (id: string): Promise<void> {
    log.verbose('PuppetService', 'postUnpublish(%s)', id)

    const request = new grpcPuppet.MomentUnpublishRequest()
    request.setMomentId(id)

    await util.promisify(
      this.grpcManager.client.momentUnpublish.bind(this.grpcManager.client),
    )(request)
  }

  override async momentSignature (text?: string): Promise<void | string> {
    log.verbose('PuppetService', 'momentSignature(%s)', text)

    const request = new grpcPuppet.MomentSignatureRequest()
    if (text) {
      request.setText(text)
    }

    const response = await util.promisify(
      this.grpcManager.client.momentSignature
        .bind(this.grpcManager.client),
    )(request)

    const signature = response.getText()

    return signature
  }

  override async momentCoverage (cover?: FileBoxInterface | undefined): Promise<void | FileBoxInterface> {
    log.verbose('PuppetService', 'momentCoverage(%s)', JSON.stringify(cover))

    const request = new grpcPuppet.MomentCoverageRequest()
    if (cover) {
      const serializedFileBox = await this.serializeFileBox(cover)
      request.setFileBox(serializedFileBox)
    }

    const response = await util.promisify(
      this.grpcManager.client.momentCoverage
        .bind(this.grpcManager.client),
    )(request)

    const jsonText = response.getFileBox()
    if (jsonText) {
      return this.FileBoxUuid.fromJSON(jsonText)
    }
  }

  override async postPayloadSayable (postId: string, sayableId: string): Promise<PUPPET.payloads.Sayable> {
    log.verbose('PuppetService', 'postPayloadSayable(%s, %s)', postId, sayableId)

    const request = new grpcPuppet.PostPayloadSayableRequest()
    request.setPostId(postId)
    request.setSayableId(sayableId)

    const response = await util.promisify(
      this.grpcManager.client.postPayloadSayable
        .bind(this.grpcManager.client),
    )(request)

    const sayable = response.getSayable()
    let sayablePayload: PUPPET.payloads.Sayable | undefined

    if (sayable) {
      switch (sayable.getType()) {
        case grpcPuppet.SayableType.SAYABLE_TYPE_TEXT:
          sayablePayload = PUPPET.payloads.sayable.text(sayable.getText() || '', sayable.getMentionIdListList())
          break
        case grpcPuppet.SayableType.SAYABLE_TYPE_FILE: {
          const fileJsonStr = sayable.getFileBox()
          if (!fileJsonStr) {
            break
          }
          const file = this.FileBoxUuid.fromJSON(fileJsonStr)
          sayablePayload = PUPPET.payloads.sayable.attachment(file)
          break
        }
        case grpcPuppet.SayableType.SAYABLE_TYPE_URL: {
          const urlLinkPayloadPb = sayable.getUrlLink()
          if (!urlLinkPayloadPb) {
            break
          }
          const urlLinkPayload = urlLinkPbToPayload(urlLinkPayloadPb)
          sayablePayload = PUPPET.payloads.sayable.url(urlLinkPayload)
          break
        }
        case grpcPuppet.SayableType.SAYABLE_TYPE_CHANNEL: {
          const channelPayloadPb = sayable.getChannel()
          if (!channelPayloadPb) {
            break
          }
          const channelPayload = channelPbToPayload(channelPayloadPb!)
          sayablePayload = PUPPET.payloads.sayable.channel(channelPayload)
          break
        }
        default:
          throw new Error(`unsupported postSayableType type ${sayable.getType()}`)
      }
    }
    if (!sayablePayload) {
      throw new Error(`cannot get sayable ${sayableId} from post ${postId}`)
    } else {
      return sayablePayload
    }
  }

  override async postRawPayload (id: string): Promise<PUPPET.payloads.Post> {
    log.verbose('PuppetService', 'postRawPayload(%s)', id)

    const request = new grpcPuppet.PostPayloadRequest()
    request.setPostId(id)

    const response = await util.promisify(
      this.grpcManager.client.postPayload
        .bind(this.grpcManager.client),
    )(request)

    const postPb = response.getPost()
    if (!postPb) {
      throw new Error(`failed to get post for id ${id}`)
    }
    const timestamp = postPb.getTimestamp()
    const payload: PUPPET.payloads.PostServer = {
      id,
      parentId: postPb.getParentId(),
      rootId: postPb.getRootId(),
      type: postPb.getType() || PUPPET.types.Post.Unspecified,
      sayableList: [],
      contactId: postPb.getContactId(),
      timestamp: timestamp ? millisecondsFromTimestamp(timestamp) : Date.now(),
      counter: {
        children: postPb.getChildren(),
        descendant: postPb.getDescendant(),
        taps: {
          [PUPPET.types.Tap.Like]: postPb.getLike(),
        },
      },
      visibleList: postPb.getVisibleListList(),
    }
    const sayablePbList = postPb.getSayableListList()
    for (const sayablePb of sayablePbList) {
      payload.sayableList.push(sayablePb.getId())
    }
    const location = postPb.getLocation()
    if (location) {
      payload.location = {
        latitude: location.getLatitude(),
        longitude: location.getLongitude(),
        accuracy: location.getAccuracy(),
        address: location.getAddress(),
        name: location.getName(),
      }
    }

    return payload
  }

  override async postRawPayloadParser (payload: PUPPET.payloads.Post): Promise<PUPPET.payloads.Post> {
    // log.silly('PuppetService', 'postRawPayloadParser({id:%s})', payload.id)
    // passthrough
    return payload
  }

  override async tap (postId: string, type?: PUPPET.types.Tap, tap = true): Promise<boolean | void> {
    log.verbose('PuppetService', 'tap(%s, %s, %s)', postId, type, tap)

    const request = new grpcPuppet.PostTapRequest()
    request.setPostId(postId)
    if (type) { request.setType(type) }
    request.setTap(tap)

    const response = await util.promisify(
      this.grpcManager.client.postTap
        .bind(this.grpcManager.client),
    )(request)

    const result = response.getTap()

    return result
  }

  override async momentVisibleList (): Promise<string[]> {
    log.verbose('PuppetService', 'momentVisibleList()')

    const request = new grpcPuppet.MomentVisibleListRequest()

    const response = await util.promisify(
      this.grpcManager.client.momentVisibleList.bind(this.grpcManager.client),
    )(request)

    const contactIdsList = response.getContactIdsList()

    return contactIdsList
  }

  override async getContactExternalUserId (
    contactIds: string[],
    serviceProviderId?: string,
  ): Promise<PUPPET.types.ContactIdExternalUserIdPair[]> {
    log.verbose('PuppetService', 'getContactExternalUserId(%s, %s)', JSON.stringify(contactIds), serviceProviderId)

    const request = new grpcPuppet.GetContactExternalUserIdRequest()

    request.setContactIdsList(contactIds)
    if (serviceProviderId) {
      request.setServiceProviderId(serviceProviderId)
    }
    const response = await util.promisify(
      this.grpcManager.client.getContactExternalUserId.bind(this.grpcManager.client),
    )(request)

    const pairs = response.getContactExternalUserIdPairsList()
    const result: PUPPET.types.ContactIdExternalUserIdPair[] = []
    for (const pair of pairs) {
      result.push({
        contactId: pair.getContactId(),
        externalUserId: pair.getExternalUserId(),
      })
    }

    return result
  }

  override async getRoomAntiSpamStrategyList (): Promise<PUPPET.types.RoomAntiSpamStrategy[]> {
    log.verbose('PuppetService', 'getRoomAntiSpamStrategyList()')

    const request = new grpcPuppet.GetRoomAntiSpamStrategyListRequest()

    const response = await util.promisify(
      this.grpcManager.client.getRoomAntiSpamStrategyList.bind(this.grpcManager.client),
    )(request)

    const result: PUPPET.types.RoomAntiSpamStrategy[] = []
    const strategies = response.getStrategiesList()

    for (const strategy of strategies) {
      result.push({
        id: strategy.getId(),
        name: strategy.getName(),
      })
    }

    return result
  }

  override async getRoomAntiSpamStrategyEffectRoomList (strategyId: string): Promise<string[]> {
    log.verbose('PuppetService', 'getRoomAntiSpamStrategyEffectRoomList(%s)', strategyId)

    const request = new grpcPuppet.GetRoomAntiSpamStrategyEffectRoomListRequest()
    request.setStrategyId(strategyId)

    const response = await util.promisify(
      this.grpcManager.client.getRoomAntiSpamStrategyEffectRoomList.bind(this.grpcManager.client),
    )(request)

    const result = response.getRoomIdsList()

    return result
  }

  override async applyRoomAntiSpamStrategy (strategyId: string, roomIds: string[], active: boolean): Promise<void> {
    log.verbose('PuppetService', 'applyRoomAntiSpamStrategy(%s, %s, %s)', strategyId, roomIds, active)

    const request = new grpcPuppet.ApplyRoomAntiSpamStrategyRequest()
    request.setStrategyId(strategyId)
    request.setRoomIdsList(roomIds)
    request.setActive(active)

    await util.promisify(
      this.grpcManager.client.applyRoomAntiSpamStrategy.bind(this.grpcManager.client),
    )(request)
  }

  override async getCorpMessageInterceptionStrategies (): Promise<PUPPET.types.CorpMessageInterceptionStrategy[]> {
    log.verbose('PuppetService', 'getCorpMessageInterceptionStrategies()')

    const request = new grpcPuppet.GetCorpMessageInterceptionStrategiesRequest()

    const response = await util.promisify(
      this.grpcManager.client.getCorpMessageInterceptionStrategies.bind(this.grpcManager.client),
    )(request)

    const result: PUPPET.types.CorpMessageInterceptionStrategy[] = []

    for (const strategyPb of response.getStrategiesList()) {
      const strategy: PUPPET.types.CorpMessageInterceptionStrategy = {
        name: strategyPb.getName(),
        words: strategyPb.getWordsList(),
        phoneNumber: strategyPb.getPhoneNumber(),
        email: strategyPb.getEmail(),
        redPacket: strategyPb.getRedPacket(),
        type: strategyPb.getType(),
      }
      result.push(strategy)
    }

    return result
  }

  healthCheckInterval?: NodeJS.Timeout
  startHealthCheck () {
    this.healthCheckInterval = setInterval(() => {
      this.ding('healthCheck')
    }, 60 * 1000)
  }

  stopHealthCheck () {
    clearInterval(this.healthCheckInterval!)
  }

  // handle watchdog reset
  // goal: pain free reset of reconnect within threshold (like 30 seconds?)

  private waitingForLogin = false
  private waitingForReady = false
  private reconnectIndicator: BooleanIndicator
  override async reset (): Promise<void> {
    if (!this._grpcManager) {
      log.warn('PuppetService', 'grpc manager not constructed, perform regular reset')
      return super.reset()
    }

    if (!this.isLoggedIn) {
      log.warn('PuppetService', 'puppet not logged in, perform regular reset')
      return super.reset()
    }

    if (this.reconnectIndicator.value()) {
      log.warn('PuppetService', 'already trying to reconnect, pass this one')
      return
    }

    this.reconnectIndicator.value(true)

    this.grpcManager.stopStream()
    const { lastEventSeq, accountId } = await this.getMiscellaneousStoreData()

    const onLoginResolve = (resolve: () => void) => {
      const onLogin = (event: grpcPuppet.EventResponse) => {
        const type = event.getType()
        const payload = event.getPayload()
        if (this.waitingForLogin && type === grpcPuppet.EventType.EVENT_TYPE_LOGIN) {
          const payloadObj = JSON.parse(payload) as PUPPET.payloads.EventLogin
          this.waitingForLogin = false
          if (accountId && payloadObj.contactId !== accountId) {
            throw new Error('login with a different account, perform regular reset')
          }
          resolve()
        }
      }
      return onLogin
    }
    const onReadyResolve = (resolve: () => void) => {
      const onReady = (event: grpcPuppet.EventResponse) => {
        const type = event.getType()
        if (this.waitingForReady && type === grpcPuppet.EventType.EVENT_TYPE_READY) {
          this.waitingForReady = false
          resolve()
        }
      }
      return onReady
    }

    let onLogin: ReturnType<typeof onLoginResolve>
    let onReady: ReturnType<typeof onReadyResolve>
    const loginFuture = new Promise<void>(resolve => {
      onLogin = onLoginResolve(resolve)
      this.grpcManager.on('data', onLogin)
    })
    const readyFuture = new Promise<void>(resolve => {
      onReady = onReadyResolve(resolve)
      this.grpcManager.on('data', onReady)
    })

    const startTime = Date.now()
    const timeoutMilliseconds = this.timeoutMilliseconds / 10 // 2 min default, 4 min xiaoju-bot
    while (true) {
      try {
        await timeoutPromise(this.grpcManager.startStream(lastEventSeq, accountId), 30 * 1000)
        break
      } catch (e) {
        if (Date.now() - startTime < timeoutMilliseconds) {
          log.warn('failed to start stream, will try again in 15 seconds')
          await new Promise(resolve => {
            setTimeout(resolve, 5000)
          })
        } else {
          log.warn('failed to start stream and reaches timeout, will perform regular reset')
          this.reconnectIndicator.value(false)
          return super.reset()
        }
      }
    }

    this.waitingForLogin = true
    this.waitingForReady = true

    try {
      await timeoutPromise(loginFuture, ResetLoginTimeout)
        .finally(() => {
          this.waitingForLogin = false
          this.reconnectIndicator.value(false)
          this.grpcManager.off('data', onLogin)
        })
    } catch (e) {
      log.warn('PuppetService', 'waiting for event reset login error, will perform regular reset')
      return super.reset()
    }
    try {
      await timeoutPromise(readyFuture, ResetReadyTimeout)
        .finally(() => {
          this.waitingForReady = false
          this.grpcManager.off('data', onReady)
        })
    } catch (e) {
      log.warn('PuppetService', 'waiting for event reset ready error, will do nothing')
    }
  }

  async getMiscellaneousStoreData () {
    if (envVars.WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE()) {
      return {
        lastEventSeq: undefined,
        lastEventTimestamp: undefined,
        accountId: '',
      }
    }
    const lastEventTimestamp = await this._payloadStore.miscellaneous?.get('lastEventTimestamp')
    let lastEventSeq = await this._payloadStore.miscellaneous?.get('lastEventSeq')
    if ((Date.now() - Number(lastEventTimestamp || 0)) > this.timeoutMilliseconds) {
      log.warn(`last event was ${(Date.now() - Number(lastEventTimestamp || 0)) / 1000} seconds ago, will not request event cache`)
      lastEventSeq = undefined
    }
    const accountId = await this._payloadStore.miscellaneous?.get('accountId')

    return {
      lastEventSeq,
      lastEventTimestamp,
      accountId,
    }
  }

  async setMiscellaneousStoreData (data: {
    lastEventSeq?: string,
    lastEventTimestamp?: string,
    accountId?: string,
  }) {
    if (envVars.WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE()) {
      return
    }
    if (typeof data.lastEventSeq !== 'undefined') {
      await this._payloadStore.miscellaneous?.set('lastEventSeq', data.lastEventSeq)
    }
    if (typeof data.lastEventTimestamp !== 'undefined') {
      await this._payloadStore.miscellaneous?.set('lastEventTimestamp', data.lastEventTimestamp)
    }
    if (typeof data.accountId !== 'undefined') {
      await this._payloadStore.miscellaneous?.set('accountId', data.accountId)
    }
  }

  async resetMiscellaneousStoreData () {
    if (envVars.WECHATY_PUPPET_SERVICE_DISABLE_EVENT_CACHE()) {
      return
    }
    await this._payloadStore.miscellaneous?.delete('lastEventSeq')
    await this._payloadStore.miscellaneous?.delete('lastEventTimestamp')
    await this._payloadStore.miscellaneous?.delete('accountId')
  }

}

export {
  PuppetService,
}
export default PuppetService
