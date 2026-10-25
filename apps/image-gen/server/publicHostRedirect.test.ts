import express from "express";
import { createServer, request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redirectRetiredPublicHost } from "./_core/publicHostRedirect";

let server: Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(redirectRetiredPublicHost);
  app.use((_req, res) => res.sendStatus(204));
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
});

function get(host: string, path: string) {
  return new Promise<{
    status: number | undefined;
    location: string | undefined;
  }>((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, headers: { host } },
      res => {
        res.resume();
        res.on("end", () =>
          resolve({ status: res.statusCode, location: res.headers.location })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("retired public host redirect", () => {
  it.each(["leaderbot.live", "www.leaderbot.live", "LEADERBOT.LIVE:443"])(
    "preserves the path and query on %s",
    async host => {
      const path = "/privacy?lang=nl&return=%2Fcredits%2Fcheckout";
      expect(await get(host, path)).toEqual({
        status: 308,
        location: `https://app.leaderbot.live${path}`,
      });
    }
  );

  it("redirects the homepage", async () => {
    expect(await get("leaderbot.live", "/")).toEqual({
      status: 308,
      location: "https://app.leaderbot.live/",
    });
  });

  it("keeps a URL-looking path on the trusted destination host", async () => {
    expect(await get("leaderbot.live", "//external.example/path?x=1")).toEqual({
      status: 308,
      location: "https://app.leaderbot.live//external.example/path?x=1",
    });
  });

  it("does not accept an authority from an absolute request target", async () => {
    expect(
      await get("leaderbot.live", "https://external.example/path")
    ).toEqual({
      status: 308,
      location: "https://app.leaderbot.live/",
    });
  });

  it.each(["app.leaderbot.live", "webhook.leaderbot.live", "example.com"])(
    "leaves requests for %s to the application",
    async host => {
      expect(await get(host, "/privacy?lang=nl")).toEqual({
        status: 204,
        location: undefined,
      });
    }
  );
});
