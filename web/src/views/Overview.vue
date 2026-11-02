<script setup lang="ts">
/** 概览：容量、用户与曲目统计 + 维护操作 */
import { onMounted, ref } from "vue";
import { api, type Overview } from "../api";
import { humanBytes, humanTime, toast } from "../toast";

const data = ref<Overview | null>(null);
const loading = ref(true);
const busy = ref("");

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await api.overview();
  } catch (error) {
    toast(error instanceof Error ? error.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

async function run(key: string, action: () => Promise<string>): Promise<void> {
  busy.value = key;
  try {
    toast(await action());
    await load();
  } catch (error) {
    toast(error instanceof Error ? error.message : "操作失败");
  } finally {
    busy.value = "";
  }
}

onMounted(load);
</script>

<template>
  <div class="page-head">
    <h2>概览</h2>
    <span class="spacer" />
    <button :disabled="loading" @click="load">刷新</button>
  </div>

  <div v-if="loading && !data" class="card empty">加载中…</div>

  <template v-else-if="data">
    <div class="stat-grid">
      <div class="stat">
        <div class="label">账号</div>
        <div class="value">{{ data.users }}</div>
        <div class="sub">{{ data.disabledUsers }} 个已停用</div>
      </div>
      <div class="stat">
        <div class="label">曲目</div>
        <div class="value">{{ data.tracks }}</div>
        <div class="sub">回收站 {{ data.trashCount }} 首</div>
      </div>
      <div class="stat">
        <div class="label">曲库占用</div>
        <div class="value">{{ humanBytes(data.libraryBytes) }}</div>
        <div class="sub">数据目录共 {{ humanBytes(data.diskBytes) }}</div>
      </div>
      <div class="stat">
        <div class="label">同步游标</div>
        <div class="value mono">{{ data.cursor }}</div>
        <div class="sub">客户端按它拉增量</div>
      </div>
    </div>

    <div class="card">
      <h3>注册与访问</h3>
      <div class="settings-row">
        <div class="info">
          <strong>自行注册</strong>
          <span>关闭时只能由管理员在「用户」页建号</span>
        </div>
        <span class="tag" :class="data.registrationOpen ? 'ok' : 'gray'">
          {{ data.registrationOpen ? "已开放" : "已关闭" }}
        </span>
      </div>
      <div class="settings-row">
        <div class="info">
          <strong>注册需要邀请码</strong>
          <span>在「邀请码」页生成，一码一用</span>
        </div>
        <span class="tag" :class="data.inviteRequired ? 'warn' : 'gray'">
          {{ data.inviteRequired ? "需要" : "不需要" }}
        </span>
      </div>
      <div class="settings-row">
        <div class="info">
          <strong>单账号容量</strong>
          <span>由环境变量 USER_QUOTA_MB 控制，0 表示不限</span>
        </div>
        <span class="mono">{{ data.quotaBytes ? humanBytes(data.quotaBytes) : "不限" }}</span>
      </div>
    </div>

    <div class="card">
      <h3>维护</h3>
      <div class="settings-row">
        <div class="info">
          <strong>清理未引用文件</strong>
          <span>删掉磁盘上没有曲目行指向的音频与封面（含 tmp 残渣）</span>
        </div>
        <button
          :disabled="busy === 'gc'"
          @click="run('gc', async () => {
            const result = await api.gc();
            return `已清理 ${result.removed} 个文件，释放 ${humanBytes(result.freedBytes)}`;
          })"
        >
          {{ busy === "gc" ? "清理中…" : "执行" }}
        </button>
      </div>
      <div class="settings-row">
        <div class="info">
          <strong>清空回收站</strong>
          <span>彻底删除所有用户回收站里的记录，文件随后由上一项回收</span>
        </div>
        <button
          class="danger"
          :disabled="busy === 'trash' || !data.trashCount"
          @click="run('trash', async () => {
            if (!confirm(`确定彻底删除 ${data!.trashCount} 首回收站曲目？`)) return '已取消';
            const result = await api.purgeTrash();
            return `已删除 ${result.removed} 条记录`;
          })"
        >
          {{ busy === "trash" ? "处理中…" : "清空" }}
        </button>
      </div>
      <div class="settings-row">
        <div class="info">
          <strong>数据库检查点</strong>
          <span>把 WAL 落盘并截断，备份 data 目录前建议点一下</span>
        </div>
        <button
          :disabled="busy === 'ckpt'"
          @click="run('ckpt', async () => {
            const result = await api.checkpoint();
            return `已落盘，数据库 ${humanBytes(result.dbBytes)}`;
          })"
        >
          {{ busy === "ckpt" ? "处理中…" : "执行" }}
        </button>
      </div>
    </div>

    <p class="muted" style="font-size: 12px">
      备份服务器 = 打包整个数据目录（数据库 + music/ + covers/）。更新版本只需替换镜像，
      数据卷不要删。
    </p>
  </template>
</template>
