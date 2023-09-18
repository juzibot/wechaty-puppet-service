import {
  puppet,
} from '@juzi/wechaty-grpc'

import * as PUPPET from '@juzi/wechaty-puppet'
import type { FileBox, FileBoxInterface } from 'file-box'

type grpcPuppet = typeof puppet

export const miniProgramPayloadToPb = (grpcPuppet: grpcPuppet, miniProgramPayload: PUPPET.payloads.MiniProgram) => {
  const pbMiniProgramPayload = new grpcPuppet.MiniProgramPayload()
  if (miniProgramPayload.appid) { pbMiniProgramPayload.setAppid(miniProgramPayload.appid) }
  if (miniProgramPayload.description) { pbMiniProgramPayload.setDescription(miniProgramPayload.description) }
  if (miniProgramPayload.iconUrl) { pbMiniProgramPayload.setIconUrl(miniProgramPayload.iconUrl) }
  if (miniProgramPayload.pagePath) { pbMiniProgramPayload.setPagePath(miniProgramPayload.pagePath) }
  if (miniProgramPayload.shareId) { pbMiniProgramPayload.setShareId(miniProgramPayload.shareId) }
  if (miniProgramPayload.thumbKey) { pbMiniProgramPayload.setThumbKey(miniProgramPayload.thumbKey) }
  if (miniProgramPayload.thumbUrl) { pbMiniProgramPayload.setThumbUrl(miniProgramPayload.thumbUrl) }
  if (miniProgramPayload.title) { pbMiniProgramPayload.setTitle(miniProgramPayload.title) }
  if (miniProgramPayload.username) { pbMiniProgramPayload.setUsername(miniProgramPayload.username) }

  return pbMiniProgramPayload
}

export const miniProgramPbToPayload = (miniProgramPayloadPb: puppet.MiniProgramPayload) => {
  const _miniProgramPayloadPb = miniProgramPayloadPb.toObject()
  const miniProgramPayload: PUPPET.payloads.MiniProgram = {
    ..._miniProgramPayloadPb,
  }
  return miniProgramPayload
}

export const urlLinkPayloadToPb = (grpcPuppet: grpcPuppet, urlLinkPayload: PUPPET.payloads.UrlLink) => {
  const pbUrlLinkPayload = new grpcPuppet.UrlLinkPayload()
  pbUrlLinkPayload.setUrl(urlLinkPayload.url)
  pbUrlLinkPayload.setTitle(urlLinkPayload.title)
  if (urlLinkPayload.description) { pbUrlLinkPayload.setDescription(urlLinkPayload.description) }
  if (urlLinkPayload.thumbnailUrl) { pbUrlLinkPayload.setThumbnailUrl(urlLinkPayload.thumbnailUrl) }
  return pbUrlLinkPayload
}

export const urlLinkPbToPayload = (urlLinkPayloadPb: puppet.UrlLinkPayload) => {
  const _urlLinkPayloadPb = urlLinkPayloadPb.toObject()
  const urlLinkPayload: PUPPET.payloads.UrlLink = {
    ..._urlLinkPayloadPb,
  }
  return urlLinkPayload
}

export const channelPayloadToPb = (grpcPuppet: grpcPuppet, channelPayload: PUPPET.payloads.Channel) => {
  const pbChannelPayload = new grpcPuppet.ChannelPayload()
  if (channelPayload.avatar) { pbChannelPayload.setAvatar(channelPayload.avatar) }
  if (channelPayload.coverUrl) { pbChannelPayload.setCoverUrl(channelPayload.coverUrl) }
  if (channelPayload.desc) { pbChannelPayload.setDesc(channelPayload.desc) }
  if (channelPayload.extras) { pbChannelPayload.setExtras(channelPayload.extras) }
  if (channelPayload.feedType) { pbChannelPayload.setFeedType(channelPayload.feedType) }
  if (channelPayload.nickname) { pbChannelPayload.setNickname(channelPayload.nickname) }
  if (channelPayload.thumbUrl) { pbChannelPayload.setThumbUrl(channelPayload.thumbUrl) }
  if (channelPayload.url) { pbChannelPayload.setUrl(channelPayload.url) }
  if (channelPayload.objectId) { pbChannelPayload.setObjectId(channelPayload.objectId) }
  if (channelPayload.objectNonceId) { pbChannelPayload.setObjectNonceId(channelPayload.objectNonceId) }
  return pbChannelPayload
}

export const channelPbToPayload = (channelPayloadPb: puppet.ChannelPayload) => {
  const _channelPayloadPb = channelPayloadPb.toObject()
  const channelPayload: PUPPET.payloads.Channel = {
    ..._channelPayloadPb,
  }
  return channelPayload
}

export const postPayloadToPb = async (grpcPuppet: grpcPuppet, payload: PUPPET.payloads.PostClient, serializeFileBox: (filebox: FileBoxInterface) => Promise<string>) => {
  const pb = new grpcPuppet.PostPayloadClient()
  pb.setType(payload.type || 0)
  for (const item of payload.sayableList) {
    const sayable = new grpcPuppet.PostSayable()
    switch (item.type) {
      case PUPPET.types.Sayable.Text:
        sayable.setType(grpcPuppet.SayableType.SAYABLE_TYPE_TEXT)
        sayable.setText(item.payload.text)
        sayable.setMentionIdListList(item.payload.mentions)
        break
      case PUPPET.types.Sayable.Attachment: {
        sayable.setType(grpcPuppet.SayableType.SAYABLE_TYPE_FILE)
        const serializedFileBox = typeof item.payload.filebox === 'string' ? item.payload.filebox : (await serializeFileBox(item.payload.filebox))
        sayable.setFileBox(serializedFileBox)
        break
      }
      case PUPPET.types.Sayable.Url: {
        sayable.setType(grpcPuppet.SayableType.SAYABLE_TYPE_URL)
        const urlLinkPayload = item.payload
        const pbUrlLinkPayload = urlLinkPayloadToPb(grpcPuppet, urlLinkPayload)
        sayable.setUrlLink(pbUrlLinkPayload)
        break
      }
      case PUPPET.types.Sayable.Channel: {
        sayable.setType(grpcPuppet.SayableType.SAYABLE_TYPE_CHANNEL)
        const channelPayload = item.payload
        const pbChannelPayload = channelPayloadToPb(grpcPuppet, channelPayload)
        sayable.setChannel(pbChannelPayload)
        break
      }
      case PUPPET.types.Sayable.MiniProgram: {
        sayable.setType(grpcPuppet.SayableType.SAYABLE_TYPE_MINIPROGRAM)
        const miniProgramPayload = item.payload
        const pbMiniProgramPayload = miniProgramPayloadToPb(grpcPuppet, miniProgramPayload)
        sayable.setMiniProgram(pbMiniProgramPayload)
        break
      }
      default:
        throw new Error(`postPublish unsupported type ${item.type}`)
    }
    pb.addSayableList(sayable)
  }
  if (payload.rootId) { pb.setRootId(payload.rootId) }
  if (payload.parentId) { pb.setParentId(payload.parentId) }
  if (payload.location) {
    const location = new grpcPuppet.LocationPayload()
    location.setAccuracy(payload.location.accuracy)
    location.setAddress(payload.location.address)
    location.setName(payload.location.name)
    location.setLatitude(payload.location.latitude)
    location.setLongitude(payload.location.longitude)
    pb.setLocation(location)
  }
  pb.setVisibleListList(payload.visibleList || [])
  return pb
}

export const postPbToPayload = (post: puppet.PostPayloadClient, FileBoxUuid: typeof FileBox) => {
  const payload: PUPPET.payloads.PostClient = {
    type: post.getType(),
    sayableList: [],
    rootId: post.getRootId(),
    parentId: post.getParentId(),
    visibleList: post.getVisibleListList(),
  }

  const sayableList = post.getSayableListList()
  for (const sayable of sayableList) {
    let sayablePayload: PUPPET.payloads.Sayable | undefined
    switch (sayable.getType()) {
      case puppet.SayableType.SAYABLE_TYPE_TEXT:
        sayablePayload = PUPPET.payloads.sayable.text(sayable.getText() || '', sayable.getMentionIdListList())
        break
      case puppet.SayableType.SAYABLE_TYPE_FILE: {
        const fileJsonStr = sayable.getFileBox()
        if (!fileJsonStr) {
          break
        }
        const file = FileBoxUuid.fromJSON(fileJsonStr)
        sayablePayload = PUPPET.payloads.sayable.attachment(file)
        break
      }
      case puppet.SayableType.SAYABLE_TYPE_URL: {
        const urlLinkPayloadPb = sayable.getUrlLink()
        if (!urlLinkPayloadPb) {
          break
        }
        const urlLinkPayload = urlLinkPbToPayload(urlLinkPayloadPb)
        sayablePayload = PUPPET.payloads.sayable.url(urlLinkPayload)
        break
      }
      case puppet.SayableType.SAYABLE_TYPE_CHANNEL: {
        const channelPayloadPb = sayable.getChannel()
        if (!channelPayloadPb) {
          break
        }
        const channelPayload = channelPbToPayload(channelPayloadPb!)
        sayablePayload = PUPPET.payloads.sayable.channel(channelPayload)
        break
      }
      case puppet.SayableType.SAYABLE_TYPE_MINIPROGRAM: {
        const miniProgramPayloadPb = sayable.getMiniProgram()
        if (!miniProgramPayloadPb) {
          break
        }
        const miniProgramPayload = miniProgramPbToPayload(miniProgramPayloadPb)
        sayablePayload = PUPPET.payloads.sayable.miniProgram(miniProgramPayload)
        break
      }
      default:
        throw new Error(`unsupported postSayableType type ${sayable.getType()}`)
    }
    if (sayablePayload) {
      payload.sayableList.push(sayablePayload)
    } else {
      throw new Error(`unable to fetch sayable from ${JSON.stringify(sayable.toObject())}`)
    }
  }
  const location = post.getLocation()
  if (location) {
    payload.location = {
      name: location.getName() || '',
      accuracy: location.getAccuracy() || 15,
      address: location.getAddress() || '',
      latitude: location.getLatitude(),
      longitude: location.getLatitude(),
    }
  }
  return payload
}

export const OptionalBooleanWrapper = (val?: boolean) => {
  if (typeof val === 'boolean') {
    return val ? puppet.OptionalBoolean.BOOL_TRUE : puppet.OptionalBoolean.BOOL_FALSE
  } else {
    return puppet.OptionalBoolean.BOOL_UNSET
  }
}

export const OptionalBooleanUnwrapper = (val: puppet.OptionalBooleanMap[keyof puppet.OptionalBooleanMap]) => {
  switch (val) {
    case puppet.OptionalBoolean.BOOL_TRUE:
      return true
    case puppet.OptionalBoolean.BOOL_FALSE:
      return false
    case puppet.OptionalBoolean.BOOL_UNSET:
    default:
      return undefined
  }
}

export const callRecordPbToPayload = (callRecordPb: puppet.CallRecordPayload) => {
  const callRecordPayload: PUPPET.payloads.CallRecord = {
    starter: callRecordPb.getStarterId(),
    participants: callRecordPb.getParticipantIdsList() || [],
    length: callRecordPb.getLength() || 0,
    type: callRecordPb.getType(),
    status: callRecordPb.getStatus(),
  }
  return callRecordPayload
}
