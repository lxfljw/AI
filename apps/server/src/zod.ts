import { z } from "zod";
import { createAgent, HumanMessage } from "langchain";
import { ChatOllama } from "@langchain/ollama";

const UserSchema = z
  .object({
    name: z.string().describe("弟弟的用户名"),
    age: z.number().describe("弟弟今年的年龄"),
    email: z.string().email().describe("弟弟的邮箱"),
  })
  .describe("用户");

// console.log(UserSchema);

const llm = new ChatOllama({
  model: "qwen3.5:0.8b",
});

const agent = createAgent({
  model: llm,
  responseFormat: UserSchema,
});
console.log("开始执行agent");
agent
  .invoke({
    messages: [
      new HumanMessage(
        "你好，我的名字是张三， 我的弟弟叫张五， 他三年后的年龄是20，我的邮箱是zhangsan@example.com，他的邮箱是zhangwu@example.com",
      ),
    ],
  })
  .then((res) => {
    console.log("执行结果", res.structuredResponse);
  });
