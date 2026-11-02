import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/** 后台 UI 构建配置：产物落在 web/dist，由服务端静态托管到 /admin/ */
export default defineConfig({
  root: "web",
  base: "/admin/",
  plugins: [vue()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: process.env.API_TARGET ?? "http://127.0.0.1:3456",
        changeOrigin: true,
      },
    },
  },
});
