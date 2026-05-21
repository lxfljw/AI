import type * as Lark from "@larksuiteoapi/node-sdk";
import * as LarkSdk from "@larksuiteoapi/node-sdk";
import { buildFeishuEventHandlers } from "./handlers";

/** 注册飞书长连接事件 */
export function createFeishuEventDispatcher(client: Lark.Client) {
  return new LarkSdk.EventDispatcher({}).register(
    buildFeishuEventHandlers(client),
  );
}
