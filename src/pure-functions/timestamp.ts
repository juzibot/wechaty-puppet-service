import { Timestamp } from '@juzi/wechaty-grpc'

/**
 * https://github.com/protocolbuffers/protobuf/blob/b6993a90605cde15ba004e0287bcb078b0f3959d/src/google/protobuf/timestamp.proto#L86-L91
 */

function timestampFromMilliseconds (milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000)
  const nanos   = (milliseconds % 1000) * 1000000

  const timestamp = new Timestamp()
  timestamp.setSeconds(seconds)
  timestamp.setNanos(nanos)

  return timestamp
}

function millisecondsFromTimestamp (timestamp: ReturnType<typeof timestampFromMilliseconds>) {
  const seconds = timestamp.getSeconds()
  const nanos   = timestamp.getNanos()

  return seconds * 1000 + nanos / 1000000
}

/**
 * Plain `{ seconds, nanos }` shape produced by a protobuf `Message.toObject()`
 * for a `google.protobuf.Timestamp` field.
 */
type TimestampObject = {
  seconds: number,
  nanos: number,
}

/**
 * Same conversion as `millisecondsFromTimestamp`, but for the plain
 * `{ seconds, nanos }` shape produced by `Message.toObject()` rather than a
 * Timestamp class instance. Nanos are rounded to the nearest millisecond.
 */
function millisecondsFromTimestampObject (timestamp: TimestampObject): number {
  return timestamp.seconds * 1000 + Math.round(timestamp.nanos / 1000000)
}

export {
  millisecondsFromTimestamp,
  millisecondsFromTimestampObject,
  timestampFromMilliseconds,
}
