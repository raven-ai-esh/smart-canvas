import { initTelemetry } from '../observability.js';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'smart-tracker-mcp';
await initTelemetry({ serviceName });
await import('./canvas-server.js');
