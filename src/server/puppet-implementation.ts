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
/* eslint-disable sort-keys */
/* eslint-disable @typescript-eslint/no-misused-promises */
import type { Writable }    from 'stream'
import {
  chunkDecoder,
  chunkEncoder,
  StringValue,
  grpc,
  puppet as grpcPuppet,
}                           from '@juzi/wechaty-grpc'
import type {
  FileBoxInterface,
  FileBox,
}                           from 'file-box'
import * as PUPPET          from '@juzi/wechaty-puppet'
import { timeoutPromise }   from 'gerror'

import {
  timestampFromMilliseconds,
}                             from '../pure-functions/timestamp.js'
import {
  normalizeFileBoxUuid,
}                             from '../file-box-helper/mod.js'
import { log } from '../config.js'
import { grpcError }          from './grpc-error.js'
import { EventStreamManager } from './event-stream-manager.js'
import { OptionalBooleanUnwrapper, OptionalBooleanWrapper, callRecordPayloadToPb, channelPayloadToPb, chatHistoryPayloadToPb, postPbToPayload, urlLinkPayloadToPb } from '../utils/pb-payload-helper.js'
import { TextContentType } from '@juzi/wechaty-puppet/types'

function puppetImplementation (
  puppet      : PUPPET.impls.PuppetInterface,
  FileBoxUuid : typeof FileBox,
): grpcPuppet.IPuppetServer {

  /**
   * Save scan payload to send it to the puppet-service right after connected (if needed)
   *
   * TODO: clean the listeners if necessary
   */
  let scanPayload: undefined  | PUPPET.payloads.EventScan
  let readyPayload: undefined | PUPPET.payloads.EventReady
  let readyTimeout: undefined | ReturnType<typeof setTimeout>

  puppet.on('scan', payload  => { scanPayload = payload    })
  puppet.on('ready', payload => { readyPayload = payload   })
  puppet.on('logout', _      => {
    readyPayload = undefined
    if (readyTimeout) {
      clearTimeout(readyTimeout)
    }
  })
  puppet.on('login', _       => {
    scanPayload = undefined
    readyTimeout = setTimeout(() => {
      // Huan(202110): should we emit ready event here?
      readyPayload && eventStreamManager.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_READY, readyPayload)
    }, 5 * 1000)
  })

  const eventStreamManager = new EventStreamManager(puppet)

  const serializeFileBox = async (fileBox: FileBoxInterface) => {
    /**
     * 1. if the fileBox is one of type `Url`, `QRCode`, `Uuid`, etc,
     *  then it can be serialized by `fileBox.toString()`
     * 2. if the fileBox is one of type `Stream`, `Buffer`, `File`, etc,
     *  then it need to be convert to type `Uuid`
     *  before serialized by `fileBox.toString()`
     */
    const normalizedFileBox = await normalizeFileBoxUuid(FileBoxUuid)(fileBox)
    return JSON.stringify(normalizedFileBox)
  }

  const puppetServerImpl: grpcPuppet.IPuppetServer = {

    conversationRead: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'conversationRead()')

      try {
        const conversationId = call.request.getConversationId()
        const hasRead = call.request.getHasRead()
        await puppet.conversationReadMark(conversationId, hasRead)

        const response = new grpcPuppet.ConversationReadResponse()
        return callback(null, response)
      } catch (e) {
        return grpcError('currentUser', e, callback)
      }
    },

    currentUser: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'currentUser()')
      void call

      try {
        const currentUser = puppet.currentUserId
        const response = new grpcPuppet.CurrentUserResponse()
        response.setUserId(currentUser)
        return callback(null, response)
      } catch (e) {
        return grpcError('currentUser', e, callback)
      }
    },

    contactAlias: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactAlias()')

      const id = call.request.getId()

      /**
       * Set
       */
      if (call.request.hasAlias()) {
        try {
          await puppet.contactAlias(id, call.request.getAlias())
          return callback(null, new  grpcPuppet.ContactAliasResponse())
        } catch (e) {
          return grpcError('contactAlias', e, callback)
        }
      }

      /**
       * Get
       */
      try {
        const alias = await puppet.contactAlias(id)

        const response = new grpcPuppet.ContactAliasResponse()
        response.setAlias(alias)

        return callback(null, response)
      } catch (e) {
        return grpcError('contactAlias', e, callback)
      }

    },

    contactAvatar: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactAvatar()')

      const id = call.request.getId()

      /**
       * Set
       */
      try {
        if (call.request.hasFileBox()) {

          const fileBox = FileBoxUuid.fromJSON(
            call.request.getFileBox(),
          )
          await puppet.contactAvatar(id, fileBox)

          return callback(null, new grpcPuppet.ContactAvatarResponse())
        }
      } catch (e) {
        return grpcError('contactAvatar', e, callback)
      }

      /**
       * Get
       */
      try {
        const fileBox           = await puppet.contactAvatar(id)
        const serializedFileBox = await serializeFileBox(fileBox)

        const response  = new grpcPuppet.ContactAvatarResponse()
        response.setFileBox(serializedFileBox)

        return callback(null, response)
      } catch (e) {
        return grpcError('contactAvatar', e, callback)
      }
    },

    contactCorporationRemark: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactCorporationRemark()')

      const contactId = call.request.getContactId()
      try {
        await puppet.contactCorporationRemark(
          contactId,
          call.request.getCorporationRemark() || null,
        )
        return callback(null, new grpcPuppet.ContactCorporationRemarkResponse())
      } catch (e) {
        return grpcError('contactCorporationRemark', e, callback)
      }
    },

    contactDescription: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactDescription()')

      const contactId = call.request.getContactId()

      try {
        const description = call.request.getDescription()
        await puppet.contactDescription(contactId, description || null)
        return callback(null, new grpcPuppet.ContactDescriptionResponse())
      } catch (e) {
        return grpcError('contactDescription', e, callback)
      }
    },

    contactList: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactList()')

      void call // empty request

      try {
        const idList = await puppet.contactList()
        const response = new grpcPuppet.ContactListResponse()
        response.setIdsList(idList)

        return callback(null, response)
      } catch (e) {
        return grpcError('contactList', e, callback)
      }
    },

    contactDelete: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactDelete()')

      const contactId = call.request.getContactId()

      try {
        await puppet.contactDelete(contactId)

        return callback(null, new grpcPuppet.ContactDeleteResponse())
      } catch (e) {
        return grpcError('contactDelete', e, callback)
      }
    },

    contactPayload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactPayload()')

      const id = call.request.getId()

      try {
        const payload = await puppet.contactPayload(id)

        const response = new grpcPuppet.ContactPayloadResponse()
        response.setAddress(payload.address || '')
        response.setAlias(payload.alias || '')
        response.setAvatar(payload.avatar)
        response.setCity(payload.city || '')
        response.setFriend(payload.friend || false)
        response.setGender(payload.gender)
        response.setId(payload.id)
        response.setName(payload.name)
        response.setProvince(payload.province || '')
        response.setSignature(payload.signature || '')
        response.setStar(payload.star || false)
        response.setType(payload.type)
        /**
         * @deprecated `payload.weixin` will be removed in v2.0
         *  @link https://github.com/wechaty/grpc/issues/174
         */
        response.setWeixin(payload.handle || payload.weixin || '')
        response.setPhonesList(payload.phone)
        response.setCoworker(payload.coworker || false)
        response.setCorporation(payload.corporation || '')
        response.setTitle(payload.title || '')
        response.setDescription(payload.description || '')
        response.setAdditionalInfo(payload.additionalInfo || '')
        response.setTagIdsList(payload.tags || [])
        response.setRealName(payload.realName || '')
        response.setAka(payload.aka || '')

        return callback(null, response)
      } catch (e) {
        return grpcError('contactPayload', e, callback)
      }
    },

    batchContactPayload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'batchContactPayload()')

      try {
        const contactIdList = call.request.getIdsList()

        const payloadMap = await puppet.batchContactPayload(contactIdList)

        const response = new grpcPuppet.BatchContactPayloadResponse()

        const payloads: grpcPuppet.ContactPayloadResponse[] = []
        for (const [ _, payload ] of payloadMap.entries()) {
          const pb = new grpcPuppet.ContactPayloadResponse()
          pb.setAddress(payload.address || '')
          pb.setAlias(payload.alias || '')
          pb.setAvatar(payload.avatar)
          pb.setCity(payload.city || '')
          pb.setFriend(payload.friend || false)
          pb.setGender(payload.gender)
          pb.setId(payload.id)
          pb.setName(payload.name)
          pb.setProvince(payload.province || '')
          pb.setSignature(payload.signature || '')
          pb.setStar(payload.star || false)
          pb.setType(payload.type)
          /**
           * @deprecated `payload.weixin` will be removed in v2.0
           *  @link https://github.com/wechaty/grpc/issues/174
           */
          pb.setWeixin(payload.handle || payload.weixin || '')
          pb.setPhonesList(payload.phone)
          pb.setCoworker(payload.coworker || false)
          pb.setCorporation(payload.corporation || '')
          pb.setTitle(payload.title || '')
          pb.setDescription(payload.description || '')
          pb.setAdditionalInfo(payload.additionalInfo || '')
          pb.setTagIdsList(payload.tags || [])
          pb.setRealName(payload.realName || '')
          pb.setAka(payload.aka || '')
          payloads.push(pb)
        }

        response.setContactPayloadsList(payloads)

        return callback(null, response)

      } catch (e) {
        return grpcError('batchContactPayload', e, callback)
      }
    },

    contactPayloadModify: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactPayloadModify()')

      try {
        const contactId = call.request.getId()

        const payload: Partial<PUPPET.payloads.Contact> = {
          gender: call.request.getGender(),
          type: call.request.getType(),
          name: call.request.getName(),
          avatar: call.request.getAvatar(),
          address: call.request.getAddress(),
          alias: call.request.getAddress(),
          city: call.request.getCity(),
          friend: call.request.getFriend(),
          province: call.request.getProvince(),
          signature: call.request.getSignature(),
          star: call.request.getStar(),
          weixin: call.request.getWeixin(),
          handle: call.request.getWeixin(),
          phone: call.request.getPhonesList(),
          corporation: call.request.getCorporation(),
          title: call.request.getTitle(),
          description: call.request.getDescription(),
          coworker: call.request.getCoworker(),
          additionalInfo: call.request.getAdditionalInfo(),
          tags: call.request.getTagIdsList(),
        }

        if (call.request.getClearPhones()) {
          payload.phone = []
        }
        if (call.request.getClearTagIds()) {
          payload.tags = []
        }

        await puppet.contactPayloadModify(contactId, payload)
        return callback(null, new grpcPuppet.ContactPayloadResponse())
      } catch (e) {
        return grpcError('contactPayloadModify', e, callback)
      }

    },

    contactPhone: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactPhone()')

      try {
        const contactId = call.request.getContactId()
        const phoneList = call.request.getPhonesList()

        await puppet.contactPhone(contactId, phoneList)
        return callback(null, new grpcPuppet.ContactPhoneResponse())
      } catch (e) {
        return grpcError('contactPhone', e, callback)
      }
    },

    contactSelfName: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactSelfName()')

      try {
        const name = call.request.getName()
        await puppet.contactSelfName(name)

        return callback(null, new grpcPuppet.ContactSelfNameResponse())

      } catch (e) {
        return grpcError('contactSelfName', e, callback)
      }
    },

    contactSelfRealName: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactSelfRealName()')

      try {
        const realName = call.request.getRealName()
        await puppet.contactSelfRealName(realName)

        return callback(null, new grpcPuppet.ContactSelfRealNameResponse())

      } catch (e) {
        return grpcError('contactSelfRealName', e, callback)
      }
    },

    contactSelfAka: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactSelfAka()')

      try {
        const aka = call.request.getAka()
        await puppet.contactSelfAka(aka)

        return callback(null, new grpcPuppet.ContactSelfAkaResponse())

      } catch (e) {
        return grpcError('contactSelfAka', e, callback)
      }
    },

    contactSelfQRCode: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactSelfName()')
      void call

      try {
        const qrcode = await puppet.contactSelfQRCode()

        const response = new grpcPuppet.ContactSelfQRCodeResponse()
        response.setQrcode(qrcode)

        return callback(null, response)

      } catch (e) {
        return grpcError('contactSelfQRCode', e, callback)
      }

    },

    contactSelfSignature: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactSelfSignature()')

      try {
        const signature = call.request.getSignature()
        await puppet.contactSelfSignature(signature)

        return callback(null, new grpcPuppet.ContactSelfSignatureResponse())

      } catch (e) {
        return grpcError('contactSelfSignature', e, callback)
      }

    },

    contactSelfRoomAlias: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'contactSelfRoomAlias()')

      try {
        const roomId = call.request.getRoomId()
        const alias = call.request.getAlias()
        await puppet.contactSelfRoomAlias(roomId, alias)

        return callback(null, new grpcPuppet.ContactSelfRoomAliasResponse())

      } catch (e) {
        return grpcError('contactSelfRoomAlias', e, callback)
      }

    },

    ding: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'ding()')

      try {
        const data = call.request.getData()
        await puppet.ding(data)
        return callback(null, new grpcPuppet.DingResponse())

      } catch (e) {
        return grpcError('ding', e, callback)
      }
    },

    dirtyPayload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'dirtyPayload()')

      try {
        const id = call.request.getId()
        const type: PUPPET.types.Dirty = call.request.getType()

        await puppet.dirtyPayload(type, id)
        return callback(null, new grpcPuppet.DirtyPayloadResponse())
      } catch (e) {
        return grpcError('puppet.dirtyPayload() rejection: ', e, callback)
      }
    },

    /**
     *
     * Bridge Event Emitter Events
     *
     */
    event: (streamingCall) => {
      log.verbose('PuppetServiceImpl', 'event()')

      if (eventStreamManager.busy()) {
        log.error('PuppetServiceImpl', 'event() there is another event() call not end when receiving a new one.')

        const error: grpc.ServiceError = {
          ...new Error('GrpcServerImpl.event() can not call twice.'),
          code: grpc.status.ALREADY_EXISTS,
          details: 'GrpcServerImpl.event() can not call twice.',
          metadata: streamingCall.metadata,
        }

        /**
          * Send error from gRPC server stream:
          *  https://github.com/grpc/grpc-node/issues/287#issuecomment-383218225
          *
          * Streaming RPCs
          *  - https://grpc.io/docs/tutorials/basic/node/
          *    Only one of 'error' or 'end' will be emitted. Finally, the 'status' event fires when the server sends the status.
          */
        streamingCall.emit('error', error)
        return
      }

      eventStreamManager.start(streamingCall)

      /**
       * If `scanPayload` is not undefined, then we emit it to downstream immediatelly
       */
      if (scanPayload) {
        eventStreamManager.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_SCAN, scanPayload)
      }
    },

    friendshipAccept: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'friendshipAccept()')

      try {
        const id = call.request.getId()
        await puppet.friendshipAccept(id)
        return callback(null, new grpcPuppet.FriendshipAcceptResponse())

      } catch (e) {
        return grpcError('friendshipAccept', e, callback)
      }
    },

    friendshipAdd: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'friendshipAdd()')

      try {
        const contactId = call.request.getContactId()
        // FIXME: for backward compatibility, need to be removed after all puppet has updated.
        const hello = call.request.getHello()

        const referrer = call.request.getReferrer()
        const friendshipAddOptions: PUPPET.types.FriendshipAddOptions = {
          hello,
          ...referrer,
        }

        {
          // Deprecated: will be removed after Dec 31, 2022
          const sourceContactId = call.request.getSourceContactIdStringValueDeprecated()?.getValue()
          const sourceRoomId    = call.request.getSourceRoomIdStringValueDeprecated()?.getValue()
          if (sourceContactId)  { friendshipAddOptions['contactId'] = sourceContactId }
          if (sourceRoomId)     { friendshipAddOptions['roomId']    = sourceRoomId }
        }

        await puppet.friendshipAdd(contactId, friendshipAddOptions)
        return callback(null, new grpcPuppet.FriendshipAddResponse())

      } catch (e) {
        return grpcError('friendshipAdd', e, callback)
      }
    },

    friendshipPayload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'friendshipPayload()')

      try {
        const id = call.request.getId()
        const payload = await puppet.friendshipPayload(id)
        const payloadReceive = payload as PUPPET.payloads.FriendshipReceive

        const response = new grpcPuppet.FriendshipPayloadResponse()

        response.setContactId(payload.contactId)
        response.setHello(payload.hello || '')
        response.setId(payload.id)
        response.setScene(payloadReceive.scene || PUPPET.types.FriendshipScene.Unknown)
        response.setStranger(payloadReceive.stranger || '')
        response.setTicket(payloadReceive.ticket)
        response.setType(payload.type)

        return callback(null, response)

      } catch (e) {
        return grpcError('friendshipPayload', e, callback)
      }
    },

    friendshipSearchPhone: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'friendshipSearchPhone()')

      try {
        const phone = call.request.getPhone()
        const type = call.request.getType()

        const contactId = await puppet.friendshipSearchPhone(phone, type)

        const response = new grpcPuppet.FriendshipSearchPhoneResponse()

        if (contactId) {
          response.setContactId(contactId)
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('friendshipSearchPhone', e, callback)
      }
    },
    /**
     * @deprecated use `friendshipSearchHandle()` instead, will be removed in v3.0
     */
    friendshipSearchWeixin: async (call, callback) => {
      log.warn('PuppetServiceImpl', 'friendshipSearchWeixin() is deprecated, use friendshipSearchHandle() instead. %s', new Error().stack)
      return puppetServerImpl.friendshipSearchHandle(call, callback)
    },

    friendshipSearchHandle: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'friendshipSearchHandle()')

      try {
        /**
         * Huan(202203): rename `getWeixin()` to `getHandle()` in v2.0.0
         *  @link https://github.com/wechaty/grpc/issues/174
         */
        const handle = call.request.getWeixin()
        const type = call.request.getType()
        const contactId = await puppet.friendshipSearchHandle(handle, type)

        const response = new grpcPuppet.FriendshipSearchHandleResponse()

        if (contactId) {
          response.setContactId(contactId)
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('friendshipSearchHandle', e, callback)
      }
    },

    logout: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'logout()')
      void call // empty arguments

      try {
        await puppet.logout()

        return callback(null, new grpcPuppet.LogoutResponse())

      } catch (e) {
        return grpcError('logout', e, callback)
      }
    },

    enterVerifyCode: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'enterVerifyCode()')
      void call // empty arguments

      try {
        const id = call.request.getId()
        const code = call.request.getCode()

        await puppet.enterVerifyCode(id, code)

        return callback(null, new grpcPuppet.EnterVerifyCodeResponse())

      } catch (e) {
        return grpcError('logout', e, callback)
      }
    },

    cancelVerifyCode: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'cancelVerifyCode()')
      void call // empty arguments

      try {
        const id = call.request.getId()

        await puppet.cancelVerifyCode(id)

        return callback(null, new grpcPuppet.CancelVerifyCodeResponse())

      } catch (e) {
        return grpcError('logout', e, callback)
      }
    },

    refreshQRCode: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'refreshQRCode()')
      void call // empty arguments

      try {
        await puppet.refreshQRCode()

        return callback(null, new grpcPuppet.RefreshQRCodeResponse())

      } catch (e) {
        return grpcError('logout', e, callback)
      }
    },

    messageContact: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageContact()')

      try {
        const id = call.request.getId()

        const contactId = await puppet.messageContact(id)

        const response = new grpcPuppet.MessageContactResponse()
        response.setId(contactId)

        return callback(null, response)

      } catch (e) {
        return grpcError('messageContact', e, callback)
      }
    },

    messageFile: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageFile()')

      try {
        const id = call.request.getId()

        const fileBox           = await puppet.messageFile(id)
        const serializedFileBox = await serializeFileBox(fileBox)

        const response = new grpcPuppet.MessageFileResponse()
        response.setFileBox(serializedFileBox)

        return callback(null, response)

      } catch (e) {
        return grpcError('messageFile', e, callback)
      }
    },

    messageForward: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageForward()')

      try {
        const conversationId = call.request.getConversationId()
        const messageId = call.request.getMessageId()
        const messageIds = call.request.getMessageIdsList()

        const id = await puppet.messageForward(conversationId, messageId)
        if (messageIds.length > 1) {
          await puppet.messageForward(conversationId, messageIds)
        } else {
          await puppet.messageForward(conversationId, messageId || messageId[0] || '')
        }

        const response = new grpcPuppet.MessageForwardResponse()
        if (id) {
          response.setId(id)
          {
            /**
              * Huan(202110): Deprecated: will be removed after Dec 31, 2022
              */
            const idWrapper = new StringValue()
            idWrapper.setValue(id)
            response.setIdStringValueDeprecated(idWrapper)
          }
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('messageForward', e, callback)
      }
    },

    messageImage: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageImage()')

      try {
        const id    = call.request.getId()
        const type  = call.request.getType()

        const fileBox           = await puppet.messageImage(id, type)
        const serializedFileBox = await serializeFileBox(fileBox)

        const response = new grpcPuppet.MessageImageResponse()
        response.setFileBox(serializedFileBox)

        return callback(null, response)

      } catch (e) {
        return grpcError('messageImage', e, callback)
      }
    },

    messageLocation: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageLocation()')

      try {
        const id = call.request.getId()

        const payload = await puppet.messageLocation(id)

        const response = new grpcPuppet.MessageLocationResponse()

        const pbLocationPayload = new grpcPuppet.LocationPayload()
        pbLocationPayload.setLatitude(payload.latitude)
        pbLocationPayload.setLongitude(payload.longitude)
        pbLocationPayload.setAccuracy(payload.accuracy)
        pbLocationPayload.setAddress(payload.address)
        pbLocationPayload.setName(payload.name)
        response.setLocation(pbLocationPayload)

        return callback(null, response)

      } catch (e) {
        return grpcError('messageLocation', e, callback)
      }
    },

    messageMiniProgram: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageMiniProgram()')

      try {
        const id = call.request.getId()

        const payload = await puppet.messageMiniProgram(id)

        const response = new grpcPuppet.MessageMiniProgramResponse()

        const pbMiniProgramPayload = new grpcPuppet.MiniProgramPayload()
        if (payload.appid)       { pbMiniProgramPayload.setAppid(payload.appid) }
        if (payload.description) { pbMiniProgramPayload.setDescription(payload.description) }
        if (payload.iconUrl)     { pbMiniProgramPayload.setIconUrl(payload.iconUrl) }
        if (payload.pagePath)    { pbMiniProgramPayload.setPagePath(payload.pagePath) }
        if (payload.shareId)     { pbMiniProgramPayload.setShareId(payload.shareId) }
        if (payload.thumbKey)    { pbMiniProgramPayload.setThumbKey(payload.thumbKey) }
        if (payload.thumbUrl)    { pbMiniProgramPayload.setThumbUrl(payload.thumbUrl) }
        if (payload.title)       { pbMiniProgramPayload.setTitle(payload.title) }
        if (payload.username)    { pbMiniProgramPayload.setUsername(payload.username) }
        response.setMiniProgram(pbMiniProgramPayload)

        // Deprecated after Dec 31, 2022
        response.setMiniProgramDeprecated(JSON.stringify(payload))

        return callback(null, response)

      } catch (e) {
        return grpcError('messageMiniProgram', e, callback)
      }
    },

    messageChannel: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageChannel()')

      try {
        const id = call.request.getId()

        const payload = await puppet.messageChannel(id)

        const response = new grpcPuppet.MessageChannelResponse()

        const pbChannelPayload = channelPayloadToPb(grpcPuppet, payload)

        response.setChannel(pbChannelPayload)

        return callback(null, response)

      } catch (e) {
        return grpcError('messageMiniProgram', e, callback)
      }
    },

    messageCallRecord: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageCallRecord()')

      try {
        const id = call.request.getId()

        const payload = await puppet.messageCallRecord(id)

        const response = new grpcPuppet.MessageCallRecordResponse()

        const pbChannelPayload = callRecordPayloadToPb(grpcPuppet, payload)

        response.setCallRecord(pbChannelPayload)

        return callback(null, response)

      } catch (e) {
        return grpcError('messageMiniProgram', e, callback)
      }
    },

    messageChatHistory: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageChatHistory()')

      try {
        const id = call.request.getId()

        const payloadList = await puppet.messageChatHistory(id)

        const response = new grpcPuppet.MessageChatHistoryResponse()

        const pbChatHistoryPayloadList = await chatHistoryPayloadToPb(grpcPuppet, payloadList, serializeFileBox)

        response.setChatHistoryListList(pbChatHistoryPayloadList)

        return callback(null, response)

      } catch (e) {
        return grpcError('messageMiniProgram', e, callback)
      }
    },

    messagePayload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messagePayload()')

      try {
        const id = call.request.getId()

        const payload = await puppet.messagePayload(id)

        const mentionIdList = ('mentionIdList' in payload)
          ? payload.mentionIdList || []
          : []

        const response = new grpcPuppet.MessagePayloadResponse()
        response.setFilename(payload.filename || '')
        /**
         * Huan(202203):`payload.fromId` is deprecated, will be removed in v2.0
         */
        response.setTalkerId(payload.talkerId || payload.fromId || '')
        response.setId(payload.id)
        response.setMentionIdsList(mentionIdList)
        response.setRoomId(payload.roomId || '')
        response.setText(payload.text || '')

        response.setReceiveTime(timestampFromMilliseconds(payload.timestamp))
        // Deprecated: will be removed after Dec 31, 2022
        response.setTimestampDeprecated(Math.floor(payload.timestamp))

        /**
         * Huan(202203):`payload.toId` is deprecated, will be removed in v2.0
         */
        response.setListenerId(payload.listenerId || payload.toId || '')
        response.setType(payload.type as grpcPuppet.MessageTypeMap[keyof grpcPuppet.MessageTypeMap])
        response.setQuoteId(payload.quoteId || '')
        response.setAdditionalInfo(payload.additionalInfo || '')

        const textContents = payload.textContent
        const textContentPbs = []
        for (const textContent of (textContents || [])) {
          const textContentPb = new grpcPuppet.TextContent()
          const type = textContent.type
          textContentPb.setText(textContent.text)
          textContentPb.setType(type)
          switch (type) {
            case TextContentType.Regular:
              break
            case TextContentType.At: {
              const data = new grpcPuppet.TextContentData()
              data.setContactId(textContent.data.contactId)
              textContentPb.setData(data)
              break
            }
            default:
              log.warn('PuppetServiceImpl', `unknown text content type ${type}`)
              break
          }
          textContentPbs.push(textContentPb)
        }
        response.setTextContentsList(textContentPbs)

        return callback(null, response)

      } catch (e) {
        return grpcError('messagePayload', e, callback)
      }
    },

    messageRecall: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageRecall()')

      try {
        const id = call.request.getId()

        const success = await puppet.messageRecall(id)

        const response = new grpcPuppet.MessageRecallResponse()
        response.setSuccess(success)

        return callback(null, response)

      } catch (e) {
        return grpcError('messageRecall', e, callback)
      }
    },

    messagePreview: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messagePreview()')

      try {
        const id = call.request.getId()

        const fileBox = await puppet.messagePreview(id)
        const response = new grpcPuppet.MessagePreviewResponse()
        if (fileBox) {
          const serializedFileBox = await serializeFileBox(fileBox)
          response.setFileBox(serializedFileBox)
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('messageFile', e, callback)
      }
    },

    messageSendContact: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageSendContact()')

      try {
        const conversationId = call.request.getConversationId()
        const contactId = call.request.getContactId()

        const messageId = await puppet.messageSendContact(conversationId, contactId)

        const response = new grpcPuppet.MessageSendContactResponse()

        if (messageId) {
          response.setId(messageId)
          {
            /**
              * Huan(202110): Deprecated: will be removed after Dec 31, 2022
              */
            const idWrapper = new StringValue()
            idWrapper.setValue(messageId)
            response.setIdStringValueDeprecated(idWrapper)
          }
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('messageSendContact', e, callback)
      }
    },

    messageSendFile: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageSendFile()')

      try {
        const conversationId  = call.request.getConversationId()
        const jsonText        = call.request.getFileBox()

        const fileBox = FileBoxUuid.fromJSON(jsonText)

        const messageId = await puppet.messageSendFile(conversationId, fileBox)

        const response = new grpcPuppet.MessageSendFileResponse()

        if (messageId) {
          response.setId(messageId)
          {
            /**
              * Huan(202110): Deprecated: will be removed after Dec 31, 2022
              */
            const idWrapper = new StringValue()
            idWrapper.setValue(messageId)
            response.setIdStringValueDeprecated(idWrapper)
          }
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('messageSendFile', e, callback)
      }
    },

    messageSendLocation: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageSendLocation()')

      try {
        const conversationId    = call.request.getConversationId()
        const pbLocationPayload = call.request.getLocation()

        const payload: PUPPET.payloads.Location = {
          accuracy: pbLocationPayload?.getAccuracy() || 0,
          address: pbLocationPayload?.getAddress() || 'No Address',
          latitude: pbLocationPayload?.getLatitude() || 0,
          longitude: pbLocationPayload?.getLongitude() || 0,
          name: pbLocationPayload?.getName() || 'No Name',
        }

        const messageId = await puppet.messageSendLocation(conversationId, payload)

        const response = new grpcPuppet.MessageSendLocationResponse()

        if (messageId) {
          response.setId(messageId)
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('messageSendLocation', e, callback)
      }
    },

    messageSendMiniProgram: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageSendMiniProgram()')

      try {
        const conversationId      = call.request.getConversationId()
        let pbMiniProgramPayload  = call.request.getMiniProgram()?.toObject()
        if (!pbMiniProgramPayload) {
          // Deprecated: will be removed after Dec 31, 2022
          const jsonText = call.request.getMiniProgramDeprecated()
          pbMiniProgramPayload = JSON.parse(jsonText)
        }

        const payload: PUPPET.payloads.MiniProgram = {
          ...pbMiniProgramPayload,
        }

        const messageId = await puppet.messageSendMiniProgram(conversationId, payload)

        const response = new grpcPuppet.MessageSendMiniProgramResponse()

        if (messageId) {
          response.setId(messageId)
          {
            /**
              * Huan(202110): Deprecated: will be removed after Dec 31, 2022
              */
            const idWrapper = new StringValue()
            idWrapper.setValue(messageId)
            response.setIdStringValueDeprecated(idWrapper)
          }
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('messageSendMiniProgram', e, callback)
      }
    },

    messageSendText: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageSendText()')

      try {
        const conversationId = call.request.getConversationId()
        const text = call.request.getText()
        const mentionIdList = call.request.getMentionalIdsList()
        const quoteId = call.request.getQuoteId()

        let messageId
        if (!quoteId) {
          messageId = await puppet.messageSendText(conversationId, text, mentionIdList)
        } else {
          messageId = await puppet.messageSendText(conversationId, text, {
            mentionIdList,
            quoteId,
          })
        }

        const response = new grpcPuppet.MessageSendTextResponse()

        if (messageId) {
          response.setId(messageId)
          {
            /**
              * Huan(202110): Deprecated: will be removed after Dec 31, 2022
              */
            const idWrapper = new StringValue()
            idWrapper.setValue(messageId)
            response.setIdStringValueDeprecated(idWrapper)
          }
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('messageSendText', e, callback)
      }
    },

    messageSendUrl: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageSendUrl()')

      try {
        const conversationId = call.request.getConversationId()
        let pbUrlLinkPayload = call.request.getUrlLink()?.toObject()

        if (!pbUrlLinkPayload) {
          // Deprecated: will be removed after Dec 31, 2022
          const jsonText = call.request.getUrlLinkDeprecated()
          pbUrlLinkPayload = JSON.parse(jsonText)
        }

        const payload: PUPPET.payloads.UrlLink = {
          title : 'NOTITLE',
          url   : 'NOURL',
          ...pbUrlLinkPayload,
        }

        const messageId = await puppet.messageSendUrl(conversationId, payload)

        const response = new grpcPuppet.MessageSendUrlResponse()

        if (messageId) {
          response.setId(messageId)
          {
            /**
              * Huan(202110): Deprecated: will be removed after Dec 31, 2022
              */
            const idWrapper = new StringValue()
            idWrapper.setValue(messageId)
            response.setIdStringValueDeprecated(idWrapper)
          }
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('messageSendUrl', e, callback)
      }
    },

    messageSendChannel: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageSendChannel()')

      try {
        const conversationId = call.request.getConversationId()
        const pbChannelPayload = call.request.getChannel()?.toObject()

        if (!pbChannelPayload) {
          return grpcError('messageSendUrl', new Error().stack, callback)
        }
        const payload: PUPPET.payloads.Channel = {
          ...pbChannelPayload,
        }

        const messageId = await puppet.messageSendChannel(conversationId, payload)

        const response = new grpcPuppet.MessageSendChannelResponse()

        if (messageId) {
          response.setId(messageId)
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('messageSendChannel', e, callback)
      }
    },

    messageSendPost: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageSendPost()')

      try {
        const conversationId = call.request.getConversationId()
        const post = call.request.getContent()

        if (!post) {
          throw new Error('no post found')
        }
        if (
          post.getType() === grpcPuppet.PostType.POST_TYPE_CHANNEL
          || post.getType() === grpcPuppet.PostType.POST_TYPE_BROADCAST
          || post.getType() === grpcPuppet.PostType.POST_TYPE_UNSPECIFIED
        ) {
          throw new Error('cannot send post with non-message post type')
        }

        const payload = postPbToPayload(post, FileBoxUuid)

        const id = await puppet.messageSendPost(conversationId, payload)

        const response = new grpcPuppet.MessageSendPostResponse()
        if (id) {
          response.setId(id)
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('messageSendPost', e, callback)
      }
    },

    messageUrl: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'messageUrl()')

      try {
        const id      = call.request.getId()
        const payload = await puppet.messageUrl(id)

        const response = new grpcPuppet.MessageUrlResponse()

        const pbUrlLinkPayload = new grpcPuppet.UrlLinkPayload()
        pbUrlLinkPayload.setTitle(payload.title)
        pbUrlLinkPayload.setUrl(payload.url)
        if (payload.thumbnailUrl) { pbUrlLinkPayload.setThumbnailUrl(payload.thumbnailUrl) }
        if (payload.description)  { pbUrlLinkPayload.setDescription(payload.description) }
        response.setUrlLink(pbUrlLinkPayload)

        // Deprecated: will be removed after Dec 31, 2022
        response.setUrlLinkDeprecated(JSON.stringify(payload))

        return callback(null, response)

      } catch (e) {
        return grpcError('messageUrl', e, callback)
      }
    },

    getMessageBroadcastTarget: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'getMessageBroadcastTarget()')

      void call
      try {
        const payload = await puppet.getMessageBroadcastTarget()

        const response = new grpcPuppet.GetMessageBroadcastTargetResponse()
        response.setContactIdsList(payload.contactIds || [])
        response.setRoomIdsList(payload.roomIds || [])

        return callback(null, response)
      } catch (e) {
        return grpcError('getMessageBroadcastTarget', e, callback)
      }
    },

    createMessageBroadcast: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'createMessageBroadcast()')

      try {
        const targets = call.request.getTargetIdsList()
        const post = call.request.getContent()

        if (!post) {
          throw new Error('no post found')
        }
        if (post.getType() !== grpcPuppet.PostType.POST_TYPE_BROADCAST) {
          throw new Error('cannot create broadcast with non-broadcast post')
        }

        const payload = postPbToPayload(post, FileBoxUuid)

        const id = await puppet.createMessageBroadcast(targets, payload)

        const response = new grpcPuppet.CreateMessageBroadcastResponse()
        if (id) {
          response.setId(id)
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('createMessageBroadcast', e, callback)
      }
    },

    getMessageBroadcastStatus: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'getMessageBroadcastStatus()')

      try {
        const id = call.request.getId()
        const result = await puppet.getMessageBroadcastStatus(id)

        const response = new grpcPuppet.GetMessageBroadcastStatusResponse()
        response.setStatus(result.status)
        const detailList: grpcPuppet.BroadcastTarget[] = []
        for (const targetDetail of result.detail) {
          const detail = new grpcPuppet.BroadcastTarget()
          if (targetDetail.contactId) detail.setContactId(targetDetail.contactId)
          if (targetDetail.roomId) detail.setRoomId(targetDetail.roomId)
          detail.setStatus(targetDetail.status)
          detailList.push(detail)
        }
        response.setDetailList(detailList)

        return callback(null, response)

      } catch (e) {
        return grpcError('getMessageBroadcastStatus', e, callback)
      }
    },

    roomAdd: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomAdd()')

      try {
        const roomId = call.request.getId()
        const contactId = call.request.getContactId()
        const inviteOnly = call.request.getInviteOnly()
        const quoteIds = call.request.getQuoteIdsList()

        await puppet.roomAdd(roomId, contactId, inviteOnly, quoteIds)

        return callback(null, new grpcPuppet.RoomAddResponse())

      } catch (e) {
        return grpcError('roomAdd', e, callback)
      }
    },

    roomAnnounce: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomAnnounce()')

      try {
        const roomId = call.request.getId()

        /**
         * Set
         */
        if (call.request.hasText()) {
          await puppet.roomAnnounce(roomId, call.request.getText())
          return callback(null, new grpcPuppet.RoomAnnounceResponse())
        }

        /**
         * Get
         */
        const text = await puppet.roomAnnounce(roomId)

        const response = new grpcPuppet.RoomAnnounceResponse()
        response.setText(text)

        return callback(null, response)

      } catch (e) {
        return grpcError('roomAnnounce', e, callback)
      }
    },

    roomAvatar: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomAvatar()')

      try {
        const roomId = call.request.getId()

        const fileBox           = await puppet.roomAvatar(roomId)
        const serializedFileBox = await serializeFileBox(fileBox!)

        const response = new grpcPuppet.RoomAvatarResponse()
        response.setFileBox(serializedFileBox)

        return callback(null, response)

      } catch (e) {
        return grpcError('roomAvatar', e, callback)
      }
    },

    roomCreate: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomCreate()')

      try {
        const contactIdList = call.request.getContactIdsList()
        const topic = call.request.getTopic()

        const roomId = await puppet.roomCreate(contactIdList, topic)

        const response = new grpcPuppet.RoomCreateResponse()
        response.setId(roomId)

        return callback(null, response)

      } catch (e) {
        return grpcError('roomCreate', e, callback)
      }
    },

    roomDel: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomDel()')

      try {
        const roomId = call.request.getId()
        const contactId = call.request.getContactId()
        const contactIds = call.request.getContactIdsList()

        if (contactIds.length > 1) {
          await puppet.roomDel(roomId, contactId)
        } else {
          await puppet.roomDel(roomId, contactId || (contactIds[0]) || '')
        }

        return callback(null, new grpcPuppet.RoomDelResponse())

      } catch (e) {
        return grpcError('roomDel', e, callback)
      }
    },

    roomInvitationAccept: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomInvitationAccept()')

      try {
        const id = call.request.getId()

        await puppet.roomInvitationAccept(id)

        return callback(null, new grpcPuppet.RoomInvitationAcceptResponse())

      } catch (e) {
        return grpcError('roomInvitationAccept', e, callback)
      }
    },

    roomInvitationAcceptByQRCode: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomInvitationAcceptByQRCode()')

      try {
        const qrcode = call.request.getQrcode()

        const result = await puppet.roomInvitationAcceptByQRCode(qrcode)

        const response = new grpcPuppet.RoomInvitationAcceptByQRCodeResponse()
        response.setRoomId(result.roomId)
        response.setChatId(result.chatId)

        return callback(null, response)

      } catch (e) {
        return grpcError('roomInvitationAccept', e, callback)
      }
    },

    roomInvitationPayload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomInvitationPayload()')

      try {
        const roomInvitationId = call.request.getId()
        /**
          * Set
          */
        {
          const jsonText = call.request.getPayload()

          if (jsonText) {
            const payload = JSON.parse(jsonText) as PUPPET.payloads.RoomInvitation
            await puppet.roomInvitationPayload(roomInvitationId, payload)

            return callback(null, new grpcPuppet.RoomInvitationPayloadResponse())
          }

          {
            /**
              * Huan(202110): Deprecated: will be removed after Dec 31, 2022
              */
            const payloadWrapper = call.request.getPayloadStringValueDeprecated()

            if (payloadWrapper) {
              const jsonText = payloadWrapper.getValue()
              const payload = JSON.parse(jsonText) as PUPPET.payloads.RoomInvitation
              await puppet.roomInvitationPayload(roomInvitationId, payload)

              return callback(null, new grpcPuppet.RoomInvitationPayloadResponse())
            }
          }
        }

        /**
         * Get
         */
        const payload = await puppet.roomInvitationPayload(roomInvitationId)

        const response = new grpcPuppet.RoomInvitationPayloadResponse()
        response.setAvatar(payload.avatar)
        response.setId(payload.id)
        response.setInvitation(payload.invitation)
        response.setInviterId(payload.inviterId)
        response.setReceiverId(payload.receiverId)
        response.setMemberCount(payload.memberCount)
        response.setMemberIdsList(payload.memberIdList)

        response.setReceiveTime(timestampFromMilliseconds(payload.timestamp))

        {
          // Deprecated: will be removed after Dec 31, 2022
          const deprecated = true
          void deprecated
          response.setTimestampUint64Deprecated(Math.floor(payload.timestamp))
        }

        response.setTopic(payload.topic)

        return callback(null, response)

      } catch (e) {
        return grpcError('roomInvitationPayload', e, callback)
      }
    },

    roomList: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomList()')
      void call

      try {
        const roomIdList = await puppet.roomList()

        const response = new grpcPuppet.RoomListResponse()
        response.setIdsList(roomIdList)

        return callback(null, response)

      } catch (e) {
        return grpcError('roomList', e, callback)
      }
    },

    roomMemberList: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomMemberList()')

      try {
        const roomId = call.request.getId()

        const roomMemberIdList = await puppet.roomMemberList(roomId)

        const response = new grpcPuppet.RoomMemberListResponse()
        response.setMemberIdsList(roomMemberIdList)

        return callback(null, response)

      } catch (e) {
        return grpcError('roomMemberList', e, callback)
      }
    },

    roomMemberPayload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomMemberPayload()')

      try {
        const roomId = call.request.getId()
        const memberId = call.request.getMemberId()

        const payload = await puppet.roomMemberPayload(roomId, memberId)

        const response = new grpcPuppet.RoomMemberPayloadResponse()

        response.setAvatar(payload.avatar)
        response.setId(payload.id)
        response.setInviterId(payload.inviterId || '')
        response.setName(payload.name)
        response.setRoomAlias(payload.roomAlias || '')
        response.setAdditionalInfo(payload.additionalInfo || '')
        response.setJoinScene(payload.joinScene || PUPPET.types.RoomMemberJoinScene.Unknown)
        if (payload.joinTime) {
          response.setJoinTime(payload.joinTime)
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('roomMemberPayload', e, callback)
      }
    },

    batchRoomMemberPayload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'batchRoomMemberPayload()')

      try {
        const roomId = call.request.getId()
        const contactIdList = call.request.getMemberIdsList()

        const payloadMap = await puppet.batchRoomMemberPayload(roomId, contactIdList)

        const response = new grpcPuppet.BatchRoomMemberPayloadResponse()

        const payloads: grpcPuppet.RoomMemberPayloadResponse[] = []
        for (const [ _, payload ] of payloadMap.entries()) {
          const pb = new grpcPuppet.RoomMemberPayloadResponse()
          pb.setAvatar(payload.avatar)
          pb.setId(payload.id)
          pb.setInviterId(payload.inviterId || '')
          pb.setName(payload.name)
          pb.setRoomAlias(payload.roomAlias || '')
          pb.setAdditionalInfo(payload.additionalInfo || '')
          pb.setJoinScene(payload.joinScene || PUPPET.types.RoomMemberJoinScene.Unknown)
          pb.setJoinTime(payload.joinTime || 0)
          payloads.push(pb)
        }

        response.setMemberPayloadsList(payloads)

        return callback(null, response)

      } catch (e) {
        return grpcError('batchRoomMemberPayload', e, callback)
      }
    },

    roomPayload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomPayload()')

      try {
        const roomId = call.request.getId()

        const payload = await puppet.roomPayload(roomId)

        const response = new grpcPuppet.RoomPayloadResponse()
        response.setAdminIdsList(payload.adminIdList)
        response.setAvatar(payload.avatar || '')
        response.setHandle(payload.handle || '')
        response.setId(payload.id)
        response.setMemberIdsList(payload.memberIdList)
        response.setOwnerId(payload.ownerId || '')
        response.setTopic(payload.topic)
        response.setAdditionalInfo(payload.additionalInfo || '')
        response.setRoomRemark(payload.remark || '')
        response.setExternal(!!payload.external)
        if (payload.createTime) {
          response.setCreateTime(timestampFromMilliseconds(payload.createTime))
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('roomPayload', e, callback)
      }
    },

    roomQRCode: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomQRCode()')

      try {
        const roomId = call.request.getId()

        const qrcode = await puppet.roomQRCode(roomId)

        const response = new grpcPuppet.RoomQRCodeResponse()
        response.setQrcode(qrcode)

        return callback(null, response)

      } catch (e) {
        return grpcError('roomQRCode', e, callback)
      }
    },

    roomParseDynamicQRCode: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomParseDynamicQRCode()')

      try {
        const url = call.request.getUrl()

        const qrcodeInfo = await puppet.roomParseDynamicQRCode(url)

        const response = new grpcPuppet.RoomParseDynamicQRCodeResponse()
        response.setQrcode(qrcodeInfo.qrcode)
        response.setQrcodeImageUrl(qrcodeInfo.qrcodeImageUrl)
        response.setRoomName(qrcodeInfo.roomName)

        return callback(null, response)

      } catch (e) {
        return grpcError('roomParseDynamicQRCode', e, callback)
      }
    },

    roomQuit: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomQuit()')

      try {
        const roomId = call.request.getId()

        await puppet.roomQuit(roomId)

        return callback(null, new grpcPuppet.RoomQuitResponse())

      } catch (e) {
        return grpcError('roomQuit', e, callback)
      }
    },

    roomTopic: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomTopic()')

      try {
        const roomId = call.request.getId()

        /**
         * Set
         */
        if (call.request.hasTopic()) {
          await puppet.roomTopic(roomId, call.request.getTopic())

          return callback(null, new grpcPuppet.RoomTopicResponse())
        }

        /**
         * Get
         */

        const topic = await puppet.roomTopic(roomId)

        const response = new grpcPuppet.RoomTopicResponse()
        response.setTopic(topic)

        return callback(null, response)

      } catch (e) {
        return grpcError('roomTopic', e, callback)
      }
    },

    roomRemark: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomRemark()')

      try {
        const roomId = call.request.getId()
        const remark = call.request.getRemark()

        await puppet.roomRemark(roomId, remark)

        return callback(null, new grpcPuppet.RoomRemarkResponse())

      } catch (e) {
        return grpcError('roomRemark', e, callback)
      }
    },

    roomPermission: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomPermission()')

      try {
        const roomId = call.request.getId()
        const permission: Partial<PUPPET.types.RoomPermission> = {
          inviteConfirm: OptionalBooleanUnwrapper(call.request.getInviteConfirm()),
          adminOnlyManage: OptionalBooleanUnwrapper(call.request.getAdminOnlyManage()),
          adminOnlyAtAll: OptionalBooleanUnwrapper(call.request.getAdminOnlyAtAll()),
          muteAll: OptionalBooleanUnwrapper(call.request.getMuteAll()),
          forbidRoomTopicEdit: OptionalBooleanUnwrapper(call.request.getForbidRoomTopicEdit()),
          disableMemberMutualAdd: OptionalBooleanUnwrapper(call.request.getDisableMemberMutualAdd()),
        }

        let set = false

        if (typeof permission.inviteConfirm === 'boolean' || typeof permission.adminOnlyManage === 'boolean' || typeof permission.adminOnlyAtAll === 'boolean' || typeof permission.muteAll === 'boolean' || typeof permission.forbidRoomTopicEdit === 'boolean' || typeof permission.disableMemberMutualAdd === 'boolean') {
          set = true
        }

        const result = await puppet.roomPermission(roomId, set ? permission : undefined)

        const response = new grpcPuppet.RoomPermissionResponse()

        if (!set) {
          const permissionResult = result as Partial<PUPPET.types.RoomPermission>
          response.setInviteConfirm(OptionalBooleanWrapper(permissionResult.inviteConfirm))
          response.setAdminOnlyManage(OptionalBooleanWrapper(permissionResult.adminOnlyManage))
          response.setAdminOnlyAtAll(OptionalBooleanWrapper(permissionResult.adminOnlyAtAll))
          response.setMuteAll(OptionalBooleanWrapper(permissionResult.muteAll))
          response.setForbidRoomTopicEdit(OptionalBooleanWrapper(permissionResult.forbidRoomTopicEdit))
          response.setDisableMemberMutualAdd(OptionalBooleanWrapper(permissionResult.disableMemberMutualAdd))
        }
        return callback(null, response)
      } catch (e) {
        return grpcError('roomPermission', e, callback)
      }
    },

    roomOwnerTransfer: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomOwnerTransfer()')

      try {
        const roomId = call.request.getId()
        const contactId = call.request.getContactId()

        await puppet.roomOwnerTransfer(roomId, contactId)

        return callback(null, new grpcPuppet.RoomOwnerTransferResponse())
      } catch (e) {
        return grpcError('roomOwnerTransfer', e, callback)
      }
    },

    roomAddAdmins: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomAddAdmins()')

      try {
        const roomId = call.request.getId()
        const contactIdList = call.request.getContactIdsList()

        await puppet.roomAddAdmins(roomId, contactIdList)

        return callback(null, new grpcPuppet.RoomAdminsResponse())
      } catch (e) {
        return grpcError('roomAddAdmins', e, callback)
      }
    },

    roomDelAdmins: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomDelAdmins()')

      try {
        const roomId = call.request.getId()
        const contactIdList = call.request.getContactIdsList()

        await puppet.roomDelAdmins(roomId, contactIdList)

        return callback(null, new grpcPuppet.RoomAdminsResponse())
      } catch (e) {
        return grpcError('roomDelAdmins', e, callback)
      }
    },

    roomDismiss: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'roomDismiss()')

      try {
        const roomId = call.request.getId()

        await puppet.roomDismiss(roomId)

        return callback(null, new grpcPuppet.RoomDismissResponse())
      } catch (e) {
        return grpcError('roomDelAdmins', e, callback)
      }
    },

    start: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'start()')
      void call

      try {
        await timeoutPromise(
          puppet.start(),
          15 * 1000,  // 15 seconds timeout
        )

        return callback(null, new grpcPuppet.StartResponse())

      } catch (e) {
        return grpcError('start', e, callback)
      }
    },

    stop: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'stop()')
      void call

      try {

        if (eventStreamManager.busy()) {
          eventStreamManager.stop()
        } else {
          log.error('PuppetServiceImpl', 'stop() eventStreamManager is not busy?')
        }

        readyPayload = undefined

        await timeoutPromise(
          puppet.stop(),
          15 * 1000, // 15 seconds timeout
        )

        return callback(null, new grpcPuppet.StopResponse())

      } catch (e) {
        return grpcError('stop', e, callback)
      }
    },

    /**
     *
     * tag section
     *
     */

    tagContactTagAdd: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagContactTagAdd()')

      try {
        const tagIds = call.request.getTagIdsList()
        const contactIds = call.request.getContactIdsList()

        await puppet.tagContactTagAdd(tagIds, contactIds)

        return callback(null, new grpcPuppet.TagContactTagAddResponse())
      } catch (e) {
        return grpcError('tagContactTagAdd', e, callback)
      }
    },

    tagContactTagRemove: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagContactTagRemove()')

      try {
        const tagIds = call.request.getTagIdsList()
        const contactIds = call.request.getContactIdsList()

        await puppet.tagContactTagRemove(tagIds, contactIds)

        return callback(null, new grpcPuppet.TagContactTagRemoveResponse())
      } catch (e) {
        return grpcError('tagContactTagRemove', e, callback)
      }
    },

    tagGroupAdd: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagGroupAdd()')

      try {
        const tagGroupName = call.request.getTagGroupName()

        const result = await puppet.tagGroupAdd(tagGroupName)

        const response = new grpcPuppet.TagGroupAddResponse()

        if (result) {
          response.setTagGroupId(result)
        }

        return callback(null, response)
      } catch (e) {
        return grpcError('tagGroupAdd', e, callback)
      }
    },

    tagGroupDelete: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagGroupDelete()')

      try {
        const tagGroupId = call.request.getTagGroupId()

        await puppet.tagGroupDelete(tagGroupId)

        return callback(null, new grpcPuppet.TagGroupDeleteResponse())
      } catch (e) {
        return grpcError('tagGroupDelete', e, callback)
      }
    },

    tagTagAdd: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagTagAdd()')

      try {
        const tagGroupId = call.request.getTagGroupId()
        const tagNameList = call.request.getTagNameList()

        const result = await puppet.tagTagAdd(tagNameList, tagGroupId)
        const response = new grpcPuppet.TagTagAddResponse()

        if (result) {
          const tagInfoList : grpcPuppet.TagTagInfo[] = result.map(i => {
            const tagInfo = new grpcPuppet.TagTagInfo()
            tagInfo.setTagId(i.id)
            tagInfo.setTagName(i.name)
            return tagInfo
          })
          response.setTagInfoList(tagInfoList)
        }

        return callback(null, response)
      } catch (e) {
        return grpcError('tagTagAdd', e, callback)
      }
    },

    tagTagDelete: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagTagDelete()')

      try {
        const tagIdList = call.request.getTagIdList()

        await puppet.tagTagDelete(tagIdList)

        return callback(null, new grpcPuppet.TagTagDeleteResponse())
      } catch (e) {
        return grpcError('tagTagDelete', e, callback)
      }
    },

    tagTagModify: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagTagModify()')

      try {
        const tagInfoList = call.request.getTagNewInfoList()
        const newInfoList : PUPPET.types.TagInfo[] = tagInfoList.map(i => {
          const info :PUPPET.types.TagInfo = {
            id  : i.getTagId(),
            name: i.getTagName(),
          }
          return info
        })

        const result = await puppet.tagTagModify(newInfoList)
        const response = new grpcPuppet.TagTagModifyResponse()
        if (result) {
          const tagInfoList : grpcPuppet.TagTagInfo[] = result.map(i => {
            const tagInfo = new grpcPuppet.TagTagInfo()
            tagInfo.setTagId(i.id)
            tagInfo.setTagName(i.name)
            return tagInfo
          })
          response.setTagInfoList(tagInfoList)
        }

        return callback(null, response)
      } catch (e) {
        return grpcError('tagTagModify', e, callback)
      }
    },

    tagGroupList: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagGroupList()')
      void call

      try {
        const result = await puppet.tagGroupList()
        const response = new grpcPuppet.TagGroupListResponse()
        response.setTagGroupIdsList(result)

        return callback(null, response)
      } catch (e) {
        return grpcError('tagGroupList', e, callback)
      }
    },

    tagGroupTagList: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagGroupTagList()')

      try {
        const tagGroupId = call.request.getTagGroupId()

        const result = await puppet.tagGroupTagList(tagGroupId)

        const response = new grpcPuppet.TagGroupTagListResponse()
        response.setTagIdsList(result)

        return callback(null, response)
      } catch (e) {
        return grpcError('tagTagList', e, callback)
      }
    },

    tagTagList: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagTagList()')
      void call

      try {
        const result = await puppet.tagTagList()

        const response = new grpcPuppet.TagTagListResponse()
        response.setTagIdsList(result)

        return callback(null, response)
      } catch (e) {
        return grpcError('tagTagList', e, callback)
      }
    },

    tagContactTagList: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagContactTagList()')

      try {
        const contactId = call.request.getContactId()

        const result = await puppet.tagContactTagList(contactId)

        const response = new grpcPuppet.TagContactTagListResponse()
        response.setTagIdsList(result)

        return callback(null, response)
      } catch (e) {
        return grpcError('tagContactTagList', e, callback)
      }
    },

    tagTagContactList: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagTagContactList()')

      try {
        const tagId = call.request.getTagId()

        const result = await puppet.tagTagContactList(tagId)

        const response = new grpcPuppet.TagTagContactListResponse()
        response.setContactIdsList(result)

        return callback(null, response)
      } catch (e) {
        return grpcError('tagTagContactList', e, callback)
      }
    },

    tagGroupPayload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagGroupPayload()')

      try {
        const id = call.request.getGroupId()

        const result = await puppet.tagGroupPayloadPuppet(id)
        const response = new grpcPuppet.TagGroupPayloadResponse()
        const payload = new grpcPuppet.TagGroupPayload()
        payload.setId(result.id)
        payload.setName(result.name)
        payload.setType(result.type)
        response.setPayload(payload)

        return callback(null, response)

      } catch (e) {
        return grpcError('tagTagContactList', e, callback)
      }
    },

    tagPayload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'tagPayload()')

      try {
        const tagId = call.request.getTagId()

        const result = await puppet.tagPayloadPuppet(tagId)
        const response = new grpcPuppet.TagPayloadResponse()
        const payload = new grpcPuppet.TagPayload()
        payload.setId(result.id)
        payload.setName(result.name)
        payload.setType(result.type)
        if (result.groupId) {
          payload.setGroupId(result.groupId)
        }
        response.setPayload(payload)

        return callback(null, response)

      } catch (e) {
        return grpcError('tagTagContactList', e, callback)
      }
    },

    version: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'version() v%s', puppet.version())
      void call

      try {
        const version = puppet.version()

        const response = new grpcPuppet.VersionResponse()
        response.setVersion(version)

        return callback(null, response)

      } catch (e) {
        return grpcError('version', e, callback)
      }
    },

    /**
     *
     * Post & Moment
     *
     */

    momentPublish: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'momentPublish()')

      try {
        const post = call.request.getPost()
        if (!post) {
          throw new Error('no post found')
        }
        const type = post.getType()
        if (type !== grpcPuppet.PostType.POST_TYPE_MOMENT) {
          throw new Error('cannot publish non-moment post')
        }
        const payload = postPbToPayload(post, FileBoxUuid)

        const momentId = await puppet.postPublish(payload)
        const response = new grpcPuppet.MomentPublishResponse()
        if (momentId) {
          response.setMomentId(momentId)
        }

        return callback(null, response)

      } catch (e) {
        return grpcError('momentPublish', e, callback)
      }

    },

    momentUnpublish: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'momentUnpublish()')

      try {
        const id = call.request.getMomentId()
        await puppet.postUnpublish(id)

        const response = new grpcPuppet.MomentUnpublishResponse()

        return callback(null, response)

      } catch (e) {
        return grpcError('momentUnpublish', e, callback)
      }

    },

    postTap: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'postLike()')

      try {
        const postId = call.request.getPostId()
        const type = call.request.getType()
        const tap = call.request.getTap()

        const result = await puppet.tap(postId, type, tap)
        const response = new grpcPuppet.PostTapResponse()
        response.setTap(result || false)

        return callback(null, response)
      } catch (e) {
        return grpcError('postLike', e, callback)
      }
    },

    momentSignature: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'momentSignature()')

      try {
        const signature = call.request.getText()
        const result = await puppet.momentSignature(signature || undefined)

        const response = new grpcPuppet.MomentSignatureResponse()
        if (result) {
          response.setText(result)
        }

        return callback(null, response)
      } catch (e) {
        return grpcError('momentSignature', e, callback)
      }
    },

    momentCoverage: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'momentCoverage()')

      try {
        const fileJsonStr = call.request.getFileBox()

        const response = new grpcPuppet.MomentCoverageResponse()

        if (fileJsonStr) {
          const file = FileBoxUuid.fromJSON(fileJsonStr)
          await puppet.momentCoverage(file)
        } else {
          const file = await puppet.momentCoverage()
          if (file) {
            response.setFileBox(await serializeFileBox(file))
          } else {
            throw new Error('fail to get moment coverage')
          }
        }

        return callback(null, response)
      } catch (e) {
        return grpcError('momentCoverage', e, callback)
      }
    },

    postPayload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'postPayload()')

      try {
        const postId = call.request.getPostId()
        const postPayload = await puppet.postPayload(postId) as PUPPET.payloads.PostServer

        const response = new grpcPuppet.PostPayloadResponse()
        const postPayloadPb = new grpcPuppet.PostPayloadServer()
        if (postPayload.parentId) { postPayloadPb.setParentId(postPayload.parentId) }
        if (postPayload.rootId) { postPayloadPb.setRootId(postPayload.rootId) }
        if (postPayload.type) {
          postPayloadPb.setType(postPayload.type)
        } else {
          postPayloadPb.setType(grpcPuppet.PostType.POST_TYPE_UNSPECIFIED)
        }
        if (postPayload.contactId) { postPayloadPb.setContactId(postPayload.contactId) }
        postPayloadPb.setTimestamp(timestampFromMilliseconds(postPayload.timestamp))
        if (postPayload.counter.children) { postPayloadPb.setChildren(postPayload.counter.children) }
        if (postPayload.counter.descendant) { postPayloadPb.setDescendant(postPayload.counter.descendant) }
        if (postPayload.counter.taps && postPayload.counter.taps[PUPPET.types.Tap.Like]) {
          postPayloadPb.setLike(postPayload.counter.taps[PUPPET.types.Tap.Like]!)
        }
        const sayablePbList = []
        for (const sayable of postPayload.sayableList) {
          const sayablePb = new grpcPuppet.PostSayable()
          sayablePb.setId(sayable)
          sayablePbList.push(sayablePb)
        }
        postPayloadPb.setSayableListList(sayablePbList)

        postPayloadPb.setVisibleListList(postPayload.visibleList || [])
        if (postPayload.location) {
          const locationPb = new grpcPuppet.LocationPayload()
          locationPb.setLatitude(postPayload.location.latitude)
          locationPb.setLongitude(postPayload.location.longitude)
          locationPb.setAddress(postPayload.location.address)
          locationPb.setAccuracy(postPayload.location.accuracy)
          locationPb.setName(postPayload.location.name)
          postPayloadPb.setLocation(locationPb)
        }
        response.setPost(postPayloadPb)

        return callback(null, response)
      } catch (e) {
        return grpcError('postPayload', e, callback)
      }

    },

    postPayloadSayable: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'postPayloadSayable()')

      try {
        const postId = call.request.getPostId()
        const sayableId = call.request.getSayableId()

        const result = await puppet.postPayloadSayable(postId, sayableId)
        const response = new grpcPuppet.PostPayloadSayableResponse()
        const sayablePb = new grpcPuppet.PostSayable()
        switch (result.type) {
          case PUPPET.types.Sayable.Text:
            sayablePb.setType(grpcPuppet.SayableType.SAYABLE_TYPE_TEXT)
            sayablePb.setText(result.payload.text)
            sayablePb.setMentionIdListList(result.payload.mentions)
            break
          case PUPPET.types.Sayable.Attachment: {
            sayablePb.setType(grpcPuppet.SayableType.SAYABLE_TYPE_FILE)
            const serializedFileBox = typeof result.payload.filebox === 'string' ? result.payload.filebox : await serializeFileBox(result.payload.filebox)
            sayablePb.setFileBox(serializedFileBox)
            break
          }
          case PUPPET.types.Sayable.Url: {
            sayablePb.setType(grpcPuppet.SayableType.SAYABLE_TYPE_URL)
            const urlLinkPayload = result.payload
            const pbUrlLinkPayload = urlLinkPayloadToPb(grpcPuppet, urlLinkPayload)
            sayablePb.setUrlLink(pbUrlLinkPayload)
            break
          }
          case PUPPET.types.Sayable.Channel: {
            sayablePb.setType(grpcPuppet.SayableType.SAYABLE_TYPE_CHANNEL)
            const channelPayload = result.payload
            const pbChannelPayload = channelPayloadToPb(grpcPuppet, channelPayload)
            sayablePb.setChannel(pbChannelPayload)
            break
          }
          default:
            throw new Error(`postPayloadSayable unsupported type ${result.type}`)
        }
        response.setSayable(sayablePb)

        return callback(null, response)
      } catch (e) {
        return grpcError('postPayloadSayable', e, callback)
      }
    },

    momentVisibleList: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'momentVisibleList()')

      void call

      try {
        const contactIdsList = await puppet.momentVisibleList()

        const response = new grpcPuppet.MomentVisibleListResponse()
        response.setContactIdsList(contactIdsList)

        return callback(null, response)

      } catch (e) {
        return grpcError('momentVisibleList', e, callback)
      }
    },

    getContactExternalUserId: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'getContactExternalUserId()')

      try {
        const contactIds = call.request.getContactIdsList()
        const serviceProviderId = call.request.getServiceProviderId()

        const pairs = await puppet.getContactExternalUserId(contactIds, serviceProviderId)

        const response = new grpcPuppet.GetContactExternalUserIdResponse()
        const contactExternalUserIdParisList: grpcPuppet.ContactExternalUserIdPair[] = []
        for (const pair of pairs) {
          const grpcPair = new grpcPuppet.ContactExternalUserIdPair()
          grpcPair.setContactId(pair.contactId)
          grpcPair.setExternalUserId(pair.externalUserId)
        }

        response.setContactExternalUserIdPairsList(contactExternalUserIdParisList)

        return callback(null, response)

      } catch (e) {
        return grpcError('getContactExternalUserId', e, callback)
      }
    },

    getRoomAntiSpamStrategyList: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'getRoomAntiSpamStrategyList()')

      try {
        void call

        const strategies = await puppet.getRoomAntiSpamStrategyList()

        const response = new grpcPuppet.GetRoomAntiSpamStrategyListResponse()
        const strategyPbList: grpcPuppet.RoomAntiSpamStrategy[] = []

        for (const strategy of strategies) {
          const strategyPb = new grpcPuppet.RoomAntiSpamStrategy()
          strategyPb.setId(strategy.id)
          strategyPb.setName(strategy.name)
          strategyPbList.push(strategyPb)
        }

        response.setStrategiesList(strategyPbList)

        return callback(null, response)
      } catch (e) {
        return grpcError('getRoomAntiSpamStrategyList', e, callback)
      }
    },

    getRoomAntiSpamStrategyEffectRoomList: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'getRoomAntiSpamStrategyEffectRoomList()')

      try {
        const strategyId = call.request.getStrategyId()

        const roomIds = await puppet.getRoomAntiSpamStrategyEffectRoomList(strategyId)

        const response = new grpcPuppet.GetRoomAntiSpamStrategyEffectRoomListResponse()

        response.setRoomIdsList(roomIds)

        return callback(null, response)
      } catch (e) {
        return grpcError('getRoomAntiSpamStrategyEffectRoomList', e, callback)
      }
    },

    applyRoomAntiSpamStrategy: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'applyRoomAntiSpamStrategy()')

      try {
        const strategyId = call.request.getStrategyId()
        const roomIds = call.request.getRoomIdsList()
        const active = call.request.getActive()

        await puppet.applyRoomAntiSpamStrategy(strategyId, roomIds, active)

        const response = new grpcPuppet.ApplyRoomAntiSpamStrategyResponse()

        return callback(null, response)
      } catch (e) {
        return grpcError('applyRoomAntiSpamStrategy', e, callback)
      }
    },

    getCorpMessageInterceptionStrategies: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'getCorpMessageInterceptionStrategies()')

      try {
        void call

        const strategies = await puppet.getCorpMessageInterceptionStrategies()

        const response = new grpcPuppet.GetCorpMessageInterceptionStrategiesResponse()
        const strategiesPb: grpcPuppet.CorpMessageInterceptionStrategy[] = []

        for (const strategy of strategies) {
          const strategyPb = new grpcPuppet.CorpMessageInterceptionStrategy()
          strategyPb.setName(strategy.name)
          strategyPb.setWordsList(strategy.words)
          strategyPb.setPhoneNumber(strategy.phoneNumber)
          strategyPb.setEmail(strategy.email)
          strategyPb.setRedPacket(strategy.redPacket)
          strategyPb.setType(strategy.type)
          strategiesPb.push(strategyPb)
        }

        response.setStrategiesList(strategiesPb)

        return callback(null, response)
      } catch (e) {
        return grpcError('applyRoomAntiSpamStrategy', e, callback)
      }
    },

    download: async (call) => {
      log.verbose('PuppetServiceImpl', 'download()')

      try {
        const uuid = call.request.getId()
        const fileBox = FileBoxUuid.fromUuid(uuid, { name: 'uuid.dat' })

        fileBox
          .pipe(chunkEncoder(grpcPuppet.DownloadResponse))
          .pipe(call as unknown as Writable)  // Huan(202203) FIXME: as unknown as
      } catch (e) {
        call.destroy(e as Error)
      }

    },

    upload: async (call, callback) => {
      log.verbose('PuppetServiceImpl', 'upload()')

      const fileBox = FileBoxUuid.fromStream(
        call.pipe(chunkDecoder()),
        'uuid.dat',
      )

      const uuid = await fileBox.toUuid()

      const response = new grpcPuppet.UploadResponse()
      response.setId(uuid)

      return callback(null, response)
    },

  }

  return puppetServerImpl
}

export { puppetImplementation }
