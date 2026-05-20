import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const sharedDir = resolve(rootDir, "shared");

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },

  alias: {
    "~~/shared": sharedDir,
  },
  nitro: {
    alias: {
      "~~/shared": sharedDir,
    },
  },

  runtimeConfig: {
    ollamaHost: process.env.NUXT_OLLAMA_HOST ?? "http://127.0.0.1:11434",
    ollamaModel: process.env.NUXT_OLLAMA_MODEL ?? "qwen3.5:0.8b",
    /** 事件订阅 Verification Token；不配则不在服务端校验 token */
    feishuVerificationToken: process.env.NUXT_FEISHU_VERIFICATION_TOKEN ?? "",
    /** Encrypt Key；后台开启事件加密时用于解密 `{ encrypt }` */
    feishuEncryptKey: process.env.NUXT_FEISHU_ENCRYPT_KEY ?? "",
  },
  css: ["~/assets/css/tailwind.css"],

  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        "~~/shared": sharedDir,
      },
    },
  },

  modules: ["shadcn-nuxt"],
  shadcn: {
    /**
     * Prefix for all the imported component.
     * @default "Ui"
     */
    prefix: "",
    /**
     * Directory that the component lives in.
     * Will respect the Nuxt aliases.
     * @link https://nuxt.com/docs/api/nuxt-config#alias
     * @default "@/components/ui"
     */
    componentDir: "@/components/ui",
  },
});
