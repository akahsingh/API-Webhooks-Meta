'use strict';

const { createApp } = require('./app');
const { loadConfig, describeConfig } = require('./config');

const config = loadConfig();
const { app, logger, dedupe, closeDashboardStreams } = createApp({ config });
const overview = describeConfig(config);

logger.info('Starting Meta webhooks server', {
  graphVersion: config.graphVersion,
  host: config.host,
  port: config.port,
  signatureVerification: config.appSecret ? 'enforced' : 'disabled',
  dedupeTtlMs: config.dedupeTtlMs,
  includeMessageContent: config.includeMessageContent,
  dashboard: config.dashboardToken ? 'protected' : 'public (set DASHBOARD_TOKEN)',
});

for (const warning of overview.warnings) {
  logger.warn(warning);
}

for (const product of overview.products) {
  logger.info('Callback endpoint ready', {
    product: product.product,
    label: product.label,
    object: product.object,
    callbackUrl: product.callbackUrl || '(set PUBLIC_BASE_URL to print the public URL)',
    localPath: product.callbackPath,
    configureAt: product.dashboardLocation,
    verifyTokenConfigured: product.verifyTokenConfigured,
  });
}

logger.info('Live dashboard ready', {
  path: '/dashboard',
  stream: '/dashboard/stream',
  recent: '/dashboard/recent',
});

const server = app.listen(config.port, config.host, () => {
  const lines = [
    '',
    'Meta webhooks server listening',
    `  Local:  http://localhost:${config.port}`,
  ];

  if (config.publicBaseUrl) lines.push(`  Public: ${config.publicBaseUrl}`);

  lines.push('', 'Paste these into the Meta App Dashboard (Callback URL + Verify token):');
  for (const product of overview.products) {
    lines.push(
      `  ${product.label.padEnd(32)} ${product.callbackUrl || product.callbackPath}`
    );
    lines.push(`  ${''.padEnd(32)} at ${product.dashboardLocation}`);
  }

  lines.push(
    '',
    `Health check: http://localhost:${config.port}/health`,
    `Live dashboard: http://localhost:${config.port}/dashboard${
      config.dashboardToken ? '?token=<DASHBOARD_TOKEN>' : ''
    }`,
    ''
  );
  console.log(lines.join('\n'));
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${config.port} is already in use`, {
      hint: 'Stop the process using it or change PORT in .env.',
    });
  } else {
    logger.error('Server failed to start', { error: error.message });
  }
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down`, { dedupeEntries: dedupe.size });

  try {
    if (typeof closeDashboardStreams === 'function') closeDashboardStreams();
  } catch {
    // Best effort: closing SSE streams must never block shutdown.
  }

  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });

  // Never hang on lingering keep-alive connections.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error: reason && reason.message ? reason.message : String(reason),
  });
});