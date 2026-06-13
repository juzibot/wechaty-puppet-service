import * as PUPPET              from '@juzi/wechaty-puppet'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

type GrpcCallType = grpcPuppet.CallTypeMap[keyof grpcPuppet.CallTypeMap]

/**
 * PUPPET CallMediaType (string enum) -> gRPC CallType (number enum).
 * The `never` check in default guarantees exhaustiveness at compile time,
 * while the throw still guards against untyped callers at runtime.
 * media is required per upstream contract: every call invite must carry a media type.
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

/**
 * gRPC CallType (number enum) -> PUPPET CallMediaType (string enum).
 * CALL_TYPE_UNKNOWN (wire zero value) maps to undefined so callers can reject it explicitly.
 */
export function grpcCallTypeToPuppetMedia (grpcType: number): PUPPET.types.CallMediaType | undefined {
  switch (grpcType) {
    case grpcPuppet.CallType.CALL_TYPE_UNKNOWN: return undefined
    case grpcPuppet.CallType.CALL_TYPE_VOICE:   return PUPPET.types.CallMediaType.Audio
    case grpcPuppet.CallType.CALL_TYPE_VIDEO:   return PUPPET.types.CallMediaType.Video
    default:
      throw new Error(`grpcCallTypeToPuppetMedia: unknown gRPC CallType value ${grpcType}`)
  }
}
