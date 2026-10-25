import type { RequestHandler } from "express";

export const redirectRetiredPublicHost: RequestHandler = (req, res, next) => {
  const hostname = req.hostname.toLowerCase();
  if (hostname !== "leaderbot.live" && hostname !== "www.leaderbot.live") {
    next();
    return;
  }

  const originalPath = req.originalUrl.startsWith("/") ? req.originalUrl : "/";
  res.redirect(308, `https://app.leaderbot.live${originalPath}`);
};
