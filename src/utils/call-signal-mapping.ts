import * as PUPPET             from '@juzi/wechaty-puppet'
import { puppet as grpcPuppet } from '@juzi/wechaty-grpc'

// Both CallSignal and CallMediaType are added in @juzi/wechaty-puppet 1.0.138.
// The (x as any) casts below are intentional bridges for the transition period:
// they let lint:es pass today and will be replaced with proper types once the
// upstream package is published.

/**
 * Maps a PUPPET CallSignal string value to its gRPC proto number.
 *
 * PUPPET values: 'invite' | 'ringing' | 'accept' | 'reject' | 'cancel' | 'hangup'
 * gRPC values:   CALL_SIGNAL_INVITE=1 … CALL_SIGNAL_HANGUP=6
 */
const grpcSignalByPuppetValue: Record<string, number> = {
  invite:  1, // CALL_SIGNAL_INVITE
  ringing: 2, // CALL_SIGNAL_RINGING
  accept:  3, // CALL_SIGNAL_ACCEPT
  reject:  4, // CALL_SIGNAL_REJECT
  cancel:  5, // CALL_SIGNAL_CANCEL
  hangup:  6, // CALL_SIGNAL_HANGUP
}

const puppetSignalByGrpcValue: Record<number, string> = {
  1: 'invite',
  2: 'ringing',
  3: 'accept',
  4: 'reject',
  5: 'cancel',
  6: 'hangup',
}

export function puppetCallSignalToGrpc (signal: unknown): number {
  const grpcVal = grpcSignalByPuppetValue[signal as string]
  if (grpcVal === undefined) {
    throw new Error(`puppetCallSignalToGrpc: unknown CallSignal "${signal}"`)
  }
  return grpcVal
}

export function grpcCallSignalToPuppet (grpcSignal: number): PUPPET.types.CallSignal {
  const tsVal = puppetSignalByGrpcValue[grpcSignal]
  if (tsVal === undefined) {
    throw new Error(`grpcCallSignalToPuppet: unknown gRPC CallSignal value ${grpcSignal}`)
  }
  // Cast required until wechaty-puppet 1.0.138 is installed locally
  return tsVal as unknown as PUPPET.types.CallSignal
}

/**
 * Maps a PUPPET CallMediaType string value to its gRPC CallType number.
 *
 * PUPPET values: 'audio' | 'video' | undefined
 * gRPC values:   CALL_TYPE_UNKNOWN=0, CALL_TYPE_VOICE=1, CALL_TYPE_VIDEO=2
 */
export function puppetCallMediaTypeToGrpc (media: unknown): number {
  if (media === undefined || media === null) {
    return 0 // CALL_TYPE_UNKNOWN
  }
  switch (media as string) {
    case 'audio': return 1 // CALL_TYPE_VOICE
    case 'video': return 2 // CALL_TYPE_VIDEO
    default:
      throw new Error(`puppetCallMediaTypeToGrpc: unknown CallMediaType "${media}"`)
  }
}

export function grpcCallTypeToPuppetMedia (grpcType: number): PUPPET.types.CallMediaType | undefined {
  switch (grpcType) {
    case 0: return undefined
    case 1: return 'audio' as unknown as PUPPET.types.CallMediaType
    case 2: return 'video' as unknown as PUPPET.types.CallMediaType
    default:
      throw new Error(`grpcCallTypeToPuppetMedia: unknown gRPC CallType value ${grpcType}`)
  }
}

// Suppress unused-import warning — grpcPuppet is referenced for type documentation
// and will be used directly once @juzi/wechaty-grpc 1.0.102 is available.
void (grpcPuppet)
