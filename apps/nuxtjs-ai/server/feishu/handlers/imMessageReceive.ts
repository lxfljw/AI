import type * as Lark from "@larksuiteoapi/node-sdk";
import { replyImMessageReceiveV1 } from "../replyMessage";

/** im.message.receive_v1：收到用户消息 */
export async function onImMessageReceiveV1(
  client: Lark.Client,
  data: unknown,
) {
  await replyImMessageReceiveV1(client, data);
}
