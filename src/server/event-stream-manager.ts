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
import {
  puppet as grpcPuppet,
  grpc,
}                                   from '@juzi/wechaty-grpc'

import * as PUPPET from '@juzi/wechaty-puppet'

import { log, NO_LOG_EVENTS } from '../config.js'
import {
  EventTypeRev,
}                     from '../event-type-rev.js'

class EventStreamManager {

  protected eventStream: undefined | grpc.ServerWritableStream<grpcPuppet.EventRequest, grpcPuppet.EventResponse>

  private puppetListening = false
  private offCallbackList: (() => void)[] = []

  constructor (
    public puppet: PUPPET.impls.PuppetInterface,
  ) {
    log.verbose('EventStreamManager', 'constructor(%s)', puppet)
  }

  public busy (): boolean {
    return !!this.eventStream
  }

  public start (
    stream: grpc.ServerWritableStream<grpcPuppet.EventRequest, grpcPuppet.EventResponse>,
  ): void {
    log.verbose('EventStreamManager', 'start(stream)')

    if (this.eventStream) {
      throw new Error('can not set twice')
    }

    // clear all listeners before load new ones
    this.removePuppetListeners()

    this.eventStream = stream

    this.connectPuppetEventToStreamingCall()
    this.onStreamingCallEnd()

    /**
     * Huan(202108):
     *  We emit a hearbeat at the beginning of the connect
     *    to identicate that the connection is successeed.
     *
     *  Our client (wechaty-puppet-service client) will wait for the heartbeat
     *    when it connect to the server.
     *
     *  If the server does not send the heartbeat,
     *    then the client will wait for a 5 seconds timeout
     *    for compatible the community gRPC puppet service providers like paimon.
     */
    const connectSuccessHeartbeatPayload = {
      data: 'Wechaty Puppet gRPC stream connect successfully',
    } as PUPPET.payloads.EventHeartbeat
    this.grpcEmit(
      grpcPuppet.EventType.EVENT_TYPE_HEARTBEAT,
      connectSuccessHeartbeatPayload,
    )

    /**
      * We emit the login event if current the puppet is logged in.
      */
    if (this.puppet.isLoggedIn) {
      log.verbose('EventStreamManager', 'start() puppet is logged in, emit a login event for downstream')

      const payload = {
        contactId: this.puppet.currentUserId,
      } as PUPPET.payloads.EventLogin

      this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_LOGIN, payload)
    }

    if (this.puppet.readyIndicator.value()) {
      log.verbose('EventStreamManager', 'start() puppet is ready, emit a ready event for downstream after 15s delay')

      const payload = {
        data: 'ready',
      } as PUPPET.payloads.EventReady

      // no need to make this function async since it won't effect the start process of eventStreamManager
      setTimeout(() => {
        this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_READY, payload)
      }, 15 * 1000)
    }
  }

  public stop (): void {
    log.verbose('EventStreamManager', 'stop()')

    if (!this.eventStream) {
      throw new Error('no this.eventStream')
    }

    this.removePuppetListeners()
    this.eventStream.end()
    this.eventStream = undefined
  }

  public grpcEmit (
    type : grpcPuppet.EventTypeMap[keyof grpcPuppet.EventTypeMap],  // https://stackoverflow.com/a/49286056/1123955
    obj  : object,
  ): void {
    log.verbose('EventStreamManager', 'grpcEmit(%s[%s], %s)',
      EventTypeRev[type],
      type,
      JSON.stringify(obj),
    )

    if (!NO_LOG_EVENTS.includes(type)) {
      log.info('EventStreamManager', `emiting grpc event ${EventTypeRev[type]} on ${new Date().toString()}, content: ${JSON.stringify(obj)}`)
    }

    const response = new grpcPuppet.EventResponse()

    response.setType(type)
    response.setPayload(
      JSON.stringify(obj),
    )

    if (this.eventStream) {
      this.eventStream.write(response)
    } else {
      /**
        * Huan(202108): TODO: add a queue for store a maximum number of responses before the stream get connected
        */
      log.warn('EventStreamManager', 'grpcEmit(%s, %s) this.eventStream is undefined.',
        type,
        JSON.stringify(obj),
      )
    }
  }

  public connectPuppetEventToStreamingCall () {
    log.verbose('EventStreamManager', 'connectPuppetEventToStreamingCall() for %s', this.puppet)

    const eventNameList: PUPPET.types.PuppetEventName[] = Object.keys(PUPPET.types.PUPPET_EVENT_DICT) as PUPPET.types.PuppetEventName[]
    for (const eventName of eventNameList) {
      log.verbose('EventStreamManager',
        'connectPuppetEventToStreamingCall() this.puppet.on(%s) (listenerCount:%s) registering...',
        eventName,
        this.puppet.listenerCount(eventName),
      )

      switch (eventName) {
        case 'dong': {
          const listener = (payload: PUPPET.payloads.EventDong) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_DONG, payload)
          this.puppet.on('dong', listener)
          const off = () => this.puppet.off('dong', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'dirty': {
          const listener = (payload: PUPPET.payloads.EventDirty) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_DIRTY, payload)
          this.puppet.on('dirty', listener)
          const off = () => this.puppet.off('dirty', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'error': {
          const listener = (payload: PUPPET.payloads.EventError) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_ERROR, payload)
          this.puppet.on('error', listener)
          const off = () => this.puppet.off('error', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'heartbeat': {
          const listener = (payload: PUPPET.payloads.EventHeartbeat) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_HEARTBEAT, payload)
          this.puppet.on('heartbeat', listener)
          const off = () => this.puppet.off('heartbeat', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'friendship': {
          const listener = (payload: PUPPET.payloads.EventFriendship) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_FRIENDSHIP, payload)
          this.puppet.on('friendship', listener)
          const off = () => this.puppet.off('friendship', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'login': {
          const listener = (payload: PUPPET.payloads.EventLogin) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_LOGIN, payload)
          this.puppet.on('login', listener)
          const off = () => this.puppet.off('login', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'logout': {
          const listener = (payload: PUPPET.payloads.EventLogout) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_LOGOUT, payload)
          this.puppet.on('logout', listener)
          const off = () => this.puppet.off('logout', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'message': {
          const listener = (payload: PUPPET.payloads.EventMessage) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_MESSAGE, payload)
          this.puppet.on('message', listener)
          const off = () => this.puppet.off('message', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'post': {
          const listener = (payload: PUPPET.payloads.EventPost) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_POST, payload)
          this.puppet.on('post', listener)
          const off = () => this.puppet.off('post', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'ready': {
          const listener = (payload: PUPPET.payloads.EventReady) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_READY, payload)
          this.puppet.on('ready', listener)
          const off = () => this.puppet.off('ready', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'room-invite': {
          const listener = (payload: PUPPET.payloads.EventRoomInvite) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_ROOM_INVITE, payload)
          this.puppet.on('room-invite', listener)
          const off = () => this.puppet.off('room-invite', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'room-join': {
          const listener = (payload: PUPPET.payloads.EventRoomJoin) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_ROOM_JOIN, payload)
          this.puppet.on('room-join', listener)
          const off = () => this.puppet.off('room-join', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'room-leave': {
          const listener = (payload: PUPPET.payloads.EventRoomLeave) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_ROOM_LEAVE, payload)
          this.puppet.on('room-leave', listener)
          const off = () => this.puppet.off('room-leave', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'room-topic': {
          const listener = (payload: PUPPET.payloads.EventRoomTopic) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_ROOM_TOPIC, payload)
          this.puppet.on('room-topic', listener)
          const off = () => this.puppet.off('room-topic', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'room-announce': {
          const listener = (payload: PUPPET.payloads.EventRoomAnnounce) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_ROOM_ANNOUNCE, payload)
          this.puppet.on('room-announce', listener)
          const off = () => this.puppet.off('room-announce', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'scan': {
          const listener = (payload: PUPPET.payloads.EventScan) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_SCAN, payload)
          this.puppet.on('scan', listener)
          const off = () => this.puppet.off('scan', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'tag': {
          const listener = (payload: PUPPET.payloads.EventTag) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_TAG, payload)
          this.puppet.on('tag', listener)
          const off = () => this.puppet.off('tag', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'tag-group': {
          const listener = (payload: PUPPET.payloads.EventTagGroup) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_TAG_GROUP, payload)
          this.puppet.on('tag-group', listener)
          const off = () => this.puppet.off('tag-group', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'post-comment': {
          const listener = (payload: PUPPET.payloads.EventPostComment) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_POST_COMMENT, payload)
          this.puppet.on('post-comment', listener)
          const off = () => this.puppet.off('post-comment', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'post-tap': {
          const listener = (payload: PUPPET.payloads.EventPostTap) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_POST_TAP, payload)
          this.puppet.on('post-tap', listener)
          const off = () => this.puppet.off('post-tap', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'verify-code': {
          const listener = (payload: PUPPET.payloads.EventVerifyCode) => this.grpcEmit(grpcPuppet.EventType.EVENT_TYPE_VERIFY_CODE, payload)
          this.puppet.on('verify-code', listener)
          const off = () => this.puppet.off('verify-code', listener)
          this.offCallbackList.push(off)
          break
        }
        case 'reset':
          // the `reset` event should be dealed internally, should not send out
          break

        default:
          // Huan(202003): in default, the `eventName` type should be `never`, please check.
          log.warn('eventName ' + eventName + ' unsupported!')
      }
    }

    this.puppetListening = true
  }

  /**
   * Detect if the streaming call was gone (GRPC disconnects)
   *  https://github.com/grpc/grpc/issues/8117#issuecomment-362198092
   */
  private onStreamingCallEnd () {
    log.verbose('EventStreamManager', 'onStreamingCallEnd()')

    if (!this.eventStream) {
      throw new Error('no this.eventStream found')
    }

    /**
     * Huan(202110): useful log messages
     *
     * ServiceCtl<PuppetServiceMixin> stop() super.stop() ... done
     * StateSwitch <PuppetServiceMixin> inactive(true) <- (pending)
     * EventStreamManager this.onStreamingCallEnd() this.eventStream.on(finish) fired
     * EventStreamManager connectPuppetEventToStreamingCall() offAll() 14 callbacks
     * EventStreamManager this.onStreamingCallEnd() this.eventStream.on(finish) eventStream is undefined
     * EventStreamManager this.onStreamingCallEnd() this.eventStream.on(close) fired
     * EventStreamManager this.onStreamingCallEnd() this.eventStream.on(close) eventStream is undefined
     * EventStreamManager this.onStreamingCallEnd() this.eventStream.on(cancelled) fired with arguments: {}
     * EventStreamManager this.onStreamingCallEnd() this.eventStream.on(cancelled) eventStream is undefined
     * GrpcClient stop() stop client ... done
     */
    this.eventStream.on('cancelled', () => {
      log.verbose('EventStreamManager', 'this.onStreamingCallEnd() this.eventStream.on(cancelled) fired with arguments: %s',
        JSON.stringify(arguments),
      )

      if (this.puppetListening) {
        this.removePuppetListeners()
      }
      if (this.eventStream) {
        this.eventStream = undefined
      } else {
        log.warn('EventStreamManager', 'this.onStreamingCallEnd() this.eventStream.on(cancelled) eventStream is undefined')
      }
    })

    this.eventStream.on('error', err => {
      log.verbose('EventStreamManager', 'this.onStreamingCallEnd() this.eventStream.on(error) fired: %s', err)
      if (this.puppetListening) {
        this.removePuppetListeners()
      }
      if (this.eventStream) {
        this.eventStream = undefined
      } else {
        log.warn('EventStreamManager', 'this.onStreamingCallEnd() this.eventStream.on(error) eventStream is undefined')
      }
    })

    this.eventStream.on('finish', () => {
      log.verbose('EventStreamManager', 'this.onStreamingCallEnd() this.eventStream.on(finish) fired')
      if (this.puppetListening) {
        this.removePuppetListeners()
      }
      if (this.eventStream) {
        this.eventStream = undefined
      } else {
        log.warn('EventStreamManager', 'this.onStreamingCallEnd() this.eventStream.on(finish) eventStream is undefined')
      }
    })

    this.eventStream.on('end', () => {
      log.verbose('EventStreamManager', 'this.onStreamingCallEnd() this.eventStream.on(end) fired')
      if (this.puppetListening) {
        this.removePuppetListeners()
      }
      if (this.eventStream) {
        this.eventStream = undefined
      } else {
        log.warn('EventStreamManager', 'this.onStreamingCallEnd() this.eventStream.on(end) eventStream is undefined')
      }
    })

    this.eventStream.on('close', () => {
      log.verbose('EventStreamManager', 'this.onStreamingCallEnd() this.eventStream.on(close) fired')
      if (this.puppetListening) {
        this.removePuppetListeners()
      }
      if (this.eventStream) {
        this.eventStream = undefined
      } else {
        log.warn('EventStreamManager', 'this.onStreamingCallEnd() this.eventStream.on(close) eventStream is undefined')
      }
    })
  }

  removePuppetListeners () {
    while (this.offCallbackList.length > 0) {
      const func = this.offCallbackList.pop()
      func && func()
    }
  }

}

export { EventStreamManager }
