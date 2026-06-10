import * as PUPPET              from '@juzi/wechaty-puppet'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

type GrpcCallSignal = grpcPuppet.CallSignalMap[keyof grpcPuppet.CallSignalMap]
type GrpcCallType   = grpcPuppet.CallTypeMap[keyof grpcPuppet.CallTypeMap]

/**
 * PUPPET CallSignal (string enum) -> gRPC CallSignal (number enum).
 * The `never` check in default guarantees exhaustiveness at compile time,
 * while the throw still guards against untyped callers at runtime.
 */
export function puppetCallSignalToGrpc (signal: PUPPET.types.CallSignal): GrpcCallSignal {
  switch (signal) {
    case PUPPET.types.CallSignal.Invite:  return grpcPuppet.CallSignal.CALL_SIGNAL_INVITE
    case PUPPET.types.CallSignal.Ringing: return grpcPuppet.CallSignal.CALL_SIGNAL_RINGING
    case PUPPET.types.CallSignal.Accept:  return grpcPuppet.CallSignal.CALL_SIGNAL_ACCEPT
    case PUPPET.types.CallSignal.Reject:  return grpcPuppet.CallSignal.CALL_SIGNAL_REJECT
    case PUPPET.types.CallSignal.Cancel:  return grpcPuppet.CallSignal.CALL_SIGNAL_CANCEL
    case PUPPET.types.CallSignal.Hangup:  return grpcPuppet.CallSignal.CALL_SIGNAL_HANGUP
    default: {
      const exhaustive: never = signal
      throw new Error(`puppetCallSignalToGrpc: unknown CallSignal "${String(exhaustive)}"`)
    }
  }
}

export function grpcCallSignalToPuppet (grpcSignal: number): PUPPET.types.CallSignal {
  switch (grpcSignal) {
    case grpcPuppet.CallSignal.CALL_SIGNAL_INVITE:  return PUPPET.types.CallSignal.Invite
    case grpcPuppet.CallSignal.CALL_SIGNAL_RINGING: return PUPPET.types.CallSignal.Ringing
    case grpcPuppet.CallSignal.CALL_SIGNAL_ACCEPT:  return PUPPET.types.CallSignal.Accept
    case grpcPuppet.CallSignal.CALL_SIGNAL_REJECT:  return PUPPET.types.CallSignal.Reject
    case grpcPuppet.CallSignal.CALL_SIGNAL_CANCEL:  return PUPPET.types.CallSignal.Cancel
    case grpcPuppet.CallSignal.CALL_SIGNAL_HANGUP:  return PUPPET.types.CallSignal.Hangup
    default:
      throw new Error(`grpcCallSignalToPuppet: unknown gRPC CallSignal value ${grpcSignal}`)
  }
}

/**
 * PUPPET CallMediaType (string enum) -> gRPC CallType (number enum).
 * media is required per upstream contract: every outbound signal must carry a media type.
 */
export function puppetCallMediaTypeToGrpc (media: PUPPET.types.CallMediaType): GrpcCallType {
  switch (media) {
    case PUPPET.types.CallMediaType.Audio: return grpcPuppet.CallType.CALL_TYPE_VOICE
    case PUPPET.types.CallMediaType.Video: return grpcPuppet.CallType.CALL_TYPE_VIDEO
    default: {
      const exhaustive: never = media
      throw new Error(`puppetCallMediaTypeToGrpc: unknown CallMediaType "${String(exhaustive)}"`)
    }
  }
}

export function grpcCallTypeToPuppetMedia (grpcType: number): PUPPET.types.CallMediaType | undefined {
  switch (grpcType) {
    case grpcPuppet.CallType.CALL_TYPE_UNKNOWN: return undefined
    case grpcPuppet.CallType.CALL_TYPE_VOICE:   return PUPPET.types.CallMediaType.Audio
    case grpcPuppet.CallType.CALL_TYPE_VIDEO:   return PUPPET.types.CallMediaType.Video
    default:
      throw new Error(`grpcCallTypeToPuppetMedia: unknown gRPC CallType value ${grpcType}`)
  }
}
