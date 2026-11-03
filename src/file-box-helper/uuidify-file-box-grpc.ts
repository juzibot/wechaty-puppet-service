import type {
  Readable,
}                       from 'stream'
import { PassThrough } from 'stream'

import {
  FileBox,
  UuidLoader,
  UuidSaver,
}                         from 'file-box'
import {
  chunkDecoder,
  chunkEncoder,
  puppet as pbPuppet,
}                         from '@juzi/wechaty-grpc'
import {
  cloneClass,
  Constructor,
}                         from 'clone-class'

const uuidResolverGrpc: (grpcClient: () => pbPuppet.PuppetClient) => UuidLoader = (
  grpcClient,
) => async function uuidResolver (
  this : FileBox,
  uuid : string,
) {
  const request = new pbPuppet.DownloadRequest()
  request.setId(uuid)

  const response = grpcClient().download(request)

  const stream = response
    .pipe(chunkDecoder())

  response.on('error', e => {
    stream.emit('error', e)
  })

  return stream
}

const uuidRegisterGrpc: (grpcClient: () => pbPuppet.PuppetClient) => UuidSaver = (
  grpcClient,
) => async function uuidRegister (
  this   : FileBox,
  stream : Readable,
) {
  const response = await new Promise<pbPuppet.UploadResponse>((resolve, reject) => {
    const request = grpcClient().upload((err, response) => {
      if (err) {
        reject(err)
      } else {
        resolve(response)
      }
    })

    const initRequest = new pbPuppet.UploadRequest()
    request.write(initRequest)

    setTimeout(() => {
      stream
        .pipe(chunkEncoder(pbPuppet.UploadRequest))
        .pipe(request)
    }, 1000)

  })

  const uuid = response.getId()
  return uuid
}

// File sends use this directly so cancellation can detach exactly the pipe
// it owns, without FileBox.toUuid's additional pipe/error-forwarding listeners.
const uploadFileBoxForRun = async (
  client: pbPuppet.PuppetClient,
  stream: Readable,
  assertCurrent: () => void,
): Promise<string> => {
  const response = await new Promise<pbPuppet.UploadResponse>((resolve, reject) => {
    const state = { settled: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: ReturnType<pbPuppet.PuppetClient['upload']> | undefined
    let bytes: PassThrough | undefined
    let encoder: ReturnType<typeof chunkEncoder> | undefined

    const finish = (error: unknown, response?: pbPuppet.UploadResponse): void => {
      if (state.settled) { return }
      state.settled = true
      clearTimeout(timer)
      stream.removeListener('error', fail)
      if (bytes) {
        stream.unpipe(bytes)
        bytes.unpipe()
        bytes.destroy()
      }
      if (encoder) {
        encoder.unpipe()
        encoder.destroy()
      }
      if (error) {
        reject(error)
        request?.cancel()
      } else {
        resolve(response!)
      }
    }
    const fail = (error: unknown): void => { finish(error) }
    stream.on('error', fail)
    try {
      // normalizeFileBoxUuid has awaited toStream before entering this saver.
      assertCurrent()
      request = client.upload((error, response) => { finish(error, response) })
      if (state.settled) { return }
      request.on('error', fail)
      request.write(new pbPuppet.UploadRequest())
      timer = setTimeout(() => {
        if (state.settled) { return }
        try {
          assertCurrent()
          // Keep FileBox.toUuid's byte-mode boundary: protobuf bytes fields
          // interpret strings as base64, while file stream strings are UTF-8.
          bytes = new PassThrough()
          bytes.on('error', fail)
          encoder = chunkEncoder(pbPuppet.UploadRequest)
          encoder.on('error', fail)
          stream.pipe(bytes).pipe(encoder).pipe(request!)
        } catch (error) { fail(error) }
      }, 1000)
    } catch (error) { fail(error) }
  })
  return response.getId()
}

type UuidifyFileBoxGrpcFactory = (grpcClient: () => pbPuppet.PuppetClient) => typeof FileBox

const uuidifyFileBoxGrpc: UuidifyFileBoxGrpcFactory = (
  grpcClient,
) => {
  /**
   * `as any`:
   *
   * Huan(202110): TypeError: Cannot read property 'valueDeclaration' of undefined #58
   *  https://github.com/huan/clone-class/issues/58
   */
  const FileBoxUuid: typeof FileBox = cloneClass(FileBox as any as Constructor<FileBox>) as any

  FileBoxUuid.setUuidLoader(uuidResolverGrpc(grpcClient))
  FileBoxUuid.setUuidSaver(uuidRegisterGrpc(grpcClient))

  return FileBoxUuid
}

export {
  uuidifyFileBoxGrpc,
  uploadFileBoxForRun,
}
