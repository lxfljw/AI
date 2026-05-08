import { ChatOllama } from "@langchain/ollama";
import { HumanMessage, SystemMessage } from "langchain";

const llm = new ChatOllama({
  model: "qwen3.5:0.8b",
});

llm
  .invoke([
    new SystemMessage("你是一个万能的知识小助手，能根据用户的提问精准回答问题"),
    new HumanMessage("你好，ai agent 的概念是什么？"),
  ])
  .then((res) => {
    console.log(res);
  })
  .catch((err) => {
    console.error(err);
  });
