<script setup lang="ts">
/** 用户管理：建号、改角色、停用、重置密码、删除 */
import { onMounted, ref } from "vue";
import { api, type AdminUser } from "../api";
import { humanBytes, humanTime, toast } from "../toast";

const users = ref<AdminUser[]>([]);
const loading = ref(true);
const creating = ref(false);
const newName = ref("");
const newPass = ref("");
const newRole = ref<"user" | "admin">("user");
const busyId = ref(0);

async function load(): Promise<void> {
  loading.value = true;
  try {
    users.value = (await api.users()).users;
  } catch (error) {
    toast(error instanceof Error ? error.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  if (!newName.value.trim() || newPass.value.length < 6) {
    toast("用户名不能为空，密码至少 6 位");
    return;
  }
  creating.value = true;
  try {
    await api.createUser(newName.value.trim(), newPass.value, newRole.value);
    toast(`已创建 ${newName.value.trim()}`);
    newName.value = "";
    newPass.value = "";
    newRole.value = "user";
    await load();
  } catch (error) {
    toast(error instanceof Error ? error.message : "创建失败");
  } finally {
    creating.value = false;
  }
}

async function patch(user: AdminUser, body: Record<string, unknown>): Promise<void> {
  busyId.value = user.id;
  try {
    await api.updateUser(user.id, body);
    await load();
  } catch (error) {
    toast(error instanceof Error ? error.message : "操作失败");
  } finally {
    busyId.value = 0;
  }
}

async function resetPassword(user: AdminUser): Promise<void> {
  const next = prompt(`给「${user.username}」设置新密码（至少 6 位）`);
  if (!next) return;
  if (next.length < 6) {
    toast("密码太短");
    return;
  }
  await patch(user, { password: next });
  toast("密码已重置，该账号需重新登录");
}

async function remove(user: AdminUser): Promise<void> {
  if (!confirm(`删除账号「${user.username}」？其曲库与同步数据会一并删除（音频文件由维护任务回收）。`)) {
    return;
  }
  busyId.value = user.id;
  try {
    await api.deleteUser(user.id);
    toast("已删除");
    await load();
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除失败");
  } finally {
    busyId.value = 0;
  }
}

onMounted(load);
</script>

<template>
  <div class="page-head">
    <h2>用户</h2>
    <span class="spacer" />
    <button :disabled="loading" @click="load">刷新</button>
  </div>

  <div class="card">
    <h3>新建账号</h3>
    <div class="toolbar">
      <input v-model="newName" placeholder="用户名" style="width: 160px" />
      <input v-model="newPass" type="password" placeholder="初始密码（≥6 位）" style="width: 190px" />
      <select v-model="newRole" style="width: 120px">
        <option value="user">普通用户</option>
        <option value="admin">管理员</option>
      </select>
      <button class="primary" :disabled="creating" @click="create">
        {{ creating ? "创建中…" : "创建" }}
      </button>
    </div>
  </div>

  <div class="card" style="padding: 0; overflow: hidden">
    <table>
      <thead>
        <tr>
          <th>用户名</th>
          <th style="width: 100px">角色</th>
          <th style="width: 90px">状态</th>
          <th style="width: 90px">曲目</th>
          <th style="width: 110px">占用</th>
          <th style="width: 150px">最近登录</th>
          <th style="width: 230px" />
        </tr>
      </thead>
      <tbody>
        <tr v-if="loading">
          <td colspan="7" class="empty">加载中…</td>
        </tr>
        <tr v-for="user in users" v-else :key="user.id">
          <td>
            {{ user.username }}
            <span v-if="user.id === 1" class="tag gray" style="margin-left: 6px">首位</span>
          </td>
          <td>
            <select
              :value="user.role"
              :disabled="busyId === user.id"
              @change="patch(user, { role: ($event.target as HTMLSelectElement).value })"
            >
              <option value="user">普通</option>
              <option value="admin">管理员</option>
            </select>
          </td>
          <td>
            <span class="tag" :class="user.disabled ? 'warn' : 'ok'" style="cursor: pointer"
              @click="patch(user, { disabled: !user.disabled })">
              {{ user.disabled ? "已停用" : "正常" }}
            </span>
          </td>
          <td class="mono">{{ user.trackCount ?? 0 }}</td>
          <td class="mono">{{ humanBytes(user.usedBytes ?? 0) }}</td>
          <td class="muted" style="font-size: 12px">{{ humanTime(user.lastLoginAt) }}</td>
          <td>
            <div class="row-actions">
              <button :disabled="busyId === user.id" @click="resetPassword(user)">重置密码</button>
              <button class="danger" :disabled="busyId === user.id" @click="remove(user)">删除</button>
            </div>
          </td>
        </tr>
        <tr v-if="!loading && !users.length">
          <td colspan="7" class="empty">还没有用户</td>
        </tr>
      </tbody>
    </table>
  </div>

  <p class="muted" style="font-size: 12px">
    系统会阻止把最后一个可用管理员降级或停用，避免后台被锁死。
  </p>
</template>
