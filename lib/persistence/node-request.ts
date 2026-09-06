/**
 * 把 Web `Request` 桥接为 `node:http` 的 `IncomingMessage` 形状。
 *
 * `@openmaic/storage/server` 的 HTTP 合约处理器与
 * `authenticatePersistenceRequest` 都以 Node 请求对象为输入；Next.js 路由
 * 手里是 Web Request。此桥只做形状转换：方法、url、headers，body 以
 * Readable 流透传。
 *
 * 注意：`Readable.fromWeb` 会锁定并消费 Web 流——调用方若之后还要
 * `request.json()`，必须传 `withBody: false`（认证只需 headers），或先
 * 读后桥。
 */
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

export interface NodeRequestOptions {
  /** 携带请求体（默认携带）。设为 false 时只透传方法/URL/头。 */
  withBody?: boolean;
}

export function nodeRequest(
  request: Request,
  routePrefix?: string,
  options: NodeRequestOptions = {},
): IncomingMessage {
  const url = new URL(request.url);
  const pathname =
    routePrefix && url.pathname.startsWith(routePrefix)
      ? url.pathname.slice(routePrefix.length) || '/'
      : url.pathname;
  const body =
    options.withBody === false
      ? Readable.from([])
      : request.body
        ? Readable.fromWeb(
            request.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
          )
        : Readable.from([]);
  return Object.assign(body, {
    method: request.method,
    url: `${pathname}${url.search}`,
    headers: Object.fromEntries(request.headers.entries()),
  }) as IncomingMessage;
}
