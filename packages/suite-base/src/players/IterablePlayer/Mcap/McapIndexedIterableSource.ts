// SPDX-FileCopyrightText: Copyright (C) 2023-2025 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { McapIndexedReader, McapTypes } from "@mcap/core";

import Logger from "@lichtblick/log";
import { ParsedChannel, parseChannel } from "@lichtblick/mcap-support";
import { Time, fromNanoSec, toNanoSec, compare } from "@lichtblick/rostime";
import { MessageEvent, Metadata } from "@lichtblick/suite";
import {
  GetBackfillMessagesArgs,
  Initialization,
  ISerializedIterableSource,
  IteratorResult,
  MessageIteratorArgs,
  TopicWithDecodingInfo,
} from "@lichtblick/suite-base/players/IterablePlayer/IIterableSource";
import { PlayerAlert, TopicStats } from "@lichtblick/suite-base/players/types";
import { RosDatatypes } from "@lichtblick/suite-base/types/RosDatatypes";

const log = Logger.getLogger(__filename);

export class McapIndexedIterableSource implements ISerializedIterableSource {
  #reader: McapIndexedReader;
  #channelInfoById = new Map<
    number,
    {
      channel: McapTypes.Channel;
      parsedChannel: ParsedChannel;
      schemaName: string | undefined;
    }
  >();
  #start?: Time;
  #end?: Time;

  public readonly sourceType = "serialized";

  public constructor(reader: McapIndexedReader) {
    this.#reader = reader;
  }

  public async initialize(): Promise<Initialization> {
    let startTime: bigint | undefined;
    let endTime: bigint | undefined;
    for (const chunk of this.#reader.chunkIndexes) {
      if (startTime == undefined || chunk.messageStartTime < startTime) {
        startTime = chunk.messageStartTime;
      }
      if (endTime == undefined || chunk.messageEndTime > endTime) {
        endTime = chunk.messageEndTime;
      }
    }

    const topicStats = new Map<string, TopicStats>();
    const topicsByName = new Map<string, TopicWithDecodingInfo>();
    const datatypes: RosDatatypes = new Map();
    const alerts: PlayerAlert[] = [];
    const metadata: Metadata[] = [];

    const publishersByTopic = new Map<string, Set<string>>();

    for (const channel of this.#reader.channelsById.values()) {
      const schema = this.#reader.schemasById.get(channel.schemaId);
      if (channel.schemaId !== 0 && schema == undefined) {
        alerts.push({
          severity: "error",
          message: `Missing schema info for schema id ${channel.schemaId} (channel ${channel.id}, topic ${channel.topic})`,
        });
        continue;
      }

      let parsedChannel;
      try {
        parsedChannel = parseChannel({ messageEncoding: channel.messageEncoding, schema });
      } catch (error) {
        alerts.push({
          severity: "error",
          message: `Error in topic ${channel.topic} (channel ${channel.id}): ${error.message}`,
          error,
        });
        continue;
      }
      this.#channelInfoById.set(channel.id, {
        channel,
        parsedChannel,
        schemaName: schema?.name,
      });

      let topic = topicsByName.get(channel.topic);
      if (!topic) {
        topic = {
          name: channel.topic,
          schemaName: schema?.name,
          messageEncoding: channel.messageEncoding,
          schemaData: schema?.data,
          schemaEncoding: schema?.encoding,
        };
        topicsByName.set(channel.topic, topic);

        const numMessages = this.#reader.statistics?.channelMessageCounts.get(channel.id);
        if (numMessages != undefined) {
          topicStats.set(channel.topic, { numMessages: Number(numMessages) });
        }
      }

      // Track the publisher for this topic. "callerid" is defined in the MCAP ROS 1 Well-known
      // profile at <https://mcap.dev/specification/appendix.html>. We skip the profile check to
      // allow non-ROS profiles to utilize this functionality as well
      const publisherId = channel.metadata.get("callerid") ?? String(channel.id);
      let publishers = publishersByTopic.get(channel.topic);
      if (!publishers) {
        publishers = new Set();
        publishersByTopic.set(channel.topic, publishers);
      }
      publishers.add(publisherId);

      // Final datatypes is an unholy union of schemas across all channels
      for (const [name, datatype] of parsedChannel.datatypes) {
        datatypes.set(name, datatype);
      }
    }

    this.#start = fromNanoSec(startTime ?? 0n);
    this.#end = fromNanoSec(endTime ?? startTime ?? 0n);

    const metadataGenerator = this.#reader.readMetadata();
    let metadataIterator = await metadataGenerator.next();
    while (metadataIterator.done !== true) {
      metadata.push({
        name: metadataIterator.value.name,
        metadata: Object.fromEntries(metadataIterator.value.metadata),
      });
      metadataIterator = await metadataGenerator.next();
    }

    return {
      start: this.#start,
      end: this.#end,
      topics: [...topicsByName.values()],
      datatypes,
      profile: this.#reader.header.profile,
      alerts,
      metadata,
      publishersByTopic,
      topicStats,
    };
  }

  public async *messageIterator(
    args: MessageIteratorArgs,
  ): AsyncIterableIterator<Readonly<IteratorResult<Uint8Array>>> {
    const topics = args.topics;
    const start = args.start ?? this.#start;
    const end = args.end ?? this.#end;

    if (topics.size === 0 || !start || !end) {
      return;
    }

    const topicNames = Array.from(topics.keys());

    for await (const message of this.#reader.readMessages({
      startTime: toNanoSec(start),
      endTime: toNanoSec(end),
      topics: topicNames,
      validateCrcs: false,
    })) {
      const channelInfo = this.#channelInfoById.get(message.channelId);
      if (!channelInfo) {
        yield {
          type: "alert",
          connectionId: message.channelId,
          alert: {
            message: `Received message on channel ${message.channelId} without prior channel info`,
            severity: "error",
          },
        };
        continue;
      }
      try {
        yield {
          type: "message-event",
          msgEvent: {
            topic: channelInfo.channel.topic,
            receiveTime: fromNanoSec(message.logTime),
            publishTime: fromNanoSec(message.publishTime),
            message: message.data,
            sizeInBytes: message.data.byteLength,
            schemaName: channelInfo.schemaName ?? "",
          },
        };
      } catch (error) {
        yield {
          type: "alert",
          connectionId: message.channelId,
          alert: {
            message: `Error decoding message on ${channelInfo.channel.topic}`,
            error,
            severity: "error",
          },
        };
      }
    }
  }

  public async getBackfillMessages(
    args: GetBackfillMessagesArgs,
  ): Promise<MessageEvent<Uint8Array>[]> {
    const { topics, time } = args;

    const messages: MessageEvent<Uint8Array>[] = [];
    for (const topic of topics.keys()) {
      // NOTE: An iterator is made for each topic to get the latest message on that topic.
      // An single iterator for all the topics could result in iterating through many
      // irrelevant messages to get to an older message on a topic.
      for await (const message of this.#reader.readMessages({
        endTime: toNanoSec(time),
        topics: [topic],
        reverse: true,
        validateCrcs: false,
      })) {
        const channelInfo = this.#channelInfoById.get(message.channelId);
        if (!channelInfo) {
          log.error(`Missing channel info for channel: ${message.channelId} on topic: ${topic}`);
          continue;
        }

        messages.push({
          topic: channelInfo.channel.topic,
          receiveTime: fromNanoSec(message.logTime),
          publishTime: fromNanoSec(message.publishTime),
          message: message.data,
          sizeInBytes: message.data.byteLength,
          schemaName: channelInfo.schemaName ?? "",
        });

        break;
      }
    }
    messages.sort((a, b) => compare(a.receiveTime, b.receiveTime));
    return messages;
  }

  public getStart(): Time | undefined {
    return this.#start;
  }
}
