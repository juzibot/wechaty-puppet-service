import type {
  puppet,
} from '@juzi/wechaty-grpc'

import type * as PUPPET from '@juzi/wechaty-puppet'

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
  if (channelPayload.objectNonceId) { pbChannelPayload.setObjectId(channelPayload.objectNonceId) }
  return pbChannelPayload
}

export const channelPbToPayload = (channelPayloadPb: puppet.ChannelPayload) => {
  const _channelPayloadPb = channelPayloadPb.toObject()
  const channelPayload: PUPPET.payloads.Channel = {
    ..._channelPayloadPb,
  }
  return channelPayload
}
