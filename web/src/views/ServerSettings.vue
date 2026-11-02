<script setup lang="ts">
/**
 * 服务器设置。开关点一下即生效（不搞「保存」按钮），只是在服务器名这种
 * 需要输入的地方保留显式「保存」，避免每敲一个字就发一次请求。
 */
import { onMounted, ref } from "vue";
import { api } from "../api";
import { humanBytes, toast } from "../toast";

const props = defineProps<{ serverName: string }>();
const emit = defineEmits<{ (event: "refresh-me"): void }>();

const name = ref(props.serverName);
const registrationOpen = ref(false);
const inviteRequired = ref(false);
const quotaBytes = ref(0);
const maxUploadBytes = ref(0);
const loading = ref(true);
const savingName = ref(false);
const busy = ref("");

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.settings();
    name.value = data.serverName;
    registrationOpen.value = data.registrationOpen;
    inviteRequired.value = data.inviteRequired;
    quotaBytes.value = data.quotaBytes;
    maxUploadBytes.value = data.maxUploadBytes;
  } catch (error) {
    toast(error instanceof Error ? error.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

async function toggle(key: "registrationOpen" | "inviteRequired", value: boolean): Promise<void> {
  const previous = key === "registrationOpen" ? !value : !value;
  busy.value = key;
  if (key === "registrationOpen") registrationOpen.value = value;
  else inviteRequired.value = value;
  try {
    await api.saveSettings({ [key]: value });
    toast(value ? "已开启" : "已关闭");
  } catch (error) {
    if (key === "registrationOpen") registrationOpen.value = previous;
    else inviteRequired.value = previous;
    toast(error instanceof Error ? error.message : "保存失败");
  } finally {
    busy.value = "";
  }
}

async function saveName(): Promise<void> {
  const value = name.value.trim();
  if (!value) {
    toast("服务器名不能为空");
    return;
  }
  savingName.value = true;
  try {
    await api.saveSettings({ serverName: value });
    toast("已保存，客户端下次连接时生效");
    emit("refresh-me");
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败");
  } finally {
    savingName.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page-head">
    <h2>服务器设置</h2>
    <span class="spacer" />
    <button :disabled="loading" @click="load">刷新</button>
  </div>

  <div class="card">
    <h3>基本信息</h3>
    <div class="settings-row">
      <div class="info">
        <strong>服务器名称</strong>
        <span>客户端登录页会显示这个名字，用来区分多个服务器</span>
      </div>
      <input v-model="name" style="width: 220px" />
      <button class="primary" :disabled="savingName || name.trim() === serverName" @click="saveName">
        {{ savingName ? "保存中…" : "保存" }}
      </button>
    </div>
  </div>

  <div class="card">
    <h3>注册</h3>
    <div class="settings-row">
      <div class="info">
        <strong>允许自行注册</strong>
        <span>关闭后只能由管理员在「用户」页建号（第一个注册的账号永远是管理员）</span>
      </div>
      <label class="switch">
        <input
          type="checkbox"
          :checked="registrationOpen"
          :disabled="busy === 'registrationOpen'"
          @change="toggle('registrationOpen', ($event.target as HTMLInputElement).checked)"
        />
        <span class="track" />
      </label>
    </div>
    <div class="settings-row">
      <div class="info">
        <strong>注册需要邀请码</strong>
        <span>开启后必须先在「邀请码」页生成，一码一用</span>
      </div>
      <label class="switch">
        <input
          type="checkbox"
          :checked="inviteRequired"
          :disabled="busy === 'inviteRequired' || !registrationOpen"
          @change="toggle('inviteRequired', ($event.target as HTMLInputElement).checked)"
        />
        <span class="track" />
      </label>
    </div>
  </div>

  <div class="card">
    <h3>限制（由环境变量决定，需重启容器）</h3>
    <div class="settings-row">
      <div class="info">
        <strong>单账号容量</strong>
        <span>USER_QUOTA_MB</span>
      </div>
      <span class="mono">{{ quotaBytes ? humanBytes(quotaBytes) : "不限" }}</span>
    </div>
    <div class="settings-row">
      <div class="info">
        <strong>单次上传上限</strong>
        <span>MAX_UPLOAD_MB</span>
      </div>
      <span class="mono">{{ humanBytes(maxUploadBytes) }}</span>
    </div>
  </div>

  <p class="muted" style="font-size: 12px">
    改这些值要在 docker-compose.yml 的 environment 里改，然后
    <span class="mono">docker compose up -d</span> 重建容器（数据卷不受影响）。
  </p>
</template>
