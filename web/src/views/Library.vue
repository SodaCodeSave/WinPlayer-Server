<script setup lang="ts">
/**
 * 曲库管理：上传（拖拽/选择）、搜索、按用户筛选、删除。
 *
 * 上传走与客户端完全相同的接口（PUT + 原始字节流），所以两边行为一致；
 * 后台传的歌归属「当前登录的管理员账号」。
 */
import { onMounted, ref } from "vue";
import { api, type AdminUser, type CloudTrack } from "../api";
import { humanBytes, humanDuration, humanTime, toast } from "../toast";

const tracks = ref<CloudTrack[]>([]);
const total = ref(0);
const users = ref<AdminUser[]>([]);
const keyword = ref("");
const userFilter = ref(0);
const loading = ref(false);
const uploading = ref(false);
const progress = ref(0);
const uploadingName = ref("");
const dragging = ref(false);
const page = ref(0);
const PAGE_SIZE = 50;

const ACCEPT = ".mp3,.flac,.m4a,.mp4,.m4b,.aac,.ogg,.oga,.wav";

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.tracks({
      userId: userFilter.value || undefined,
      q: keyword.value.trim() || undefined,
      limit: PAGE_SIZE,
      offset: page.value * PAGE_SIZE,
    });
    tracks.value = result.tracks;
    total.value = result.total;
  } catch (error) {
    toast(error instanceof Error ? error.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadUsers(): Promise<void> {
  try {
    users.value = (await api.users()).users;
  } catch {
    /* 忽略：筛选器不是必需的 */
  }
}

async function upload(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  if (!list.length) return;
  uploading.value = true;
  let ok = 0;
  let duplicated = 0;
  try {
    for (const [index, file] of list.entries()) {
      uploadingName.value = `(${index + 1}/${list.length}) ${file.name}`;
      progress.value = 0;
      try {
        const result = await api.upload(file, (ratio) => {
          progress.value = ratio;
        });
        ok += 1;
        if (result.duplicate) duplicated += 1;
      } catch (error) {
        toast(`${file.name}: ${error instanceof Error ? error.message : "上传失败"}`);
      }
    }
    toast(
      `上传完成：成功 ${ok} 个${duplicated ? `（其中 ${duplicated} 个已存在，未重复占用空间）` : ""}`,
    );
    page.value = 0;
    await load();
  } finally {
    uploading.value = false;
    uploadingName.value = "";
    progress.value = 0;
  }
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  if (event.dataTransfer?.files?.length) void upload(event.dataTransfer.files);
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) void upload(input.files);
  input.value = "";
}

async function remove(track: CloudTrack): Promise<void> {
  if (!track.userId) return;
  if (!confirm(`从「${track.username}」的曲库删除《${track.title}》？（进回收站，可恢复）`)) return;
  try {
    await api.deleteTrack(track.userId, track.hash);
    toast("已移入回收站");
    await load();
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除失败");
  }
}

function search(): void {
  page.value = 0;
  void load();
}

function flip(delta: number): void {
  const next = page.value + delta;
  if (next < 0 || next * PAGE_SIZE >= total.value) return;
  page.value = next;
  void load();
}

onMounted(async () => {
  await Promise.all([load(), loadUsers()]);
});
</script>

<template>
  <div class="page-head">
    <h2>曲库</h2>
    <span class="spacer" />
    <button :disabled="loading" @click="load">刷新</button>
  </div>

  <div class="card">
    <h3>上传</h3>
    <label
      class="dropzone"
      :class="{ over: dragging }"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input type="file" multiple :accept="ACCEPT" style="display: none" @change="onPick" />
      把音频文件拖到这里，或点击选择（支持 mp3 / flac / m4a / aac / ogg / wav）
      <div v-if="uploading" class="progress"><i :style="{ width: `${progress * 100}%` }" /></div>
      <div v-if="uploading" style="font-size: 12px; margin-top: 6px">{{ uploadingName }}</div>
    </label>
    <p class="muted" style="font-size: 12px; margin: 10px 0 0">
      传上来的歌归属当前登录的管理员账号。文件按内容哈希去重，重复上传不会重复占空间。
    </p>
  </div>

  <div class="card" style="padding: 0; overflow: hidden">
    <div class="toolbar" style="padding: 14px 16px; margin: 0">
      <input
        v-model="keyword"
        placeholder="搜索歌名 / 歌手 / 专辑"
        style="width: 220px"
        @keyup.enter="search"
      />
      <select v-model.number="userFilter" style="width: 150px" @change="search">
        <option :value="0">全部账号</option>
        <option v-for="user in users" :key="user.id" :value="user.id">{{ user.username }}</option>
      </select>
      <button @click="search">搜索</button>
      <span class="spacer" style="flex: 1" />
      <span class="muted" style="font-size: 12px">共 {{ total }} 首</span>
    </div>

    <table>
      <thead>
        <tr>
          <th>曲目</th>
          <th style="width: 150px">专辑</th>
          <th style="width: 70px">时长</th>
          <th style="width: 80px">大小</th>
          <th style="width: 120px">账号</th>
          <th style="width: 130px">上传时间</th>
          <th style="width: 70px" />
        </tr>
      </thead>
      <tbody>
        <tr v-if="loading">
          <td colspan="7" class="empty">加载中…</td>
        </tr>
        <tr v-for="track in tracks" v-else :key="`${track.userId}-${track.hash}`">
          <td>
            <div style="font-weight: 500">{{ track.title }}</div>
            <div class="muted" style="font-size: 12px">
              {{ track.artist || "未知歌手" }} · {{ track.ext.toUpperCase() }}
              <span v-if="track.hasLyrics"> · 有歌词</span>
            </div>
          </td>
          <td class="muted" style="font-size: 12px">{{ track.album || "—" }}</td>
          <td class="mono">{{ humanDuration(track.duration) }}</td>
          <td class="mono">{{ humanBytes(track.size) }}</td>
          <td class="muted" style="font-size: 12px">{{ track.username }}</td>
          <td class="muted" style="font-size: 12px">{{ humanTime(track.createdAt) }}</td>
          <td>
            <div class="row-actions">
              <button class="danger" @click="remove(track)">删除</button>
            </div>
          </td>
        </tr>
        <tr v-if="!loading && !tracks.length">
          <td colspan="7" class="empty">没有曲目</td>
        </tr>
      </tbody>
    </table>

    <div class="toolbar" style="padding: 12px 16px; margin: 0; justify-content: flex-end">
      <button :disabled="page === 0 || loading" @click="flip(-1)">上一页</button>
      <span class="muted" style="font-size: 12px">第 {{ page + 1 }} 页</span>
      <button :disabled="(page + 1) * PAGE_SIZE >= total || loading" @click="flip(1)">下一页</button>
    </div>
  </div>
</template>
