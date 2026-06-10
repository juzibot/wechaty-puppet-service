import {
  puppet,
}               from '@juzi/wechaty-grpc'

/**
 * Huan(202003):
 *  @chatie/GRPC proto gen TS does not generate the ENUM type with reverse mapping.
 *  So we need to do it by ourselves:
 *    1. define the EventTypeRev, and
 *    2. loop EventType to fill it.
 */
export const EventTypeRev = {} as {
  [key: number]: string,
}

for (const key in puppet.EventType) {
  const val = puppet.EventType[key as keyof puppet.EventTypeMap]
  EventTypeRev[val] = key
}

// EVENT_TYPE_CALL = 35 is added in @juzi/wechaty-grpc 1.0.102.
// Pre-register the reverse mapping so log messages resolve correctly
// even before the generated enum covers this value.
if (!EventTypeRev[35]) {
  EventTypeRev[35] = 'EVENT_TYPE_CALL'
}
