import {
  log,
}                 from '@juzi/wechaty-puppet'
import {
  PuppetService,
}                 from './client/puppet-service.js'
import {
  VERSION,
}                 from './config.js'
import {
  PuppetServer,
  PuppetServerOptions,
}                         from './server/puppet-server.js'

export {
  log,
  PuppetServer,
  PuppetService,
  VERSION,
}
export type {
  PuppetServerOptions,
}

export default PuppetService
export { withRecoveryRequestContext } from './client/recovery.js'
export type { RecoveryOptions, RecoveryRequestContext, RecoveryState } from './client/recovery.js'
export type { PuppetServiceOptions } from './client/puppet-service.js'
export type { TransportStartOptions } from './client/transport-start.js'
