// Starts the API server (watch mode) and the Vite dev server together; Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npx', ['tsx', 'watch', 'apps/server/src/main.ts'], { stdio: 'inherit', shell: true }),
  spawn('npx', ['vite', 'apps/web', '--config', 'apps/web/vite.config.ts'], {
    stdio: 'inherit',
    shell: true,
  }),
];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
