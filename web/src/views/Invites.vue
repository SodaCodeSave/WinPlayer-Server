<script setup lang="ts">
/** 邀请码：批量生成、复制、作废（一码一用） */
import { onMounted, ref } from "vue";
import { api, type Invite } from "../api";
import { humanTime, toast } from "../toast";

const invites = ref<Invite[]>([]);
const count = ref(1);
const loading = ref(true);
const generating = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    invites.value = (await api.invites()).invites;
  } catch (error) {
    toast(error instanceof Error ? error.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

async function generate(): Promise<void> {
  generating.value = true;
  try {
    const result = await api.createInvites(count.value);
    toast(`生成了 ${result.created.length} 个邀请码`);
    await load();
  } catch (error) {
    toast(error instanceof Error ? error.message : "生成失败");
  } finally {
    generating.value = false;
  }
}

async function copy(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    toast(`已复制 ${code}`);
  } catch {
    toast(code);
  }
}

async function remove(code: string): Promise<void> {
  if (!confirm(`作废邀请码 ${code}？`)) return;
  try {
    await api.deleteInvite(code);
    await load();
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除失败");
  }
}

onMounted(load);
</script>

<template>
  <div class="page-head">
    <h2>邀请码</h2>
    <span class="spacer" />
    <button :disabled="loading" @click="load">刷新</button>
  </div>

  <div class="card">
    <h3>生成</h3>
    <div class="toolbar">
      <input v-model.number="count" type="number" min="1" max="20" style="width: 90px" />
      <button class="primary" :disabled="generating" @click="generate">
        {{ generating ? "生成中…" : "生成邀请码" }}
      </button>
      <span class="muted" style="font-size: 12px">
        只有在「服务器设置」里打开「注册需要邀请码」时才会被要求
      </span>
    </div>
  </div>

  <div class="card" style="padding: 0; overflow: hidden">
    <table>
      <thead>
        <tr>
          <th style="width: 200px">邀请码</th>
          <th>状态</th>
          <th style="width: 160px">生成时间</th>
          <th style="width: 160px">使用时间</th>
          <th style="width: 90px" />
        </tr>
      </thead>
      <tbody>
        <tr v-if="loading">
          <td colspan="5" class="empty">加载中…</td>
        </tr>
        <tr v-for="invite in invites" v-else :key="invite.code">
          <td class="mono" style="cursor: pointer" @click="copy(invite.code)">{{ invite.code }}</td>
          <td>
            <span class="tag" :class="invite.usedBy ? 'gray' : 'ok'">
              {{ invite.usedBy ? `已被 ${invite.usedBy} 使用` : "未使用" }}
            </span>
          </td>
          <td class="muted" style="font-size: 12px">{{ humanTime(invite.createdAt) }}</td>
          <td class="muted" style="font-size: 12px">{{ humanTime(invite.usedAt) }}</td>
          <td>
            <div class="row-actions">
              <button class="danger" @click="remove(invite.code)">作废</button>
            </div>
          </td>
        </tr>
        <tr v-if="!loading && !invites.length">
          <td colspan="5" class="empty">还没有邀请码</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
