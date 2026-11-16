import { stringify } from "yaml";

const UPSTREAM_URL = "https://api.applecross.me/api/service/all";
const MIN_PATH_LENGTH = 44;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9]{44,}$/;
const MONOQUERY_TIMEOUT_MS = 3000;
const MONOQUERY_CONCURRENCY = 6;
const MIN_DNS_TTL_SECONDS = 60;
const MAX_DNS_TTL_SECONDS = 3600;
const MAX_CACHE_ENTRIES = 512;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// hostname -> { ip, expiresAt }，只存在于当前 isolate 内
const dnsCache = new Map();

class WorkerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    try {
      validateEnv(env);

      const actualPath = new URL(request.url).pathname.slice(1);
      if (actualPath !== env.PATH) {
        throw new WorkerError("Not found", 404);
      }

      const res = await fetch(UPSTREAM_URL, {
        method: "GET",
        headers: {
          "Accept": "*/*",
          "Accept-Language": "zh-Hans-CN;q=1, zh-Hant-CN;q=0.9, en-CN;q=0.8, ja-CN;q=0.7",
          "Authorization": `Bearer ${env.MONOPROXY_TOKEN}`,
          "User-Agent": "MonoProxy/1.3.3 (iPhone; iOS 18.7.2; Scale/3.00)",
        },
      });
      if (!res.ok) {
        throw new WorkerError(`Upstream request failed with ${res.status}`, 502);
      }

      const json = await res.json();
      const yaml = await convert(json, env);

      return new Response(yaml, {
        headers: {
          "Content-Type": "text/yaml; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      if (error instanceof WorkerError) {
        return new Response(`${error.message}`, {
          status: error.status,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      return new Response("Internal server error", {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
  },
};

function validateEnv(env) {
  if (typeof env?.MONOPROXY_TOKEN !== "string" || env.MONOPROXY_TOKEN === "") {
    throw new WorkerError("MONOPROXY_TOKEN is required", 500);
  }

  if (typeof env?.PATH !== "string") {
    throw new WorkerError("PATH is required", 500);
  }

  if (!SAFE_PATH_PATTERN.test(env.PATH)) {
    throw new WorkerError(`PATH must be at least ${MIN_PATH_LENGTH} alphanumeric characters`, 500);
  }
}

async function convert(services, env) {
  // 1. 过滤并解析服务器节点
  const servers = services
    .flatMap((service) => service.servers || []) // 防空处理，对齐 Python 的 .get("servers", [])
    .filter((server) => server.enable === 1 && server.hide !== 1)
    .map((server) => ({
      // 去除 (MP)，对齐 Python 的字符串拼接
      name: `${server.emoji || ''} ${server.alias || ''}`,
      server: server.hostname,
      // 使用 || 对齐 Python 的 or 逻辑（处理 falsy 值），并提供 0 作为兜底
      port: Number(server.server_port || server.port || 0),
      type: "ss",
      cipher: server.encryption,
      password: server.password,
      udp: true,
    }));

  // 2. 通过 monoquery 把 server.hostname 解析成 IP，解析失败时保留原域名
  await resolveServerHostnames(servers, env);

  // 3. 提取所有节点名称
  const names = servers.map((s) => s.name);

  // 4. 构建策略组 (proxy-groups)
  const groups = [
    { name: "Proxy", type: "select", proxies: names },
    { name: "MATCH", type: "select", proxies: ["Proxy", "DIRECT"] },
    { name: "AI", type: "select", proxies: ["Proxy"] },
    { name: "Streaming", type: "select", proxies: ["Proxy", ...names] },   // 使用 ... 对齐 Python 的 * 展开
    { name: "StreamingSE", type: "select", proxies: ["DIRECT", ...names] }, // 使用 ... 对齐 Python 的 * 展开
  ];

  // 5. 获取并解析 rules 环境变量
  const rawRules = env?.RULES || (typeof env !== 'undefined' ? env.RULES : '');

  // 6. 统一输出结构
  const baseConfigYaml = stringify({
    proxies: servers,
    "proxy-groups": groups,
  });

  // 自带 rules 头部，直接换行拼接
  return `${baseConfigYaml}\n\n${rawRules}`;
}

async function resolveServerHostnames(servers, env) {
  const endpoint = typeof env?.MONOQUERY_URL === "string" ? env.MONOQUERY_URL.trim() : "";
  if (endpoint === "") {
    return;
  }

  const hostnames = [...new Set(servers.map((server) => server.server))].filter(
    isResolvableHostname,
  );
  if (hostnames.length === 0) {
    return;
  }

  // 同名节点只查询一次，并限制并发（Workers 同时打开的连接数有限）
  const ips = await mapWithConcurrency(hostnames, MONOQUERY_CONCURRENCY, (hostname) =>
    lookupHostname(hostname, endpoint),
  );
  const ipByHostname = new Map(hostnames.map((hostname, index) => [hostname, ips[index]]));

  for (const server of servers) {
    const ip = ipByHostname.get(server.server);
    if (ip) {
      server.server = ip;
    }
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function lookupHostname(hostname, endpoint) {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.ip;
  }

  try {
    const answer = await queryDns(hostname, endpoint);
    if (answer) {
      if (dnsCache.size >= MAX_CACHE_ENTRIES) {
        dnsCache.clear();
      }
      dnsCache.set(hostname, {
        ip: answer.ip,
        expiresAt: Date.now() + answer.ttl * 1000,
      });
      return answer.ip;
    }
  } catch (error) {
    console.warn(`[monoquery] failed to resolve ${hostname}: ${error.message}`);
  }

  return null;
}

async function queryDns(hostname, endpoint) {
  const url = new URL(endpoint);
  url.searchParams.set("dns", encodeDnsQuery(hostname));

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/dns-message" },
    signal: AbortSignal.timeout(MONOQUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return parseDnsAnswer(new Uint8Array(await response.arrayBuffer()));
}

// 构造 A 记录的 DNS 查询报文（QDCOUNT = 1），再按 base64url 编码
function encodeDnsQuery(hostname) {
  const encoder = new TextEncoder();
  const labels = hostname.replace(/\.$/, "").split(".").map((label) => encoder.encode(label));
  const size = 12 + labels.reduce((total, label) => total + label.length + 1, 0) + 5;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);

  view.setUint16(0, 0); // ID
  view.setUint16(2, 0x0100); // 标准查询，期望递归
  view.setUint16(4, 1); // QDCOUNT

  let offset = 12;
  for (const label of labels) {
    bytes[offset] = label.length;
    bytes.set(label, offset + 1);
    offset += label.length + 1;
  }
  bytes[offset] = 0; // QNAME 结束
  view.setUint16(offset + 1, 1); // QTYPE A
  view.setUint16(offset + 3, 1); // QCLASS IN

  return toBase64Url(bytes);
}

function parseDnsAnswer(message) {
  if (message.length < 12) {
    return null;
  }

  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  if ((view.getUint16(2) & 0x000f) !== 0) {
    return null; // RCODE 非 0
  }

  let offset = 12;
  const questionCount = view.getUint16(4);
  for (let i = 0; i < questionCount; i += 1) {
    offset = skipDnsName(message, offset);
    if (offset < 0 || offset + 4 > message.length) {
      return null;
    }
    offset += 4;
  }

  const answerCount = view.getUint16(6);
  for (let i = 0; i < answerCount; i += 1) {
    offset = skipDnsName(message, offset);
    if (offset < 0 || offset + 10 > message.length) {
      return null;
    }

    const type = view.getUint16(offset);
    const klass = view.getUint16(offset + 2);
    const ttl = view.getUint32(offset + 4);
    const length = view.getUint16(offset + 8);
    offset += 10;
    if (offset + length > message.length) {
      return null;
    }

    if (type === 1 && klass === 1 && length === 4) {
      return {
        ip: `${message[offset]}.${message[offset + 1]}.${message[offset + 2]}.${message[offset + 3]}`,
        ttl: Math.min(Math.max(ttl, MIN_DNS_TTL_SECONDS), MAX_DNS_TTL_SECONDS),
      };
    }
    offset += length;
  }

  return null;
}

// 返回名字之后的下一个字节位置；压缩指针只占 2 字节，不需要跟随
function skipDnsName(message, offset) {
  while (offset < message.length) {
    const length = message[offset];
    if (length === 0) {
      return offset + 1;
    }
    if ((length & 0xc0) === 0xc0) {
      return offset + 2 <= message.length ? offset + 2 : -1;
    }
    if ((length & 0xc0) !== 0) {
      return -1;
    }
    offset += length + 1;
  }

  return -1;
}

function isResolvableHostname(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 253 &&
    !IPV4_PATTERN.test(value) &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
