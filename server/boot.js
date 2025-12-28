import { initTelemetry } from './observability.js';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'smart-tracker-api';
await initTelemetry({ serviceName });
await import('./index.js');
