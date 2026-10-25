import type { RequestHandler } from "express";

export const redirectRetiredPublicHost: RequestHandler = (req, res, next) => {
  const hostname = req.hostname.toLowerCase();
  if (hostname !== "leaderbot.live" && hostname !== "www.leaderbot.live") {
    next();
    return;
  }

  let originalPath = "/";
  try {
    const parsedUrl = new URL(req.originalUrl, "https://app.leaderbot.live");
    originalPath = `${parsedUrl.pathname}${parsedUrl.search}`;
  } catch {
    originalPath = "/";
  }

  res.redirect(308, `https://app.leaderbot.live${originalPath}`);
};
