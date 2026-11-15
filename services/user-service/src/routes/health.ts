/**
 * Liveness / readiness endpoint.
 *
 * The exact payload the guide promises on page 14:
 *   { "status": "ok", "service": "user-service", "uptime": 12.4 }
 *
 * It is consumed by three different things, which is why it must stay fast
 * and dependency-free:
 *   - the Dockerfile HEALTHCHECK (`wget -qO- http://localhost:3001/health`)
 *   - the Kubernetes livenessProbe  — "is this process wedged? restart it"
 *   - the Kubernetes readinessProbe — "may this pod receive traffic?"
 *
 * Keep it out of the database. A liveness probe that queries Azure SQL will
 * restart every healthy pod in the cluster during a brief database blip.
 */
import { Router } from "express";
import { config } from "../config";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: config.serviceName,
    uptime: Number(process.uptime().toFixed(1))
  });
});
