/**
 * 生成媒体字节的云存取客户端。
 *
 * 服务端权威、本地缓存：生成完成后把字节 PUT 到 /api/media（fire-and-
 * forget，失败不打扰用户——本地字节仍在）；读取端在本地缺失时 GET 回填
 * 并写回缓存。未配置 DATABASE_URL 的部署（isBrowserPersistenceEnabled 为
 * 假）整体静默跳过，行为与纯本地时代一致。
 *
 * 身份就是登录会话 cookie（同源请求自动携带）；服务端按 `user:<id>` 分
 * 区并校验 stage 所有权，与课件文档的分区一致——媒体随账号跨浏览器。
 */
import { isBrowserPersistenceEnabled } from '@/lib/persistence/bootstrap';
import { createLogger } from '@/lib/logger';

const log = createLogger('RemoteMedia');

export type RemoteMediaKind = 'media' | 'poster' | 'audio';

/** 本会话已告警过的失败键，避免同一 ref 反复刷日志。 */
const warnedFailures = new Set<string>();

function warnOnce(key: string, message: string, error?: unknown): void {
  if (warnedFailures.has(key)) return;
  warnedFailures.add(key);
  log.warn(message, error ?? '');
}

/** 本次会话媒体云存取是否可用（未配置服务端持久化时为假）。 */
export function isMediaServerBacked(): boolean {
  return isBrowserPersistenceEnabled();
}

/**
 * 上传一条媒体字节。调用方 fire-and-forget（`void uploadRemoteMedia(...)`）：
 * 上传失败不影响生成结果——本地字节仍在，服务端缺失只影响其他浏览器的
 * 回填，且下一次成功生成/重试会重写。
 */
export async function uploadRemoteMedia(input: {
  stageId: string;
  ref: string;
  kind: RemoteMediaKind;
  blob: Blob;
}): Promise<void> {
  if (!isMediaServerBacked()) return;
  // Blob 为空（如 CDN 路径的占位行）没有可上传的字节。
  if (!input.blob || input.blob.size === 0) return;
  try {
    const response = await fetch(
      `/api/media/${encodeURIComponent(input.ref)}?kind=${input.kind}&stageId=${encodeURIComponent(input.stageId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': input.blob.type || 'application/octet-stream' },
        body: input.blob,
      },
    );
    if (!response.ok) {
      warnOnce(
        `${input.stageId}:${input.ref}:${input.kind}:put:${response.status}`,
        `Uploading media "${input.ref}" (${input.kind}) failed with ${response.status}`,
      );
    }
  } catch (error) {
    warnOnce(`${input.stageId}:${input.ref}:${input.kind}:put:throw`, 'Uploading media failed:', error);
  }
}

/**
 * 按引用取回服务端字节；本地没有的媒体用它在任何一台浏览器上回填。
 * 返回 null 表示服务端也没有（或不可用），调用方保持既有缺字节行为。
 */
export async function fetchRemoteMedia(input: {
  ref: string;
  kind: RemoteMediaKind;
}): Promise<Blob | null> {
  if (!isMediaServerBacked()) return null;
  try {
    const response = await fetch(
      `/api/media/${encodeURIComponent(input.ref)}?kind=${input.kind}`,
      { cache: 'no-store' },
    );
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size > 0 ? blob : null;
  } catch (error) {
    warnOnce(`${input.ref}:${input.kind}:get`, 'Fetching remote media failed:', error);
    return null;
  }
}

/** 课件删除 / 资源回收时清掉它在服务端的全部媒体字节。best-effort。 */
export function deleteRemoteMediaForStage(stageId: string): void {
  if (!isMediaServerBacked()) return;
  void fetch(`/api/media?stageId=${encodeURIComponent(stageId)}`, { method: 'DELETE' }).catch(
    (error) => {
      warnOnce(`${stageId}:delete-stage`, 'Deleting remote media for stage failed:', error);
    },
  );
}
