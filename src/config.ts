/// <reference path="./typings.d.ts" />

import { log } from '@juzi/wechaty-puppet'

import { packageJson } from './package-json.js'

import * as rootEnvVars from './env-vars.js'
import * as authEnvVars from './auth/env-vars.js'

import {
  puppet as grpcPuppet,
} from '@juzi/wechaty-grpc'

const VERSION = packageJson.version || '0.0.0'

const envVars = {
  ...rootEnvVars,
  ...authEnvVars,
}

/**
 * gRPC default options
 */
const GRPC_OPTIONS = {
  // https://github.com/wechaty/wechaty-puppet-service/issues/86
  // 'grpc.max_receive_message_length': 1024 * 1024 * 150,
  // 'grpc.max_send_message_length': 1024 * 1024 * 150,
}

export const NO_LOG_EVENTS: grpcPuppet.EventTypeMap[keyof grpcPuppet.EventTypeMap][] = [
  grpcPuppet.EventType.EVENT_TYPE_HEARTBEAT,
  grpcPuppet.EventType.EVENT_TYPE_DONG,
  grpcPuppet.EventType.EVENT_TYPE_DIRTY,
]

export {
  envVars,
  log,
  GRPC_OPTIONS,
  VERSION,
}
