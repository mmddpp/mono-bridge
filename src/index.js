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
          Accept: "*/*",
          "Accept-Language": "zh-Hans-CN;q=1, zh-Hant-CN;q=0.9, en-CN;q=0.8, ja-CN;q=0.7",
          Authorization: `Bearer ${env.MONOPROXY_TOKEN}`,
          "User-Agent": "MonoProxy/1.3.3 (iPhone; iOS 18.7.2; Scale/3.00)",
        },
      });
      if (!res.ok) {
        throw new WorkerError(`Upstream request failed with ${res.status}`, 502);
      }

      const json = await res.json();
      const yaml = convert(json);

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

function convert(services) {
  const servers = services
    .flatMap((service) => service.servers)
    .filter((server) => server.enable === 1 && server.hide !== 1)
    .map((server) => ({
      name: `${server.emoji} ${server.alias} (MP)`,
      server: server.hostname,
      port: Number(server.server_port ?? server.port),
      type: "ss",
      cipher: server.encryption,
      password: server.password,
      udp: true,
    }));

  return stringify({ proxies: servers });
}
