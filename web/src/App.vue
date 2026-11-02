<script setup lang="ts">
/**
 * 后台外壳：登录 → 侧边导航 → 各页面。
 *
 * 不做前端路由（页面切换只是组件切换），少一层依赖，刷新也不会 404。
 */
import { computed, onMounted, ref } from "vue";
import { api, ApiError, session, type AdminUser } from "./api";
import { toast, toastMessage } from "./toast";
import Overview from "./views/Overview.vue";
import Users from "./views/Users.vue";
import Invites from "./views/Invites.vue";
import Library from "./views/Library.vue";
import ServerSettings from "./views/ServerSettings.vue";

const authed = ref(Boolean(session.token));
const me = ref<AdminUser | null>(null);
const serverName = ref("WinPlayer 音乐云");
const tab = ref("overview");

const loginName = ref("");
const loginPass = ref("");
const loginError = ref("");
const loggingIn = ref(false);

const tabs = [
  { key: "overview", label: "概览", component: Overview },
  { key: "users", label: "用户", component: Users },
  { key: "invites", label: "邀请码", component: Invites },
  { key: "library", label: "曲库", component: Library },
  { key: "settings", label: "服务器设置", component: ServerSettings },
];

const current = computed(() => tabs.find((item) => item.key === tab.value) ?? tabs[0]);

async function boot(): Promise<void> {
  if (!authed.value) return;
  try {
    const data = await api.me();
    me.value = data.user;
    serverName.value = data.server.name;
    if (data.user.role !== "admin") {
      loginError.value = "这个账号不是管理员，无法进入后台";
      session.clear();
      authed.value = false;
    }
  } catch {
    session.clear();
    authed.value = false;
  }
}

async function login(): Promise<void> {
  loginError.value = "";
  loggingIn.value = true;
  try {
    const data = await api.login(loginName.value.trim(), loginPass.value);
    session.set(data.token, data.refreshToken);
    authed.value = true;
    loginPass.value = "";
    await boot();
  } catch (error) {
    loginError.value = error instanceof ApiError ? error.message : "登录失败";
  } finally {
    loggingIn.value = false;
  }
}

function logout(): void {
  session.clear();
  authed.value = false;
  me.value = null;
}

onMounted(boot);
</script>

<template>
  <div v-if="!authed" class="login-wrap">
    <form class="login-card" @submit.prevent="login">
      <h1>WinPlayer 音乐云</h1>
      <p class="hint">后台管理 · 用管理员账号登录</p>
      <div class="field">
        <label>用户名</label>
        <input v-model="loginName" autocomplete="username" autofocus />
      </div>
      <div class="field">
        <label>密码</label>
        <input v-model="loginPass" type="password" autocomplete="current-password" />
      </div>
      <p v-if="loginError" style="color: var(--danger); font-size: 13px; margin: 0 0 12px">
        {{ loginError }}
      </p>
      <button class="primary" style="width: 100%" :disabled="loggingIn || !loginName || !loginPass">
        {{ loggingIn ? "登录中…" : "登录" }}
      </button>
      <p class="hint" style="margin: 14px 0 0">
        首次部署时，注册的第一个账号自动成为管理员。
      </p>
    </form>
  </div>

  <div v-else class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span>音乐云</span>
        <small>{{ serverName }}</small>
      </div>
      <button
        v-for="item in tabs"
        :key="item.key"
        class="nav-item"
        :class="{ active: tab === item.key }"
        @click="tab = item.key"
      >
        {{ item.label }}
      </button>
      <div class="footer">
        <span>{{ me?.username }} · {{ me?.role === "admin" ? "管理员" : "用户" }}</span>
        <button class="ghost" style="text-align: left; padding: 4px 0" @click="logout">退出登录</button>
      </div>
    </aside>

    <main class="main">
      <component :is="current.component" :server-name="serverName" @refresh-me="boot" />
    </main>
  </div>

  <div v-if="toastMessage" class="toast">{{ toastMessage }}</div>
</template>
