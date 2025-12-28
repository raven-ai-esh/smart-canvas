import { randomUUID } from 'crypto';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { context, diag, DiagConsoleLogger, DiagLogLevel, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const LOG_TRACE = process.env.LOG_TRACE === 'true';
const METRICS_ENABLED = process.env.METRICS_ENABLED !== 'false';
const METRICS_PATH = process.env.METRICS_PATH ?? '/metrics';
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
const OTEL_LOG_LEVEL = process.env.OTEL_LOG_LEVEL ?? '';

let telemetryStarted = false;

const getTraceFields = () => {
  const span = trace.getSpan(context.active());
  const spanContext = span?.spanContext();
  if (!spanContext || !spanContext.traceId) return {};
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
  };
};

export const getLogger = (serviceName) => (
  pino({
    level: LOG_LEVEL,
    base: {
      service: serviceName,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: () => (LOG_TRACE ? getTraceFields() : {}),
  })
);

export const createHttpLogger = ({ logger, ignorePaths = [] }) => {
  const middleware = pinoHttp({
    logger,
    genReqId: (req) => {
      const header = req.headers['x-request-id'] || req.headers['x-correlation-id'];
      if (typeof header === 'string' && header.trim()) return header.trim();
      if (Array.isArray(header) && header[0]) return String(header[0]).trim();
      return randomUUID();
    },
    autoLogging: {
      ignore: (req) => ignorePaths.includes(req.url || ''),
    },
    customProps: () => getTraceFields(),
  });

  return (req, res, next) => {
    middleware(req, res, next);
    if (!res.headersSent && req.id) {
      res.setHeader('x-request-id', req.id);
    }
  };
};

export const createMetrics = ({ serviceName }) => {
  if (!METRICS_ENABLED) {
  return {
    enabled: false,
    path: METRICS_PATH,
    handler: (_req, res) => res.status(404).send('metrics_disabled'),
    middleware: (_req, _res, next) => next(),
    wsConnections: null,
    registry: null,
  };
  }

  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry });

  const requestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const requestTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  const wsConnections = new Gauge({
    name: 'ws_connections',
    help: 'Active WebSocket connections',
    registers: [registry],
  });

  const resolveRoute = (req) => {
    if (req.route?.path) {
      const routePath = typeof req.route.path === 'string' ? req.route.path : String(req.route.path);
      return `${req.baseUrl || ''}${routePath}`;
    }
    if (req.baseUrl) return req.baseUrl;
    return 'unmatched';
  };

  const middleware = (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationNs = Number(process.hrtime.bigint() - start);
      const duration = durationNs / 1e9;
      const route = resolveRoute(req);
      const labels = {
        method: req.method,
        route,
        status_code: String(res.statusCode),
      };
      requestTotal.inc(labels);
      requestDuration.observe(labels, duration);
    });
    next();
  };

  const handler = async (_req, res) => {
    res.setHeader('content-type', registry.contentType);
    res.end(await registry.metrics());
  };

  return {
    enabled: true,
    path: METRICS_PATH,
    handler,
    middleware,
    wsConnections,
    registry,
  };
};

export const initTelemetry = async ({ serviceName }) => {
  if (telemetryStarted || !OTEL_ENDPOINT) return false;
  telemetryStarted = true;

  if (OTEL_LOG_LEVEL) {
    const level = OTEL_LOG_LEVEL.toUpperCase();
    const diagLevel = DiagLogLevel[level] ?? DiagLogLevel.ERROR;
    diag.setLogger(new DiagConsoleLogger(), diagLevel);
  }

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
  });

  const exporter = new OTLPTraceExporter({ url: OTEL_ENDPOINT });
  const sdk = new NodeSDK({
    traceExporter: exporter,
    resource,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  await sdk.start();
  process.on('SIGTERM', () => {
    sdk.shutdown().catch(() => {});
  });
  return true;
};
