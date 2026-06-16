import { stringify } from "yaml";

const UPSTREAM_URL = "https://api.applecross.me/api/service/all";
const MIN_PATH_LENGTH = 44;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9]{44,}$/;

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
      const yaml = convert(json, env);

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

function parseRules(rulesSrc) {
  if (!rulesSrc) return [];

  // 1. 如果已经是数组，直接返回（最理想的状况）
  if (Array.isArray(rulesSrc)) {
    return rulesSrc;
  }

  // 2. 如果是未解析的 YAML 纯文本字符串，将其解析为数组
  if (typeof rulesSrc === 'string' && rulesSrc.trim()) {
    try {
      const parsed = parse(rulesSrc);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error("parseRules 解析 YAML 字符串失败:", e);
      return [];
    }
  }

  return [];
}

function convert(services, env) {
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

  // 2. 提取所有节点名称
  const names = servers.map((s) => s.name);

  // 3. 构建策略组 (proxy-groups)
  const groups = [
    { name: "Proxy", type: "select", proxies: names },
    { name: "MATCH", type: "select", proxies: ["Proxy", "DIRECT"] },
    { name: "AI", type: "select", proxies: ["Proxy"] },
    { name: "Streaming", type: "select", proxies: ["Proxy", ...names] },   // 使用 ... 对齐 Python 的 * 展开
    { name: "StreamingSE", type: "select", proxies: ["DIRECT", ...names] }, // 使用 ... 对齐 Python 的 * 展开
  ];

  // 4. 获取并解析 rules 环境变量
  const rawRules = env?.RULES || (typeof env !== 'undefined' ? env.RULES : '');
  const rules = parseRules(rawRules);

  // 5. 统一输出结构
  return stringify({ 
    proxies: servers, 
    "proxy-groups": groups,
    rules: rules 
  });
}
