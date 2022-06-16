import type { grpc }  from '@juzi/wechaty-grpc'
import { log }        from '@juzi/wechaty-puppet'
import { GError }     from 'gerror'

type GErrorCallback = (
  gerror: Partial<grpc.StatusObject>,
  value: null,
) => void

export function grpcError (
  method   : string,
  error    : any,
  callback : GErrorCallback,
): void {
  const gerr = GError.from(error)

  log.error('PuppetServiceImpl', `grpcError() ${method}() rejection: %s\n%s`,
    gerr.message,
    gerr.stack,
  )

  return callback(gerr, null)
}
